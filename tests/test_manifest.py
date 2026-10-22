"""modules.yaml must agree with the event catalogue, the plugin groups and the repo."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
import yaml

from inspiration.contracts import EventType
from inspiration.kernel.plugins import GROUPS

ROOT = Path(__file__).resolve().parents[1]
CALLS = {"store", "authz", "models", "retriever", "blobs"}
STATUSES = {"foundation", "planned", "in_progress"}


@pytest.fixture(scope="module")
def manifest() -> dict[str, Any]:
    data: dict[str, Any] = yaml.safe_load((ROOT / "modules.yaml").read_text(encoding="utf-8"))
    return data


def test_modules_are_unique_and_complete(manifest: dict[str, Any]) -> None:
    modules = manifest["modules"]
    assert [m["id"] for m in modules] == [f"m{i}" for i in range(1, len(modules) + 1)]
    assert len({m["name"] for m in modules}) == len(modules)
    for m in modules:
        assert m["status"] in STATUSES, m["id"]
        assert set(m["calls"]) <= CALLS, m["id"]
        assert set(m["plugins"]) <= set(GROUPS), m["id"]
        if m["status"] == "foundation":
            assert m["package"] and (ROOT / m["package"] / "pyproject.toml").exists(), m["id"]


def test_every_event_has_a_producer_and_a_consumer(manifest: dict[str, Any]) -> None:
    catalogue = {e.value for e in EventType}
    published = {e for m in manifest["modules"] for e in m["publishes"]}
    consumed = {e for m in manifest["modules"] for e in m["subscribes"]}
    assert published <= catalogue, published - catalogue
    assert consumed <= catalogue, consumed - catalogue
    assert catalogue - published == set(), "events nobody publishes"
    assert catalogue - consumed == set(), "events nobody consumes"


def test_platform_packages_exist(manifest: dict[str, Any]) -> None:
    for p in manifest["platform"]:
        assert (ROOT / p["package"] / "pyproject.toml").exists(), p["package"]
