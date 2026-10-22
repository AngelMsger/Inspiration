from __future__ import annotations

from collections.abc import AsyncIterator, Callable
from pathlib import Path

import httpx
import pytest

from inspiration.contracts.models import (
    CompletionRequest,
    EmbedInputType,
    EmbedRequest,
    GatewayErrorCode,
    OcrRequest,
    RerankRequest,
    SensitivityLabel,
)
from inspiration.gateway import (
    Gateway,
    GatewayConfig,
    GatewayException,
    HttpModelGateway,
    Prompt,
    PromptRegistry,
    create_app,
)
from inspiration.kernel.blobs import MemoryBlobStore

ROOT = Path(__file__).resolve().parents[3]


@pytest.fixture
async def client(gateway: Gateway) -> AsyncIterator[HttpModelGateway]:
    http = HttpModelGateway("http://gateway", transport=httpx.ASGITransport(app=create_app(gateway)))
    yield http
    await http.close()


async def test_http_client_speaks_the_same_protocol(
    client: HttpModelGateway, completion_request: Callable[..., CompletionRequest]
) -> None:
    out = await client.complete(completion_request("hello over http"))
    assert out.provider == "cloud" and out.text.startswith("fake completion")
    emb = await client.embed(
        EmbedRequest(
            texts=["a", "b"], input_type=EmbedInputType.query, sensitivity=SensitivityLabel.internal, budget_key="k"
        )
    )
    assert len(emb.vectors) == 2 and emb.dimensions == 64
    rr = await client.rerank(
        RerankRequest(query="a", documents=["a", "b"], sensitivity=SensitivityLabel.public, budget_key="k")
    )
    assert len(rr.scores) == 2


async def test_http_ocr(client: HttpModelGateway, blobs: MemoryBlobStore) -> None:
    ref = await blobs.put(b"# Title\n\nBody", mime_type="image/png")
    out = await client.ocr(OcrRequest(image=ref, sensitivity=SensitivityLabel.secret, budget_key="k"))
    assert [b.text for b in out.blocks] == ["Title", "Body"]


async def test_http_errors_become_gateway_exceptions(
    make_gateway: Callable[..., Gateway], completion_request: Callable[..., CompletionRequest]
) -> None:
    app = create_app(make_gateway(include_local=False))
    client = HttpModelGateway("http://gateway", transport=httpx.ASGITransport(app=app))
    with pytest.raises(GatewayException) as exc:
        await client.complete(completion_request(sensitivity=SensitivityLabel.secret))
    assert exc.value.code == GatewayErrorCode.no_route
    assert exc.value.error.request_id is not None
    await client.close()


async def test_budget_status_and_health(gateway: Gateway, completion_request: Callable[..., CompletionRequest]) -> None:
    await gateway.complete(completion_request("word " * 200, budget_key="tenant:capped/m5"))
    transport = httpx.ASGITransport(app=create_app(gateway))
    async with httpx.AsyncClient(transport=transport, base_url="http://gateway") as http:
        status = (await http.get("/v1/budgets/tenant:capped/m5")).json()
        assert status["period"] == "month" and status["limit"] == 0.00001 and status["spent"] > 0.00001
        body = completion_request(budget_key="tenant:capped/m5").model_dump_json()
        r = await http.post("/v1/complete", content=body, headers={"content-type": "application/json"})
        assert r.status_code == 429 and r.json()["code"] == "budget_exceeded"
        health = (await http.get("/healthz")).json()
        assert health == {"ok": True, "providers": ["cloud", "local"]}
        bad = await http.post("/v1/complete", json={"task": "not dotted"})
        assert bad.status_code == 422


def test_dev_config_loads_and_routes() -> None:
    config = GatewayConfig.load(ROOT / "config" / "gateway.dev.yaml")
    gw = Gateway(config)
    assert {p.name for p in config.providers} == {"cloud", "local"}
    assert config.budget_for("tenant:ten_x/m5") is not None and config.preferred("m6.build_sop")
    assert gw.provider("local").config.max_sensitivity == SensitivityLabel.secret


def test_prompts_load_from_files(tmp_path: Path) -> None:
    (tmp_path / "m5").mkdir()
    (tmp_path / "m5" / "claims.yaml").write_text(
        "task: m5.extract_claims\nversion: claims@1\nsystem: Extract claims.\n"
        "user: |\n  Title: {{title}}\n  {{chunk}}\n",
        encoding="utf-8",
    )
    reg = PromptRegistry()
    reg.load_dir(tmp_path)
    messages = reg.render("m5.extract_claims", "claims@1", title="差旅制度", chunk={"text": "住宿 600 元"})
    assert messages[0].content == "Extract claims."
    assert messages[1].content == 'Title: 差旅制度\n{"text": "住宿 600 元"}\n'
    with pytest.raises(KeyError, match="chunk"):
        reg.render("m5.extract_claims", "claims@1", title="x")
    with pytest.raises(ValueError, match="different text"):
        reg.register(Prompt(task="m5.extract_claims", version="claims@1", user="changed"))
    assert reg.get("m5.extract_claims", "claims@1").hash.startswith("sha256:")
