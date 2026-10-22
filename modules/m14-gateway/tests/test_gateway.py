from __future__ import annotations

import asyncio
import math
from collections.abc import Callable, Sequence
from typing import Any

import pytest

from inspiration.contracts.models import (
    ChatMessage,
    ChatRole,
    CompletionRequest,
    DocBlockKind,
    EmbedInputType,
    EmbedRequest,
    GatewayErrorCode,
    GatewayOperation,
    ModelTier,
    OcrRequest,
    RerankRequest,
    SensitivityLabel,
    UsageStatus,
)
from inspiration.gateway import Gateway, GatewayException, MemoryUsage, ProviderError
from inspiration.gateway.config import ModelConfig, ProviderConfig
from inspiration.gateway.providers.base import CompletionParams, ProviderCompletion
from inspiration.gateway.providers.fake import FakeProvider, minimal_instance
from inspiration.kernel.blobs import MemoryBlobStore

type MakeRequest = Callable[..., CompletionRequest]
type MakeGateway = Callable[..., Gateway]


class FailingProvider(FakeProvider):
    def __init__(self, config: ProviderConfig, *, retryable: bool, status: int | None = None) -> None:
        super().__init__(config)
        self.retryable = retryable
        self.status = status

    async def complete(
        self, model: ModelConfig, messages: Sequence[ChatMessage], params: CompletionParams
    ) -> ProviderCompletion:
        self.calls.append(("complete", params.task))
        raise ProviderError("boom", retryable=self.retryable, status=self.status)


class SlowProvider(FakeProvider):
    async def complete(
        self, model: ModelConfig, messages: Sequence[ChatMessage], params: CompletionParams
    ) -> ProviderCompletion:
        self.calls.append(("complete", params.task))
        await asyncio.sleep(1)
        return await super().complete(model, messages, params)


def usage_of(gw: Gateway) -> MemoryUsage:
    assert isinstance(gw.usage, MemoryUsage)
    return gw.usage


def cloud_config(gw: Gateway) -> ProviderConfig:
    return next(p for p in gw.config.providers if p.name == "cloud")


# ------------------------------------------------------------------ routing


async def test_internal_content_may_use_the_cloud_model(gateway: Gateway, completion_request: MakeRequest) -> None:
    out = await gateway.complete(completion_request())
    assert (out.provider, out.model) == ("cloud", "cloud-flash")
    assert out.request_id.startswith("req_")
    assert out.cost.amount > 0 and out.cost.currency == "CNY"
    [rec] = usage_of(gateway).records
    assert rec.status == UsageStatus.ok and rec.provider == "cloud" and rec.task == "m5.extract_claims"


@pytest.mark.parametrize("label", [SensitivityLabel.confidential, SensitivityLabel.secret])
async def test_sensitive_content_never_leaves_the_local_provider(
    gateway: Gateway, completion_request: MakeRequest, label: SensitivityLabel
) -> None:
    out = await gateway.complete(completion_request(sensitivity=label))
    assert out.provider == "local"
    assert gateway.provider("cloud").calls == []


def test_candidates_respect_tier_and_route_preferences(gateway: Gateway) -> None:
    refs = [
        c.ref
        for c in gateway.candidates(
            GatewayOperation.complete, SensitivityLabel.internal, tier=ModelTier.flash, task="m5.extract_claims"
        )
    ]
    assert refs == ["cloud/cloud-flash", "local/local-chat"]
    preferred = gateway.candidates(
        GatewayOperation.complete, SensitivityLabel.internal, tier=ModelTier.flash, task="m6.build_sop"
    )
    assert [c.ref for c in preferred] == ["local/local-chat", "cloud/cloud-flash"]
    flagship = gateway.candidates(
        GatewayOperation.complete, SensitivityLabel.public, tier=ModelTier.flagship, task=None
    )
    assert [c.ref for c in flagship] == ["local/local-chat"]


async def test_no_route_is_an_error_and_is_metered(make_gateway: MakeGateway, completion_request: MakeRequest) -> None:
    gw = make_gateway(include_local=False)
    with pytest.raises(GatewayException) as exc:
        await gw.complete(completion_request(sensitivity=SensitivityLabel.confidential))
    assert exc.value.code == GatewayErrorCode.no_route
    assert exc.value.error.request_id is not None
    [rec] = usage_of(gw).records
    assert rec.status == UsageStatus.no_route and rec.provider is None


async def test_retryable_provider_errors_fall_back_to_the_next_candidate(
    make_gateway: MakeGateway, completion_request: MakeRequest
) -> None:
    probe = make_gateway()
    gw = make_gateway(providers={"cloud": FailingProvider(cloud_config(probe), retryable=True)})
    out = await gw.complete(completion_request())
    assert out.provider == "local"
    assert gw.provider("cloud").calls == [("complete", "m5.extract_claims")]


