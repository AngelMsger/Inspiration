"""M14: the model gateway and the built-in agent runtime.

gateway = Gateway(GatewayConfig.load(path), usage=PostgresUsage(pool), blobs=blobs)
completion = await gateway.complete(CompletionRequest(...))

runtime = Runtime(gateway, ToolRegistry([...]), prompts)
result = await runtime.run(spec, input, ctx)
"""

from inspiration.kernel.migrate import MigrationSet

from .agents import FunctionTool, ReplayTools, Runtime, ToolRegistry
from .config import GatewayConfig, ModelConfig, ProviderConfig
from .errors import GatewayException, ProviderError
from .gateway import Gateway
from .http import HttpModelGateway, create_app
from .metering import MemoryUsage, PostgresUsage
from .prompts import Prompt, PromptRegistry
from .runs import MemoryRuns, PostgresRuns, RunStore

MIGRATIONS = MigrationSet(component="gateway", package="inspiration.gateway", order=20)

__all__ = [
    "MIGRATIONS",
    "FunctionTool",
    "Gateway",
    "GatewayConfig",
    "GatewayException",
    "HttpModelGateway",
    "MemoryRuns",
    "MemoryUsage",
    "ModelConfig",
    "PostgresRuns",
    "PostgresUsage",
    "Prompt",
    "PromptRegistry",
    "ProviderConfig",
    "ProviderError",
    "ReplayTools",
    "RunStore",
    "Runtime",
    "ToolRegistry",
    "create_app",
]
