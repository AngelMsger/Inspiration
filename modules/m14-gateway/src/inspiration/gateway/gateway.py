"""The model gateway (M14): the only way any module calls a model.

For every request it: checks the budget, picks candidate models that serve the operation
and tier and are allowed to see the request's sensitivity label, tries them in order
(route preferences first, falling back on retryable errors), validates structured output
(one corrective retry), caches deterministic completions, and meters every call,
including failures.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from inspiration.contracts import new_id
from inspiration.contracts.interfaces import BlobStore
from inspiration.contracts.labels import allows
from inspiration.contracts.models import (
    ChatMessage,
    ChatRole,
    Completion,
    CompletionRequest,
    EmbedRequest,
    EmbedResult,
    FinishReason,
    GatewayErrorCode,
    GatewayOperation,
    ModelTier,
    Money,
    OcrRequest,
    OcrResult,
    RerankRequest,
    RerankResult,
    SensitivityLabel,
    TokenUsage,
    UsageRecord,
    UsageStatus,
)
from inspiration.kernel.plugins import registry

from .cache import MemoryCache, ResponseCache
from .config import GatewayConfig, ModelConfig, ProviderConfig
from .errors import GatewayException, ProviderError
from .metering import MemoryUsage, UsageSink, period_start
from .providers.base import CompletionParams, ModelProvider
from .structured import InvalidOutput, extract_json, schema_instruction, validate

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Candidate:
    provider: ProviderConfig
    model: ModelConfig

    @property
    def ref(self) -> str:
        return f"{self.provider.name}/{self.model.name}"


def _add(a: TokenUsage, b: TokenUsage) -> TokenUsage:
    return TokenUsage(
        input_tokens=a.input_tokens + b.input_tokens,
        output_tokens=a.output_tokens + b.output_tokens,
        cached_input_tokens=(a.cached_input_tokens or 0) + (b.cached_input_tokens or 0),
    )


ZERO = TokenUsage(input_tokens=0, output_tokens=0, cached_input_tokens=0)


class Gateway:
    def __init__(
        self,
        config: GatewayConfig,
        *,
        usage: UsageSink | None = None,
        cache: ResponseCache | None = None,
        blobs: BlobStore | None = None,
        providers: dict[str, ModelProvider] | None = None,
        timezone: str = "Asia/Shanghai",
    ) -> None:
        self.config = config
        self.usage: UsageSink = usage or MemoryUsage()
        self.cache = (
            cache
            if cache is not None
            else (MemoryCache(config.cache.max_entries) if config.cache.backend != "none" else None)
        )
        self.blobs = blobs
        self.timezone = timezone
        self.providers: dict[str, ModelProvider] = dict(providers or {})
        for p in config.providers:
            if p.name not in self.providers:
                cls = registry("model_providers").get(p.kind)
                self.providers[p.name] = cls(p, blobs)

    def provider(self, name: str) -> Any:
        """The provider instance, for tests (FakeProvider.script) and diagnostics."""
        return self.providers[name]

    async def close(self) -> None:
        for p in self.providers.values():
            await p.close()

    # ------------------------------------------------------------ routing

    def candidates(
        self, operation: GatewayOperation, sensitivity: SensitivityLabel, *, tier: ModelTier | None, task: str | None
    ) -> list[Candidate]:
        out = []
        for p in self.config.providers:
            if not allows(p.max_sensitivity, sensitivity):
                continue
            for m in p.models:
                if operation not in m.operations:
                    continue
                if operation == GatewayOperation.complete and tier is not None and m.tiers and tier not in m.tiers:
                    continue
                out.append(Candidate(p, m))
        preferred = self.config.preferred(task)
        rank = {ref: i for i, ref in enumerate(preferred)}
        out.sort(key=lambda c: rank.get(c.ref, len(rank)))
        return out

    # ------------------------------------------------------------ metering

    def _money(self, amount: float) -> Money:
        return Money(amount=round(amount, 8), currency=self.config.currency)

    async def _check_budget(self, budget_key: str) -> None:
        budget = self.config.budget_for(budget_key)
        if budget is None or budget.limit is None:
            return
        since = period_start(budget.period, datetime.now(UTC), self.timezone)
        spent = await self.usage.spent(budget_key, since)
        if spent >= budget.limit:
            raise GatewayException(
                GatewayErrorCode.budget_exceeded,
                f"budget {budget_key} spent {spent:.4f} of {budget.limit} {self.config.currency}"
                f" this {budget.period.value}",
            )

    async def _record(
        self,
        *,
        request_id: str,
        operation: GatewayOperation,
        budget_key: str,
        sensitivity: SensitivityLabel,
        status: UsageStatus,
        started: float,
        usage: TokenUsage = ZERO,
        cost: float = 0.0,
        candidate: Candidate | None = None,
        task: str | None = None,
        prompt_version: str | None = None,
        tenant_id: str | None = None,
        error: str | None = None,
    ) -> int:
        latency_ms = int((time.monotonic() - started) * 1000)
        try:
            await self.usage.record(
                UsageRecord(
                    request_id=request_id,
                    at=datetime.now(UTC),
                    tenant_id=tenant_id,
                    operation=operation,
                    task=task,
                    prompt_version=prompt_version,
                    budget_key=budget_key,
                    sensitivity=sensitivity,
                    provider=candidate.provider.name if candidate else None,
                    model=candidate.model.name if candidate else None,
                    status=status,
                    usage=usage,
                    cost=self._money(cost),
                    latency_ms=latency_ms,
                    error=error,
                )
            )
        except Exception:  # metering must never hide the result of the call itself
            log.exception("failed to record usage for %s", request_id)
        return latency_ms

    async def _guarded[T](
        self,
        operation: GatewayOperation,
        req: Any,
        run: Any,
        *,
        tier: ModelTier | None = None,
        task: str | None = None,
        prompt_version: str | None = None,
    ) -> T:
        """Budget check, routing, fallback and metering shared by every operation.

        run(candidate, request_id) returns (result, usage, status); it may raise
        ProviderError (retryable ones fall back to the next candidate) or GatewayException.
        """
        request_id = new_id("request")
        started = time.monotonic()
        common = dict(
            request_id=request_id,
            operation=operation,
            budget_key=req.budget_key,
            sensitivity=req.sensitivity,
            started=started,
            task=task,
            prompt_version=prompt_version,
            tenant_id=req.tenant_id,
        )
        try:
            await self._check_budget(req.budget_key)
        except GatewayException as e:
            await self._record(**common, status=UsageStatus.budget_exceeded, error=e.error.message)
            e.error.request_id = request_id
            raise
        cands = self.candidates(operation, req.sensitivity, tier=tier, task=task)
        if not cands:
            msg = f"no {operation.value} model allowed for sensitivity {req.sensitivity.value}" + (
                f" and tier {tier.value}" if tier else ""
            )
            await self._record(**common, status=UsageStatus.no_route, error=msg)
            raise GatewayException(GatewayErrorCode.no_route, msg, request_id=request_id)
        last_error: Exception | None = None
        for cand in cands:
            try:
                result, usage, status = await run(cand, request_id)
            except ProviderError as e:
                last_error = e
                log.warning("%s via %s failed: %s", operation.value, cand.ref, e)
                if e.retryable:
                    continue
                await self._record(**common, candidate=cand, status=UsageStatus.error, error=str(e))
                code = GatewayErrorCode.bad_request if e.status == 400 else GatewayErrorCode.provider_error
                raise GatewayException(code, str(e), request_id=request_id) from e
            except GatewayException as e:
                usage_so_far = getattr(e, "usage", ZERO)
                await self._record(
                    **common,
                    candidate=cand,
                    usage=usage_so_far,
                    cost=cand.model.price.cost(usage_so_far.input_tokens, usage_so_far.output_tokens),
                    status=UsageStatus.invalid_output
                    if e.code == GatewayErrorCode.invalid_output
                    else UsageStatus.error,
                    error=e.error.message,
                )
                e.error.request_id = request_id
                raise
            cost = cand.model.price.cost(usage.input_tokens, usage.output_tokens, usage.cached_input_tokens or 0)
            latency = await self._record(**common, candidate=cand, usage=usage, cost=cost, status=status)
            finished: T = result.finish(
                request_id=request_id, candidate=cand, usage=usage, cost=self._money(cost), latency_ms=latency
            )
            return finished
        await self._record(**common, status=UsageStatus.error, error=str(last_error))
        raise GatewayException(
            GatewayErrorCode.provider_error,
            f"all {len(cands)} candidates failed; last: {last_error}",
            request_id=request_id,
        )

    # ------------------------------------------------------------ complete

    def _cache_key(self, cand: Candidate, req: CompletionRequest) -> str | None:
        if self.cache is None or not req.use_cache or (req.temperature not in (None, 0)):
            return None
        material = json.dumps(
            [
                cand.ref,
                req.task,
                req.prompt_version,
                [m.model_dump(mode="json", exclude_none=True) for m in req.messages],
                req.response_schema,
                req.max_output_tokens,
                req.stop,
            ],
            ensure_ascii=False,
            sort_keys=True,
        )
        return hashlib.sha256(material.encode()).hexdigest()

    async def complete(self, req: CompletionRequest) -> Completion:
        tier = req.tier or ModelTier.flash

        async def run(cand: Candidate, request_id: str) -> tuple[_Pending, TokenUsage, UsageStatus]:
            key = self._cache_key(cand, req)
            if key is not None and self.cache is not None and (hit := await self.cache.get(key)) is not None:
                data = json.loads(hit)
                return _Pending(Completion, data | {"cached": True}), ZERO, UsageStatus.cached

            messages = list(req.messages)
            params = CompletionParams(
                task=req.task,
                max_output_tokens=req.max_output_tokens or cand.model.max_output_tokens,
                temperature=req.temperature,
                stop=req.stop,
                timeout_s=req.timeout_s,
            )
            if req.response_schema is not None:
                if cand.model.json_schema:
                    params.response_schema = req.response_schema
                else:
                    params.json_mode = True
                    messages.append(ChatMessage(role=ChatRole.system, content=schema_instruction(req.response_schema)))

            provider = self.providers[cand.provider.name]
            usage = ZERO
            parsed: Any = None
            for attempt in range(2):
                try:
                    async with asyncio.timeout(req.timeout_s):
                        out = await provider.complete(cand.model, messages, params)
                except TimeoutError as e:
                    raise ProviderError(f"timed out after {req.timeout_s}s", retryable=True) from e
                usage = _add(usage, out.usage)
                if req.response_schema is None:
                    break
                try:
                    parsed = extract_json(out.text)
                    validate(req.response_schema, parsed)
                    break
                except InvalidOutput as e:
                    if attempt == 1:
                        exc = GatewayException(GatewayErrorCode.invalid_output, str(e))
                        exc.usage = usage  # type: ignore[attr-defined]
                        raise exc from e
                    messages = [
                        *messages,
                        ChatMessage(role=ChatRole.assistant, content=out.text),
                        ChatMessage(
                            role=ChatRole.user,
                            content=f"That output is invalid: {e}. Reply again with corrected JSON only.",
                        ),
                    ]
            data = {"text": out.text, "json": parsed, "finish_reason": out.finish_reason.value, "cached": False}
            if key is not None and self.cache is not None and out.finish_reason == FinishReason.stop:
                await self.cache.set(
                    key,
                    json.dumps(data | {"provider": cand.provider.name, "model": cand.model.name}, ensure_ascii=False),
                    self.config.cache.ttl_s,
                )
            return _Pending(Completion, data), usage, UsageStatus.ok

        return await self._guarded(
            GatewayOperation.complete, req, run, tier=tier, task=req.task, prompt_version=req.prompt_version
        )

    # ------------------------------------------------------------ embed, rerank, ocr

    async def embed(self, req: EmbedRequest) -> EmbedResult:
        async def run(cand: Candidate, request_id: str) -> tuple[_Pending, TokenUsage, UsageStatus]:
            out = await self.providers[cand.provider.name].embed(cand.model, req.texts, req.input_type)
            dims = len(out.vectors[0]) if out.vectors else (cand.model.dimensions or 0)
            return _Pending(EmbedResult, {"vectors": out.vectors, "dimensions": dims}), out.usage, UsageStatus.ok

        return await self._guarded(GatewayOperation.embed, req, run)

    async def rerank(self, req: RerankRequest) -> RerankResult:
        async def run(cand: Candidate, request_id: str) -> tuple[_Pending, TokenUsage, UsageStatus]:
            out = await self.providers[cand.provider.name].rerank(cand.model, req.query, req.documents, req.top_n)
            return _Pending(RerankResult, {"scores": out.scores}), out.usage, UsageStatus.ok

        return await self._guarded(GatewayOperation.rerank, req, run)

    async def ocr(self, req: OcrRequest) -> OcrResult:
        if self.blobs is None:
            raise GatewayException(GatewayErrorCode.bad_request, "OCR needs a blob store")
        image = await self.blobs.get(req.image)

        async def run(cand: Candidate, request_id: str) -> tuple[_Pending, TokenUsage, UsageStatus]:
            out = await self.providers[cand.provider.name].ocr(cand.model, image, req.image.mime_type, req.page)
            return _Pending(OcrResult, {"blocks": out.blocks, "confidence": out.confidence}), out.usage, UsageStatus.ok

        return await self._guarded(GatewayOperation.ocr, req, run)


@dataclass
class _Pending:
    """A result missing the fields only the gateway knows (request id, provider, cost)."""

    model: type[Any]
    fields: dict[str, Any]

    def finish(self, *, request_id: str, candidate: Candidate, usage: TokenUsage, cost: Money, latency_ms: int) -> Any:
        values = {
            "request_id": request_id,
            "provider": self.fields.pop("provider", None) or candidate.provider.name,
            "model": self.fields.pop("model", None) or candidate.model.name,
            "usage": usage,
            "cost": cost,
            **self.fields,
        }
        if "latency_ms" in self.model.model_fields:
            values["latency_ms"] = latency_ms
        return self.model.model_validate(values)
