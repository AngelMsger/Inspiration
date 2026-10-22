"""HTTP service and client for the gateway, so modules in other processes use the same
ModelGateway protocol. Modules depend on the protocol; deployment decides whether the
gateway runs in process or behind HTTP.

Routes: POST /v1/complete, /v1/embed, /v1/rerank, /v1/ocr; GET /v1/budgets/{key}; GET /healthz.
Errors return the contract GatewayError as JSON.

Usage: inspiration-gateway --config gateway.yaml [--host 0.0.0.0] [--port 8100]
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from inspiration.contracts.models import (
    BudgetStatus,
    Completion,
    CompletionRequest,
    EmbedRequest,
    EmbedResult,
    GatewayError,
    GatewayErrorCode,
    OcrRequest,
    OcrResult,
    RerankRequest,
    RerankResult,
)

from .config import GatewayConfig
from .errors import GatewayException
from .gateway import Gateway
from .metering import period_start

STATUS = {
    GatewayErrorCode.budget_exceeded: 429,
    GatewayErrorCode.no_route: 422,
    GatewayErrorCode.bad_request: 400,
    GatewayErrorCode.invalid_output: 502,
    GatewayErrorCode.provider_error: 502,
    GatewayErrorCode.timeout: 504,
}


def create_app(gateway: Gateway) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        yield
        await gateway.close()

    app = FastAPI(title="Inspiration model gateway", version="0.1.0", lifespan=lifespan)

    @app.exception_handler(GatewayException)
    async def gateway_error(request: Request, exc: GatewayException) -> JSONResponse:
        return JSONResponse(exc.error.model_dump(mode="json", exclude_none=True), status_code=STATUS[exc.code])

    @app.get("/healthz")
    async def healthz() -> dict[str, Any]:
        return {"ok": True, "providers": [p.name for p in gateway.config.providers]}

    @app.post("/v1/complete")
    async def complete(req: CompletionRequest) -> Completion:
        return await gateway.complete(req)

    @app.post("/v1/embed")
    async def embed(req: EmbedRequest) -> EmbedResult:
        return await gateway.embed(req)

    @app.post("/v1/rerank")
    async def rerank(req: RerankRequest) -> RerankResult:
        return await gateway.rerank(req)

    @app.post("/v1/ocr")
    async def ocr(req: OcrRequest) -> OcrResult:
        return await gateway.ocr(req)

    @app.get("/v1/budgets/{budget_key:path}")
    async def budget(budget_key: str) -> BudgetStatus:
        cfg = gateway.config.budget_for(budget_key)
        period = cfg.period if cfg else None
        since = period_start(period, datetime.now(UTC), gateway.timezone) if period else None
        spent = await gateway.usage.spent(budget_key, since)
        return BudgetStatus(
            budget_key=budget_key,
            period=period or "total",
            limit=cfg.limit if cfg else None,
            spent=spent,
            currency=gateway.config.currency,
        )

    return app


class HttpModelGateway:
    """ModelGateway over HTTP. Raises GatewayException exactly like the in-process gateway."""

    def __init__(
        self, base_url: str, *, timeout_s: float = 120.0, transport: httpx.AsyncBaseTransport | None = None
    ) -> None:
        self.client = httpx.AsyncClient(base_url=base_url.rstrip("/"), timeout=timeout_s, transport=transport)

    async def _post(self, path: str, body: Any, model: type[Any]) -> Any:
        r = await self.client.post(
            path, content=body.model_dump_json(exclude_none=True), headers={"content-type": "application/json"}
        )
        if r.status_code >= 400:
            try:
                err = GatewayError.model_validate(r.json())
            except Exception:
                raise GatewayException(
                    GatewayErrorCode.provider_error, f"gateway HTTP {r.status_code}: {r.text[:300]}"
                ) from None
            raise GatewayException(err.code, err.message, request_id=err.request_id)
        return model.model_validate(r.json())

    async def complete(self, req: CompletionRequest) -> Completion:
        result: Completion = await self._post("/v1/complete", req, Completion)
        return result

    async def embed(self, req: EmbedRequest) -> EmbedResult:
        result: EmbedResult = await self._post("/v1/embed", req, EmbedResult)
        return result

    async def rerank(self, req: RerankRequest) -> RerankResult:
        result: RerankResult = await self._post("/v1/rerank", req, RerankResult)
        return result

    async def ocr(self, req: OcrRequest) -> OcrResult:
        result: OcrResult = await self._post("/v1/ocr", req, OcrResult)
        return result

    async def close(self) -> None:
        await self.client.aclose()


def main() -> int:
    import uvicorn

    from inspiration.kernel.blobs import LocalBlobStore
    from inspiration.kernel.settings import get_settings

    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--config", type=Path, default=None)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8100)
    args = parser.parse_args()
    settings = get_settings()
    path = args.config or settings.gateway_config
    if path is None:
        parser.error("--config or INSPIRATION_GATEWAY_CONFIG is required")
    gateway = Gateway(GatewayConfig.load(path), blobs=LocalBlobStore(settings.blob_dir))
    uvicorn.run(create_app(gateway), host=args.host, port=args.port)
    return 0


if __name__ == "__main__":
    sys.exit(main())