async def test_non_retryable_provider_errors_do_not_fall_back(
    make_gateway: MakeGateway, completion_request: MakeRequest
) -> None:
    probe = make_gateway()
    gw = make_gateway(providers={"cloud": FailingProvider(cloud_config(probe), retryable=False, status=400)})
    with pytest.raises(GatewayException) as exc:
        await gw.complete(completion_request())
    assert exc.value.code == GatewayErrorCode.bad_request
    assert gw.provider("local").calls == []
    assert usage_of(gw).records[-1].status == UsageStatus.error


async def test_all_candidates_failing_is_a_provider_error(
    make_gateway: MakeGateway, completion_request: MakeRequest
) -> None:
    gw = make_gateway(include_local=False)
    gw = make_gateway(include_local=False, providers={"cloud": FailingProvider(cloud_config(gw), retryable=True)})
    with pytest.raises(GatewayException) as exc:
        await gw.complete(completion_request())
    assert exc.value.code == GatewayErrorCode.provider_error
    assert exc.value.error.retryable is True


async def test_a_slow_provider_times_out_and_falls_back(
    make_gateway: MakeGateway, completion_request: MakeRequest
) -> None:
    probe = make_gateway()
    gw = make_gateway(providers={"cloud": SlowProvider(cloud_config(probe))})
    out = await gw.complete(completion_request(timeout_s=0.05))
    assert out.provider == "local"


# ------------------------------------------------------------------ budgets and cache


async def test_budget_is_enforced_from_metered_cost(gateway: Gateway, completion_request: MakeRequest) -> None:
    long_text = "word " * 200  # about 250 tokens: more than the 0.00001 CNY cap at 1 CNY per million
    first = await gateway.complete(completion_request(long_text, budget_key="tenant:capped/m5"))
    assert first.cost.amount > 0.00001
    with pytest.raises(GatewayException) as exc:
        await gateway.complete(completion_request("again", budget_key="tenant:capped/m5"))
    assert exc.value.code == GatewayErrorCode.budget_exceeded
    assert usage_of(gateway).records[-1].status == UsageStatus.budget_exceeded
    # Other budget keys are unaffected.
    await gateway.complete(completion_request("again", budget_key="tenant:other/m5"))


async def test_deterministic_completions_are_cached(gateway: Gateway, completion_request: MakeRequest) -> None:
    first = await gateway.complete(completion_request("same prompt"))
    second = await gateway.complete(completion_request("same prompt"))
    assert not first.cached and second.cached
    assert second.text == first.text and second.request_id != first.request_id
    assert second.cost.amount == 0
    assert len(gateway.provider("cloud").calls) == 1
    assert [r.status for r in usage_of(gateway).records] == [UsageStatus.ok, UsageStatus.cached]


async def test_sampled_completions_are_not_cached(gateway: Gateway, completion_request: MakeRequest) -> None:
    await gateway.complete(completion_request("same prompt", temperature=0.7))
    await gateway.complete(completion_request("same prompt", temperature=0.7))
    assert len(gateway.provider("cloud").calls) == 2


# ------------------------------------------------------------------ structured output

SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["claims"],
    "properties": {"claims": {"type": "array", "items": {"type": "string"}}},
}


async def test_structured_output_is_parsed_and_validated(gateway: Gateway, completion_request: MakeRequest) -> None:
    seen: list[Sequence[ChatMessage]] = []

    def reply(messages: Sequence[ChatMessage]) -> str:
        seen.append(messages)
        return 'Sure:\n```json\n{"claims": ["Hotel cap is 600 CNY"]}\n```'

    gateway.provider("cloud").script("m5.extract_claims", reply)
    out = await gateway.complete(completion_request(response_schema=SCHEMA))
    assert out.json_ == {"claims": ["Hotel cap is 600 CNY"]}
    # cloud-flash has no native json_schema mode, so the gateway adds the schema as an instruction.
    assert seen[0][-1].role == ChatRole.system and "JSON Schema" in seen[0][-1].content


async def test_invalid_structured_output_gets_one_corrective_retry(
    gateway: Gateway, completion_request: MakeRequest
) -> None:
    fake = gateway.provider("cloud")
    fake.script("m5.extract_claims", '{"claims": "not a list"}', '{"claims": ["fixed"]}')
    out = await gateway.complete(completion_request(response_schema=SCHEMA))
    assert out.json_ == {"claims": ["fixed"]}
    assert len(fake.calls) == 2
    [rec] = usage_of(gateway).records
    assert rec.usage.input_tokens == out.usage.input_tokens > 0  # both attempts are charged


async def test_structured_output_invalid_twice_fails(gateway: Gateway, completion_request: MakeRequest) -> None:
    gateway.provider("cloud").script("m5.extract_claims", "no json here", "[1, 2]")
    with pytest.raises(GatewayException) as exc:
        await gateway.complete(completion_request(response_schema=SCHEMA))
    assert exc.value.code == GatewayErrorCode.invalid_output
    [rec] = usage_of(gateway).records
    assert rec.status == UsageStatus.invalid_output and rec.usage.input_tokens > 0 and rec.cost.amount > 0


