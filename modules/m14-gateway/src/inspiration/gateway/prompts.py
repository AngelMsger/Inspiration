"""Prompt registry. Prompts are versioned files; the version is part of every model call
and of every artifact's inputs hash, so changing a prompt shows exactly what to rebuild.

A prompt file (YAML):

    task: m5.extract_claims
    version: claims@2
    system: |
      You extract atomic claims...
    user: |
      Document: {{title}}
      {{chunk}}
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from inspiration.contracts import content_hash
from inspiration.contracts.models import ChatMessage, ChatRole

_VAR = re.compile(r"\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}")


@dataclass(frozen=True)
class Prompt:
    task: str
    version: str
    user: str
    system: str | None = None

    @property
    def hash(self) -> str:
        return content_hash(json.dumps([self.task, self.version, self.system, self.user], ensure_ascii=False))

    def render(self, **variables: Any) -> list[ChatMessage]:
        def fill(template: str) -> str:
            def sub(m: re.Match[str]) -> str:
                name = m.group(1)
                if name not in variables:
                    raise KeyError(f"prompt {self.task}@{self.version}: missing variable {name!r}")
                v = variables[name]
                return v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)

            return _VAR.sub(sub, template)

        messages = []
        if self.system:
            messages.append(ChatMessage(role=ChatRole.system, content=fill(self.system)))
        messages.append(ChatMessage(role=ChatRole.user, content=fill(self.user)))
        return messages


class PromptRegistry:
    def __init__(self) -> None:
        self._prompts: dict[tuple[str, str], Prompt] = {}

    def register(self, prompt: Prompt) -> None:
        key = (prompt.task, prompt.version)
        if key in self._prompts and self._prompts[key] != prompt:
            raise ValueError(f"prompt {prompt.task} {prompt.version} is already registered with different text")
        self._prompts[key] = prompt

    def load_dir(self, path: Path) -> None:
        for f in sorted(path.rglob("*.yaml")):
            doc = yaml.safe_load(f.read_text(encoding="utf-8"))
            self.register(Prompt(task=doc["task"], version=doc["version"], system=doc.get("system"), user=doc["user"]))

    def get(self, task: str, version: str) -> Prompt:
        try:
            return self._prompts[(task, version)]
        except KeyError:
            raise KeyError(f"no prompt {task} {version}") from None

    def render(self, task: str, version: str, **variables: Any) -> list[ChatMessage]:
        return self.get(task, version).render(**variables)
