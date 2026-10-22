"""Every file in contracts/examples is valid against both the JSON Schema and the pydantic models.

File names are "<TypeName>.<case>.json". The examples double as documentation for module
builders, so keep them realistic.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator
from pydantic import TypeAdapter

from inspiration.contracts import models

CONTRACTS = Path(__file__).resolve().parents[2]
BUNDLE = json.loads((CONTRACTS / "dist" / "inspiration.schema.json").read_text(encoding="utf-8"))
EXAMPLES = sorted((CONTRACTS / "examples").glob("*.json"))


def validator_for(type_name: str) -> Draft202012Validator:
    schema = {"$schema": BUNDLE["$schema"], "$defs": BUNDLE["$defs"], "$ref": f"#/$defs/{type_name}"}
    return Draft202012Validator(schema, format_checker=Draft202012Validator.FORMAT_CHECKER)


def assert_subset(expected: Any, actual: Any, path: str = "$") -> None:
    """Every value in expected appears in actual. Catches example fields the models drop."""
    if isinstance(expected, dict):
        assert isinstance(actual, dict), path
        for k, v in expected.items():
            assert k in actual, f"{path}.{k} was dropped by the model"
            assert_subset(v, actual[k], f"{path}.{k}")
    elif isinstance(expected, list):
        assert isinstance(actual, list) and len(actual) == len(expected), path
        for i, (e, a) in enumerate(zip(expected, actual, strict=True)):
            assert_subset(e, a, f"{path}[{i}]")
    elif isinstance(expected, str) and isinstance(actual, str) and expected.endswith("Z"):
        assert actual in (expected, expected[:-1] + "+00:00"), path
    else:
        assert expected == actual, f"{path}: {expected!r} != {actual!r}"


@pytest.mark.parametrize("path", EXAMPLES, ids=lambda p: p.name)
def test_example_matches_schema_and_models(path: Path) -> None:
    type_name = path.name.split(".", 1)[0]
    doc = json.loads(path.read_text(encoding="utf-8"))

    errors = sorted(validator_for(type_name).iter_errors(doc), key=lambda e: list(e.path))
    assert not errors, "\n".join(f"{list(e.path)}: {e.message}" for e in errors)

    adapter: TypeAdapter[Any] = TypeAdapter(getattr(models, type_name))
    parsed = adapter.validate_python(doc)
    dumped = adapter.dump_python(parsed, mode="json", exclude_none=True)
    assert_subset(doc, dumped)
    assert not list(validator_for(type_name).iter_errors(dumped)), "model output no longer matches the schema"
    assert adapter.dump_python(adapter.validate_python(dumped), mode="json", exclude_none=True) == dumped


def test_every_block_type_has_an_example() -> None:
    page = json.loads((CONTRACTS / "examples" / "PageSpec.travel-policy.json").read_text(encoding="utf-8"))
    used = {b["type"] for b in page["blocks"]}
    declared = set(BUNDLE["$defs"]["Block"]["discriminator"]["mapping"])
    assert used == declared, f"PageSpec example is missing block types: {sorted(declared - used)}"


def test_claim_requires_evidence_fields() -> None:
    # A claim's evidence carries an exact quote; a claim with no span is rejected by M10.
    required = set(BUNDLE["$defs"]["ClaimEvidence"]["required"])
    assert {"span_id", "quote", "source_version_id"} <= required


def test_union_tags_are_unique() -> None:
    for union in ("Block", "DataRef", "ViewHostMessage", "ViewGuestMessage"):
        mapping = BUNDLE["$defs"][union]["discriminator"]["mapping"]
        assert len(mapping) == len(BUNDLE["$defs"][union]["oneOf"])
