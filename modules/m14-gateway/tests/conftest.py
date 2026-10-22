from __future__ import annotations

from collections.abc import Callable
from typing import Any

import pytest

from inspiration.contracts.models import ChatMessage, ChatRole, CompletionRequest, SensitivityLabel
from inspiration.gateway import Gateway, GatewayConfig
from inspiration.kernel.blobs import MemoryBlobStore


def gateway_config(*, include_local: bool = True) -> GatewayConfig:
    """A cloud provider cleared for internal content and a local one cleared for secret."""
    providers: list[dict[str, Any]] = [
        {
            "name": "cloud",
            "kind": "fake",
            "max_sensitivity": "internal",
            "models": [
                {
                    "name": "cloud-flash",
                    "operations": ["complete"],
                    "tiers": ["flash", "standard"],
                    "price": {"input": 1.0, "output": 2.0},
                },
                {"name": "cloud-embed", "operations": ["embed"], "dimensions": 64},
            ],
        }
    ]
    if include_local:
        providers.append(
            {
                "name": "local",
                "kind": "fake",
                "max_sensitivity": "secret",
                "models": [
                    {
                        "name": "local-chat",
                        "operations": ["complete"],
                        "tiers": ["flash", "standard", "flagship"],
                        "json_schema": True,
                    },
                    {"name": "local-embed", "operations": ["embed"], "dimensions": 64},
                    {"name": "local-rerank", "operations": ["rerank"]},
                    {"name": "local-ocr", "operations": ["ocr"]},
                ],
            }
        )
    return GatewayConfig.model_validate(
        {
            "currency": "CNY",
            "providers": providers,
            "routes": [{"match": "m6.*", "prefer": ["local/local-chat"]}],
            "budgets": [{"match": "tenant:capped*", "period": "month", "limit": 0.00001}, {"match": "*"}],
        }
    )


@pytest.fixture
def blobs() -> MemoryBlobStore:
    return MemoryBlobStore()


@pytest.fixture
def gateway(blobs: MemoryBlobStore) -> Gateway:
    return Gateway(gateway_config(), blobs=blobs)


@pytest.fixture
def make_gateway(blobs: MemoryBlobStore) -> Callable[..., Gateway]:
    def make(*, include_local: bool = True, **kwargs: Any) -> Gateway:
        return Gateway(gateway_config(include_local=include_local), blobs=blobs, **kwargs)

    return make


@pytest.fixture
def completion_request() -> Callable[..., CompletionRequest]:
    def make(content: str = "hello", **overrides: Any) -> CompletionRequest:
        fields: dict[str, Any] = {
            "task": "m5.extract_claims",
            "prompt_version": "claims@1",
            "messages": [ChatMessage(role=ChatRole.user, content=content)],
            "sensitivity": SensitivityLabel.internal,
            "budget_key": "tenant:ten_x/m5",
        }
        fields.update(overrides)
        return CompletionRequest(**fields)

    return make