async def test_fake_provider_satisfies_schemas_without_a_script(
    gateway: Gateway, completion_request: MakeRequest
) -> None:
    out = await gateway.complete(completion_request(response_schema=SCHEMA, sensitivity=SensitivityLabel.secret))
    assert out.provider == "local" and out.json_ == {"claims": []}


def test_minimal_instance_covers_common_shapes() -> None:
    schema = {
        "type": "object",
        "required": ["a", "b", "c", "d"],
        "properties": {
            "a": {"const": "x"},
            "b": {"enum": ["p", "q"]},
            "c": {"type": "array", "minItems": 1, "items": {"type": "integer", "minimum": 3}},
            "d": {"type": ["null", "string"], "minLength": 2},
        },
    }
    assert minimal_instance(schema) == {"a": "x", "b": "p", "c": [3], "d": "xx"}


# ------------------------------------------------------------------ embed, rerank, ocr


def cosine(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b, strict=True))


async def test_embed_routes_by_sensitivity_and_returns_unit_vectors(gateway: Gateway) -> None:
    texts = ["出差住宿标准每晚600元", "住宿标准 每晚 600 元 出差", "季度营收报告"]
    out = await gateway.embed(
        EmbedRequest(
            texts=texts, input_type=EmbedInputType.document, sensitivity=SensitivityLabel.internal, budget_key="k"
        )
    )
    assert (out.provider, out.model, out.dimensions) == ("cloud", "cloud-embed", 64)
    assert all(math.isclose(cosine(v, v), 1.0, rel_tol=1e-6) for v in out.vectors)
    assert cosine(out.vectors[0], out.vectors[1]) > cosine(out.vectors[0], out.vectors[2])
    secret = await gateway.embed(
        EmbedRequest(texts=["x"], input_type=EmbedInputType.query, sensitivity=SensitivityLabel.secret, budget_key="k")
    )
    assert secret.provider == "local"


async def test_rerank_scores_follow_input_order(gateway: Gateway) -> None:
    docs = ["quarterly revenue", "hotel cap for travel", "travel hotel cap per night"]
    out = await gateway.rerank(
        RerankRequest(
            query="travel hotel cap", documents=docs, sensitivity=SensitivityLabel.confidential, budget_key="k"
        )
    )
    assert out.provider == "local" and len(out.scores) == 3
    assert out.scores[0] < out.scores[1] and out.scores[0] < out.scores[2]
    assert usage_of(gateway).records[-1].operation == GatewayOperation.rerank


async def test_ocr_reads_the_image_from_the_blob_store(gateway: Gateway, blobs: MemoryBlobStore) -> None:
    page = "# 差旅制度\n\n住宿标准每晚 600 元。\n\n| 城市 | 上限 |\n|---|---|\n| 北京 | 600 |\n\n- 一线城市\n- 其他城市"
    ref = await blobs.put(page.encode(), mime_type="image/png")
    out = await gateway.ocr(OcrRequest(image=ref, page=3, sensitivity=SensitivityLabel.secret, budget_key="k"))
    assert out.provider == "local" and out.model == "local-ocr"
    kinds = [b.kind for b in out.blocks]
    assert kinds == [
        DocBlockKind.heading,
        DocBlockKind.paragraph,
        DocBlockKind.table,
        DocBlockKind.list_item,
        DocBlockKind.list_item,
    ]
    assert all(b.page == 3 and b.anchor.startswith("p3-") for b in out.blocks)
    assert len({b.anchor for b in out.blocks}) == len(out.blocks)


async def test_ocr_without_a_blob_store_is_a_bad_request(blobs: MemoryBlobStore) -> None:
    from inspiration.gateway import GatewayConfig

    gw = Gateway(GatewayConfig.model_validate({"providers": []}))
    ref = await blobs.put(b"x", mime_type="image/png")
    with pytest.raises(GatewayException) as exc:
        await gw.ocr(OcrRequest(image=ref, sensitivity=SensitivityLabel.internal, budget_key="k"))
    assert exc.value.code == GatewayErrorCode.bad_request


async def test_metering_failure_does_not_hide_the_result(
    make_gateway: MakeGateway, completion_request: MakeRequest
) -> None:
    class BrokenUsage(MemoryUsage):
        async def record(self, rec: Any) -> None:
            raise RuntimeError("database down")

    gw = make_gateway(usage=BrokenUsage())
    out = await gw.complete(completion_request())
    assert out.text


def test_cache_key_changes_with_everything_that_changes_the_answer(
    gateway: Gateway, completion_request: MakeRequest
) -> None:
    cand = gateway.candidates(GatewayOperation.complete, SensitivityLabel.internal, tier=ModelTier.flash, task=None)[0]
    base = gateway._cache_key(cand, completion_request("a"))
    assert base is not None
    assert gateway._cache_key(cand, completion_request("b")) != base
    assert gateway._cache_key(cand, completion_request("a", prompt_version="claims@2")) != base
    assert gateway._cache_key(cand, completion_request("a", response_schema=SCHEMA)) != base
    assert gateway._cache_key(cand, completion_request("a", use_cache=False)) is None
