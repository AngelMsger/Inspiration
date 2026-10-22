"""Gateway configuration: providers, models, routes, budgets and cache.

Example (gateway.yaml):

    currency: CNY
    providers:
      - name: deepseek
        kind: openai_compatible
        base_url: https://api.deepseek.com/v1
        api_key_env: DEEPSEEK_API_KEY
        max_sensitivity: internal          # never sees confidential or secret content
        models:
          - name: deepseek-v4.1-flash
            operations: [complete]
            tiers: [flash, standard]
            json_schema: false
            price: {input: 1.0, output: 2.0, cached_input: 0.2}   # per million tokens
      - name: local
        kind: openai_compatible
        base_url: http://gpu-node:8000/v1
        max_sensitivity: secret
        models:
          - {name: qwen3-embedding-0.6b, operations: [embed], dimensions: 1024}
          - {name: qwen3-reranker-0.6b, operations: [rerank]}
          - {name: paddleocr-vl, operations: [ocr]}
    routes:
      - match: "m7.*"                       # task glob
        prefer: [local/qwen3-30b-a3b]       # provider/model, tried first
    budgets:
      - match: "tenant:*"                   # budget_key glob; first match wins
        period: month
        limit: 5000
"""

from __future__ import annotations

import fnmatch
from pathlib import Path
from typing import Any, Literal

import yaml
from pydantic import BaseModel, Field

from inspiration.contracts.models import BudgetPeriod, GatewayOperation, ModelTier, SensitivityLabel


class Price(BaseModel):
    """Per million tokens, in the gateway currency."""

    input: float = 0.0
    output: float = 0.0
    cached_input: float | None = None

    def cost(self, input_tokens: int, output_tokens: int, cached_tokens: int = 0) -> float:
        cached_price = self.input if self.cached_input is None else self.cached_input
        uncached = max(input_tokens - cached_tokens, 0)
        return (uncached * self.input + cached_tokens * cached_price + output_tokens * self.output) / 1_000_000


class ModelConfig(BaseModel):
    name: str
    operations: list[GatewayOperation]
    tiers: list[ModelTier] = Field(default_factory=list)
    price: Price = Field(default_factory=Price)
    json_schema: bool = False  # supports response_format {"type": "json_schema"}
    dimensions: int | None = None  # embedding size
    max_output_tokens: int | None = None
    query_instruction: str | None = None  # prefix for embedding queries (Qwen3-Embedding style)


class ProviderConfig(BaseModel):
    name: str
    kind: str  # model_providers plugin name
    max_sensitivity: SensitivityLabel
    base_url: str | None = None
    api_key_env: str | None = None
    timeout_s: float = 60.0
    max_retries: int = 2
    options: dict[str, Any] = Field(default_factory=dict)
    models: list[ModelConfig]


class RouteConfig(BaseModel):
    match: str  # task glob
    prefer: list[str]  # "provider/model"


class BudgetConfig(BaseModel):
    match: str  # budget_key glob
    period: BudgetPeriod = BudgetPeriod.month
    limit: float | None = None  # None = unlimited, still metered


class CacheConfig(BaseModel):
    backend: Literal["none", "memory", "valkey"] = "memory"
    ttl_s: int = 7 * 24 * 3600
    max_entries: int = 10_000


class GatewayConfig(BaseModel):
    currency: str = "CNY"
    providers: list[ProviderConfig]
    routes: list[RouteConfig] = Field(default_factory=list)
    budgets: list[BudgetConfig] = Field(default_factory=list)
    cache: CacheConfig = Field(default_factory=CacheConfig)
    default_sensitivity_for_agents: SensitivityLabel = SensitivityLabel.internal

    @classmethod
    def load(cls, path: Path) -> GatewayConfig:
        return cls.model_validate(yaml.safe_load(path.read_text(encoding="utf-8")))

    def budget_for(self, budget_key: str) -> BudgetConfig | None:
        for b in self.budgets:
            if fnmatch.fnmatchcase(budget_key, b.match):
                return b
        return None

    def preferred(self, task: str | None) -> list[str]:
        if task is None:
            return []
        for r in self.routes:
            if fnmatch.fnmatchcase(task, r.match):
                return r.prefer
        return []
