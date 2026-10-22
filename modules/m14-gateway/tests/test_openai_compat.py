from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

import httpx
import pytest

from inspiration.contracts.models import ChatMessage, ChatRole, EmbedInputType, FinishReason
from inspiration.gateway import ProviderError
from inspiration.gateway.config import ModelConfig, ProviderConfig
from inspiration.gateway.providers import openai_compat
from inspiration.gateway.providers.base import CompletionParams
from inspiration.gateway.providers.openai_compat import OpenAICompatibleProvider
from inspiration.kernel.blobs import MemoryBlobStore

type Handler = Callable[[httpx.Request], httpx.Response]

CHAT = ModelConfig(name="deepseek-chat", operations=["complete"], json_schema=True)
EMBED = ModelConfig(
    name="qwen3-embedding", operations=["embed"], dimensions=3, query_instruction="Find policy passages"
)
RERANK = ModelConfig(name="qwen3-reranker", operations=["rerank"])
MESSAGES = [ChatMessage(role=ChatRole.system, content="Be brief."), ChatMessage(role=ChatRole.user, content="Hi")]


@pytest.fixture(autouse=True)
def no_backoff(monkeypatch: pytest.MonkeyPatch) -> None:
    async def sleep(_: float) -> None:
        return None

    monkeypatch.setattr(openai_compat.asyncio, "sleep", sleep)


def provider(handler: Handler, monkeypatch: pytest.MonkeyPatch, **config: Any) -> OpenAICompatibleProvider:
    monkeypatch.setenv("TEST_LLM_KEY", "sk-test")
    cfg = ProviderConfig(
        name="test",
        kind="openai_compatible",
        max_sensitivity="internal",
        base_url="https://llm.example/v1",
        api_key_env="TEST_LLM_KEY",
        models=[CHAT, EMBED, RERANK],
        **config,
    )
    p = OpenAICompatibleProvider(cfg, MemoryBlobStore())
    p.client = httpx.AsyncClient(
        base_url="https://llm.example/v1", headers=p.client.headers, transport=httpx.MockTransport(handler)
    )
    return p


def chat_response(text: str, **usage: int) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "choices": [{"message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 3, **usage},
        },
    )


async def test_complete_sends_schema_and_reads_usage(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return chat_response('{"ok": true}', prompt_cache_hit_tokens=4)

    p = provider(handler, monkeypatch)
    schema = {"type": "object"}
    out = await p.complete(
        CHAT, MESSAGES, CompletionParams(response_schema=schema, temperature=0, max_output_tokens=64)
    )
    body = json.loads(seen[0].content)
    assert seen[0].url.path == "/v1/chat/completions"
    assert seen[0].headers["authorization"] == "Bearer sk-test"
    assert body["model"] == "deepseek-chat" and body["max_tokens"] == 64 and body["temperature"] == 0
    assert body["response_format"]["json_schema"]["schema"] == schema
    assert body["messages"] == [{"role": "system", "content": "Be brief."}, {"role": "user", "content": "Hi"}]
    assert out.text == '{"ok": true}' and out.finish_reason == FinishReason.stop
    assert (out.usage.input_tokens, out.usage.output_tokens, out.usage.cached_input_tokens) == (10, 3, 4)


async def test_json_mode_without_schema(monkeypatch: pytest.MonkeyPatch) -> None:
    bodies: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.content))
        return chat_response("{}")

    await provider(handler, monkeypatch).complete(CHAT, MESSAGES, CompletionParams(json_mode=True))
    assert bodies[0]["response_format"] == {"type": "json_object"}


async def test_images_are_sent_as_data_urls(monkeypatch: pytest.MonkeyPatch) -> None:
    bodies: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.content))
        return chat_response("a chart")

    p = provider(handler, monkeypatch)
    assert p.blobs is not None
    ref = await p.blobs.put(b"\x89PNG", mime_type="image/png")
    await p.complete(CHAT, [ChatMessage(role=ChatRole.user, content="What is this?", images=[ref])], CompletionParams())
    parts = bodies[0]["messages"][0]["content"]
    assert parts[0] == {"type": "text", "text": "What is this?"}
    assert parts[1]["image_url"]["url"].startswith("data:image/png;base64,")


async def test_server_errors_are_retried_then_succeed(monkeypatch: pytest.MonkeyPatch) -> None:
    statuses = iter([503, 429, 200])

    def handler(request: httpx.Request) -> httpx.Response:
        status = next(statuses)
        return chat_response("ok") if status == 200 else httpx.Response(status, text="busy")

    out = await provider(handler, monkeypatch, max_retries=2).complete(CHAT, MESSAGES, CompletionParams())
    assert out.text == "ok"


async def test_client_errors_are_not_retried(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(400, text="bad schema")

    with pytest.raises(ProviderError) as exc:
        await provider(handler, monkeypatch).complete(CHAT, MESSAGES, CompletionParams())
    assert calls == 1 and exc.value.status == 400 and not exc.value.retryable


async def test_retries_run_out(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    with pytest.raises(ProviderError) as exc:
        await provider(handler, monkeypatch, max_retries=1).complete(CHAT, MESSAGES, CompletionParams())
    assert exc.value.retryable


async def test_embed_orders_rows_and_prefixes_queries(monkeypatch: pytest.MonkeyPatch) -> None:
    bodies: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.content))
        rows = [{"index": 1, "embedding": [0, 1, 0]}, {"index": 0, "embedding": [1, 0, 0]}]
        return httpx.Response(200, json={"data": rows, "usage": {"prompt_tokens": 7}})

    p = provider(handler, monkeypatch)
    out = await p.embed(EMBED, ["酒店上限", "hotel cap"], EmbedInputType.query)
    assert out.vectors == [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]]
    assert bodies[0]["input"][0] == "Instruct: Find policy passages\nQuery:酒店上限"
    await p.embed(EMBED, ["a", "b"], EmbedInputType.document)
    assert bodies[1]["input"] == ["a", "b"] and "dimensions" not in bodies[1]


async def test_embed_count_mismatch_is_retryable(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": [{"index": 0, "embedding": [1]}]})

    with pytest.raises(ProviderError) as exc:
        await provider(handler, monkeypatch).embed(EMBED, ["a", "b"], EmbedInputType.document)
    assert exc.value.retryable


async def test_rerank_maps_results_back_to_input_order(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/rerank"
        results = [{"index": 2, "relevance_score": 0.9}, {"index": 0, "relevance_score": 0.1}]
        return httpx.Response(200, json={"results": results, "usage": {"total_tokens": 12}})

    out = await provider(handler, monkeypatch).rerank(RERANK, "q", ["a", "b", "c"], top_n=2)
    assert out.scores == [0.1, 0.0, 0.9] and out.usage.input_tokens == 12


def test_a_missing_api_key_fails_at_startup(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("NO_SUCH_KEY", raising=False)
    cfg = ProviderConfig(
        name="x",
        kind="openai_compatible",
        max_sensitivity="public",
        base_url="http://x",
        api_key_env="NO_SUCH_KEY",
        models=[CHAT],
    )
    with pytest.raises(ValueError, match="NO_SUCH_KEY"):
        OpenAICompatibleProvider(cfg)
