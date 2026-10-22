"""Structured output: extract JSON from model text and validate it against a schema."""

from __future__ import annotations

import json
import re
from typing import Any

from jsonschema import Draft202012Validator

_FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.S)


class InvalidOutput(ValueError):
    pass


def extract_json(text: str) -> Any:
    """Parse the first JSON value in text, tolerating code fences and surrounding prose."""
    candidates = [m.group(1) for m in _FENCE.finditer(text)] + [text]
    for c in candidates:
        c = c.strip()
        try:
            return json.loads(c)
        except json.JSONDecodeError:
            pass
        starts = [i for i in (c.find("{"), c.find("[")) if i >= 0]
        if starts:
            try:
                value, _ = json.JSONDecoder().raw_decode(c[min(starts) :])
                return value
            except json.JSONDecodeError:
                pass
    raise InvalidOutput("no JSON value found in the model output")


def validate(schema: dict[str, Any], value: Any) -> None:
    errors = sorted(Draft202012Validator(schema).iter_errors(value), key=lambda e: list(e.path))
    if errors:
        msgs = "; ".join(f"{'/'.join(map(str, e.path)) or '(root)'}: {e.message}" for e in errors[:5])
        raise InvalidOutput(msgs)


SCHEMA_MARKER = "It must validate against this JSON Schema:\n"


def schema_instruction(schema: dict[str, Any]) -> str:
    return (
        "Reply with one JSON value only, no prose and no code fences. "
        + SCHEMA_MARKER
        + json.dumps(schema, ensure_ascii=False)
    )
