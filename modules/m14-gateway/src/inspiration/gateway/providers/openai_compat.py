"""OpenAI-compatible HTTP provider.

Covers DeepSeek, Qwen (DashScope compatible mode), Zhipu, Moonshot, and local servers
(vLLM, SGLang, MindIE, Ollama): chat completions, embeddings, the Jina-style /rerank
endpoint that vLLM and SiliconFlow serve, and OCR through a vision model's chat endpoint.
"""

from __future__ import annotations

import asyncio
import base64
import os
import re
from collections.abc import Sequence
from typing import Any

import httpx

from inspiration.contracts.interfaces import BlobStore
from inspiration.contracts.models import (
    ChatMessage,
    DocBlock,
    DocBlockKind,
    EmbedInputType,
    FinishReason,
    TokenUsage,
)

from ..config import ModelConfig, ProviderConfig
from ..errors import ProviderError
from .base import CompletionParams, ProviderCompletion, ProviderEmbedding, ProviderOcr, ProviderRerank

FINISH = {
    "stop": FinishReason.stop,
    "length": FinishReason.length,
    "content_filter": FinishReason.content_filter,
}


class OpenAICompatibleProvider:
    def __init__(self, config: ProviderConfig, blobs: BlobStore | None = None) -> None:
        if not config.base_url:
            raise ValueError(f"provider {config.name}: base_url is required")
        self.config = config
        self.blobs = blobs
        headers = {}
        if config.api_key_env:
            key = os.environ.get(config.api_key_env)
            if not key:
                raise ValueError(f"provider {config.name}: environment variable {config.api_key_env} is not set")
            headers["Authorization"] = f"Bearer {key}"
        self.client = httpx.AsyncClient(base_url=config.base_url.rstrip("/"), headers=headers, timeout=config.timeout_s)

    async def _post(self, path: str, body: dict[str, Any], timeout_s: float | None = None) -> dict[str, Any]:
        delay = 0.5
        for attempt in range(self.config.max_retries + 1):
            try:
                r = await self.client.post(path, json=body, timeout=timeout_s or self.config.timeout_s)
            except (httpx.TimeoutException, httpx.TransportError) as e:
                if attempt == self.config.max_retries:
                    raise ProviderError(f"{self.config.name}: {type(e).__name__}: {e}", retryable=True) from e
            else:
                if r.status_code < 400:
                    data: dict[str, Any] = r.json()
                    return data
                retryable = r.status_code == 429 or r.status_code >= 500
                if not retryable or attempt == self.config.max_retries:
                    raise ProviderError(
                        f"{self.config.name}: HTTP {r.status_code}: {r.text[:500]}",
                        retryable=retryable,
                        status=r.status_code,
                    )
            await asyncio.sleep(delay)
            delay *= 2
        raise AssertionError("unreachable")

    async def _message(self, m: ChatMessage) -> dict[str, Any]:
        if not m.images:
            return {"role": m.role.value, "content": m.content}
        if self.blobs is None:
            raise ProviderError(f"{self.config.name}: image input needs a blob store", retryable=False)
        parts: list[dict[str, Any]] = [{"type": "text", "text": m.content}]
        for ref in m.images:
            data = await self.blobs.get(ref)
            url = f"data:{ref.mime_type};base64,{base64.b64encode(data).decode()}"
            parts.append({"type": "image_url", "image_url": {"url": url}})
        return {"role": m.role.value, "content": parts}

    @staticmethod
    def _usage(data: dict[str, Any]) -> TokenUsage:
        u = data.get("usage") or {}
        cached = (u.get("prompt_tokens_details") or {}).get("cached_tokens") or u.get("prompt_cache_hit_tokens") or 0
        return TokenUsage(
            input_tokens=int(u.get("prompt_tokens") or 0),
            output_tokens=int(u.get("completion_tokens") or 0),
            cached_input_tokens=int(cached),
        )

    async def complete(
        self, model: ModelConfig, messages: Sequence[ChatMessage], params: CompletionParams
    ) -> ProviderCompletion:
        body: dict[str, Any] = {"model": model.name, "messages": [await self._message(m) for m in messages]}
        if params.max_output_tokens is not None:
            body["max_tokens"] = params.max_output_tokens
        if params.temperature is not None:
            body["temperature"] = params.temperature
        if params.stop:
            body["stop"] = params.stop
        if params.response_schema is not None:
            body["response_format"] = {
                "type": "json_schema",
                "json_schema": {"name": "output", "schema": params.response_schema, "strict": True},
            }
        elif params.json_mode:
            body["response_format"] = {"type": "json_object"}
        body.update(params.extra)
        data = await self._post("/chat/completions", body, timeout_s=params.timeout_s)
        try:
            choice = data["choices"][0]
            text = choice["message"].get("content") or ""
        except (KeyError, IndexError) as e:
            raise ProviderError(f"{self.config.name}: malformed completion response", retryable=True) from e
        return ProviderCompletion(
            text=text, usage=self._usage(data), finish_reason=FINISH.get(choice.get("finish_reason"), FinishReason.stop)
        )

    async def embed(self, model: ModelConfig, texts: Sequence[str], input_type: EmbedInputType) -> ProviderEmbedding:
        inputs = list(texts)
        if input_type == EmbedInputType.query and model.query_instruction:
            inputs = [f"Instruct: {model.query_instruction}\nQuery:{t}" for t in inputs]
        body: dict[str, Any] = {"model": model.name, "input": inputs}
        if model.dimensions and self.config.options.get("send_dimensions"):
            body["dimensions"] = model.dimensions
        data = await self._post("/embeddings", body)
        rows = sorted(data.get("data") or [], key=lambda d: d.get("index", 0))
        if len(rows) != len(inputs):
            raise ProviderError(
                f"{self.config.name}: expected {len(inputs)} embeddings, got {len(rows)}", retryable=True
            )
        return ProviderEmbedding(vectors=[[float(x) for x in r["embedding"]] for r in rows], usage=self._usage(data))

    async def rerank(
        self, model: ModelConfig, query: str, documents: Sequence[str], top_n: int | None
    ) -> ProviderRerank:
        body: dict[str, Any] = {"model": model.name, "query": query, "documents": list(documents)}
        if top_n is not None:
            body["top_n"] = top_n
        data = await self._post(self.config.options.get("rerank_path", "/rerank"), body)
        scores = [0.0] * len(documents)
        for r in data.get("results") or []:
            scores[int(r["index"])] = float(r.get("relevance_score", r.get("score", 0.0)))
        usage = data.get("usage") or {}
        tokens = int(usage.get("total_tokens") or usage.get("prompt_tokens") or 0)
        return ProviderRerank(scores=scores, usage=TokenUsage(input_tokens=tokens, output_tokens=0))

    async def ocr(self, model: ModelConfig, image: bytes, mime_type: str, page: int | None) -> ProviderOcr:
        prompt = self.config.options.get("ocr_prompt", "OCR: convert this page to Markdown, keeping tables.")
        url = f"data:{mime_type};base64,{base64.b64encode(image).decode()}"
        body = {
            "model": model.name,
            "messages": [
                {
                    "role": "user",
                    "content": [{"type": "image_url", "image_url": {"url": url}}, {"type": "text", "text": prompt}],
                }
            ],
            "temperature": 0,
        }
        data = await self._post("/chat/completions", body)
        text = data["choices"][0]["message"].get("content") or ""
        return ProviderOcr(blocks=markdown_to_blocks(text, page), usage=self._usage(data))

    async def close(self) -> None:
        await self.client.aclose()


