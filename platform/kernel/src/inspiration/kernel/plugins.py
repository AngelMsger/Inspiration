"""Plugin registries.

Connectors, parsers, extractors, diagram compilers, index backends and model providers
register by name. A new source or model is a new plugin, not a core change. Packages
publish plugins through Python entry points:

    [project.entry-points."inspiration.connectors"]
    "feishu.docx" = "inspiration_feishu.docx:FeishuDocxConnector"

Tests and in-process wiring can also call Registry.register directly.
"""

from __future__ import annotations

from dataclasses import dataclass
from importlib.metadata import entry_points
from typing import Any, Final

GROUPS: Final = (
    "connectors",
    "parsers",
    "extractors",
    "diagram_compilers",
    "vector_indexes",
    "keyword_indexes",
    "model_providers",
    "data_providers",
    "view_templates",
    "agent_tools",
    "event_transports",
    "migrations",
)


class PluginError(LookupError):
    pass


@dataclass(frozen=True)
class Plugin:
    group: str
    name: str
    target: Any
    origin: str  # "entry_point:<dist>" or "register"


class Registry:
    """Name to plugin object (usually a class or factory) for one group."""

    def __init__(self, group: str) -> None:
        if group not in GROUPS:
            raise ValueError(f"unknown plugin group {group!r}; known: {', '.join(GROUPS)}")
        self.group = group
        self._plugins: dict[str, Plugin] = {}
        self._loaded = False

    def register(self, name: str, target: Any, *, replace: bool = False) -> None:
        if name in self._plugins and not replace:
            raise PluginError(f"{self.group}: {name!r} is already registered by {self._plugins[name].origin}")
        self._plugins[name] = Plugin(self.group, name, target, "register")

    def load_entry_points(self) -> None:
        if self._loaded:
            return
        self._loaded = True
        for ep in entry_points(group=f"inspiration.{self.group}"):
            if ep.name in self._plugins:
                continue  # explicit registration wins
            dist = ep.dist.name if ep.dist else "unknown"
            self._plugins[ep.name] = Plugin(self.group, ep.name, ep.load(), f"entry_point:{dist}")

    def get(self, name: str) -> Any:
        self.load_entry_points()
        try:
            return self._plugins[name].target
        except KeyError:
            known = ", ".join(sorted(self._plugins)) or "none"
            raise PluginError(f"{self.group}: no plugin named {name!r} (registered: {known})") from None

    def names(self) -> list[str]:
        self.load_entry_points()
        return sorted(self._plugins)

    def plugins(self) -> list[Plugin]:
        self.load_entry_points()
        return [self._plugins[n] for n in sorted(self._plugins)]


_registries: dict[str, Registry] = {}


def registry(group: str) -> Registry:
    """The process-wide registry for a group."""
    if group not in _registries:
        _registries[group] = Registry(group)
    return _registries[group]
