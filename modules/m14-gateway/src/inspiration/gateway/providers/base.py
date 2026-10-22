"""The provider plugin interface. Only M14 calls providers; modules call the gateway."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol

from inspiration.contracts.interfaces import BlobStore
from inspiration.contracts.models import ChatMessage, DocBlock, EmbedInputType, FinishReason, TokenUsage

from ..config import ModelConfig, ProviderConfig


@dataclass
class ProviderCompletion:
    text: str
    usage: TokenUsage
    finish_reason: FinishReason = FinishReason.stop


@dataclass
class ProviderEmbedding:
    vectors: list[list[float]]
    usage: TokenUsage


@dataclass
class ProviderRerank:
    scores: list[float]
    usage: TokenUsage


@dataclass
class ProviderOcr:
    blocks: list[DocBlock]
    usage: TokenUsage
    confidence: float | None = None


@dataclass
class CompletionParams:
    task: str | None = None  # for logging and scripted fakes; not sent to providers
    max_output_tokens: int | None = None
    temperature: float | None = None
    stop: list[str] | None = None
    response_schema: dict[str, Any] | None = None  # set only when the model supports json_schema
    json_mode: bool = False  # ask for a JSON object without a schema
    timeout_s: float | None = None
    extra: dict[str, Any] = field(default_factory=dict)


class ModelProvider(Protocol):
    """Constructed once per provider entry in the config: ProviderClass(config, blobs)."""

    def __init__(self, config: ProviderConfig, blobs: BlobStore | None = None) -> None: ...

    async def complete(
        self, model: ModelConfig, messages: Sequence[ChatMessage], params: CompletionParams
    ) -> ProviderCompletion: ...

    async def embed(
        self, model: ModelConfig, texts: Sequence[str], input_type: EmbedInputType
    ) -> ProviderEmbedding: ...

    async def rerank(
        self, model: ModelConfig, query: str, documents: Sequence[str], top_n: int | None
    ) -> ProviderRerank: ...

    async def ocr(self, model: ModelConfig, image: bytes, mime_type: str, page: int | None) -> ProviderOcr: ...

    async def close(self) -> None: ...