_HEADING = re.compile(r"^(#{1,6})\s+(.*)$")
_LIST = re.compile(r"^\s*([-*+]|\d+[.)])\s+(.*)$")


def markdown_to_blocks(text: str, page: int | None) -> list[DocBlock]:
    """Split OCR Markdown into normalized blocks with page-scoped anchors."""
    blocks: list[DocBlock] = []
    prefix = f"p{page}" if page else "p"
    for chunk in re.split(r"\n\s*\n", text.strip()):
        chunk = chunk.strip()
        if not chunk:
            continue
        anchor = f"{prefix}-b{len(blocks)}"
        if m := _HEADING.match(chunk):
            blocks.append(
                DocBlock(anchor=anchor, kind=DocBlockKind.heading, level=len(m.group(1)), text=m.group(2), page=page)
            )
        elif chunk.startswith("|"):
            blocks.append(DocBlock(anchor=anchor, kind=DocBlockKind.table, text=chunk, page=page))
        elif all(_LIST.match(line) for line in chunk.splitlines()):
            for i, line in enumerate(chunk.splitlines()):
                m = _LIST.match(line)
                assert m is not None
                blocks.append(DocBlock(anchor=f"{anchor}-{i}", kind=DocBlockKind.list_item, text=m.group(2), page=page))
        else:
            blocks.append(DocBlock(anchor=anchor, kind=DocBlockKind.paragraph, text=chunk, page=page))
    return blocks
