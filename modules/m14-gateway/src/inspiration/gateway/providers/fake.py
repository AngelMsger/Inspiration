"""Deterministic offline provider for tests, CI and demos without a model server.

complete: scripted replies per task (FakeProvider.script), otherwise a minimal JSON value
that satisfies the response schema, otherwise a fixed text derived from the prompt.
embed: hashed character n-grams, so texts that share words get similar vectors and
retrieval tests behave sensibly. rerank: n-gram overlap. ocr: the image bytes as text.
"""

from __future__ import annotations

import hashlib
import json
import math
from collections import defaultdict, deque
from collections.abc import Callable, Sequence
from typing import Any

from inspiration.contracts.interfaces import BlobStore
from inspiration.contracts.models import ChatMessage, EmbedInputType, TokenUsage

from ..config import ModelConfig, ProviderConfig
from ..structured import SCHEMA_MARKER
from .base import CompletionParams, ProviderCompletion, ProviderEmbedding, ProviderOcr, ProviderRerank
from .openai_compat import markdown_to_blocks

type Reply = str | Callable[[Sequence[ChatMessage]], str]


def estimate_tokens(text: str) -> int:
    """Rough count: CJK characters are about one token each, other text about four characters."""
    cjk = sum(1 for c in text if "一" <= c <= "鿿")
    return cjk + max((len(text) - cjk) // 4, 1 if text else 0)


def ngrams(text: str) -> list[str]:
    t = "".join(ch.lower() for ch in text if not ch.isspace())
    return [t[i : i + n] for n in (1, 2) for i in range(len(t) - n + 1)]


def minimal_instance(schema: dict[str, Any]) -> Any:
    """Smallest value that satisfies common JSON Schema shapes (const, enum, required fields)."""
    if "const" in schema:
        return schema["const"]
    if "enum" in schema:
        return schema["enum"][0]
    for key in ("oneOf", "anyOf"):
        if key in schema:
            return minimal_instance(schema[key][0])
    kind = schema.get("type")
    if isinstance(kind, list):
        kind = next((k for k in kind if k != "null"), "null")
    if kind == "object" or "properties" in schema:
        props = schema.get("properties", {})
        return {k: minimal_instance(props.get(k, {})) for k in schema.get("required", [])}
    if kind == "array":
        return [minimal_instance(schema.get("items", {})) for _ in range(schema.get("minItems", 0))]
    if kind == "string":
        return "x" * schema.get("minLength", 0)
    if kind in ("integer", "number"):
        return schema.get("minimum", 0)
    if kind == "boolean":
        return False
    return None


def _instructed_schema(messages: Sequence[ChatMessage]) -> dict[str, Any] | None:
    """The schema the gateway put in the prompt for a model without native json_schema mode."""
    for m in reversed(messages):
        _, sep, tail = m.content.partition(SCHEMA_MARKER)
        if sep:
            try:
                schema = json.loads(tail)
            except json.JSONDecodeError:
                return None
            return schema if isinstance(schema, dict) else None
    return None


class FakeProvider:
    def __init__(self, config: ProviderConfig, blobs: BlobStore | None = None) -> None:
        self.config = config
        self.blobs = blobs
        self._scripts: dict[str, deque[Reply]] = defaultdict(deque)
        self.calls: list[tuple[str, str | None]] = []  # (operation, task)

    def script(self, task: str, *replies: Reply) -> None:
        """Queue replies for a task. A reply is a string or a function of the messages."""
        self._scripts[task].extend(replies)

    async def complete(
        self, model: ModelConfig, messages: Sequence[ChatMessage], params: CompletionParams
    ) -> ProviderCompletion:
        self.calls.append(("complete", params.task))
        prompt = "\n".join(m.content for m in messages)
        queue = self._scripts.get(params.task or "")
        if queue:
            reply = queue.popleft()
            text = reply(messages) if callable(reply) else reply
        elif params.response_schema is not None or params.json_mode:
            schema = params.response_schema or _instructed_schema(messages) or {"type": "object"}
            text = json.dumps(minimal_instance(schema), ensure_ascii=False)
        else:
            text = "fake completion " + hashlib.sha256(prompt.encode()).hexdigest()[:12]
        return ProviderCompletion(
            text=text, usage=TokenUsage(input_tokens=estimate_tokens(prompt), output_tokens=estimate_tokens(text))
        )

    async def embed(self, model: ModelConfig, texts: Sequence[str], input_type: EmbedInputType) -> ProviderEmbedding:
        self.calls.append(("embed", None))
        dims = model.dimensions or 64
        vectors = []
        for text in texts:
            v = [0.0] * dims
            for g in ngrams(text):
                h = int.from_bytes(hashlib.blake2b(g.encode(), digest_size=8).digest(), "big")
                v[h % dims] += 1.0 if (h >> 32) & 1 else -1.0
            norm = math.sqrt(sum(x * x for x in v)) or 1.0
            vectors.append([x / norm for x in v])
        tokens = sum(estimate_tokens(t) for t in texts)
        return ProviderEmbedding(vectors=vectors, usage=TokenUsage(input_tokens=tokens, output_tokens=0))

    async def rerank(
        self, model: ModelConfig, query: str, documents: Sequence[str], top_n: int | None
    ) -> ProviderRerank:
        self.calls.append(("rerank", None))
        q = set(ngrams(query))
        scores = []
        for d in documents:
            g = set(ngrams(d))
            scores.append(len(q & g) / len(q | g) if q | g else 0.0)
        tokens = estimate_tokens(query) * len(documents) + sum(estimate_tokens(d) for d in documents)
        return ProviderRerank(scores=scores, usage=TokenUsage(input_tokens=tokens, output_tokens=0))

    async def ocr(self, model: ModelConfig, image: bytes, mime_type: str, page: int | None) -> ProviderOcr:
        self.calls.append(("ocr", None))
        try:
            text = image.decode("utf-8")
        except UnicodeDecodeError:
            text = "[fake OCR text]"
        return ProviderOcr(
            blocks=markdown_to_blocks(text, page),
            usage=TokenUsage(input_tokens=1000, output_tokens=estimate_tokens(text)),
            confidence=0.5,
        )

    async def close(self) -> None:
        return None
