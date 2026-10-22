from __future__ import annotations

import re

import pytest

from inspiration.contracts import EventType, content_hash, kind_of, new_event, new_id, payload_of, stable_id
from inspiration.contracts.events import PAYLOADS
from inspiration.contracts.models import ClaimsUpdated, DocumentFetched


def test_new_id_shape_and_order() -> None:
    a, b = new_id("claim"), new_id("claim")
    assert re.fullmatch(r"clm_[0-9A-HJKMNP-TV-Z]{26}", a)
    assert a != b
    assert kind_of(a) == "claim"


def test_stable_id_is_deterministic() -> None:
    assert stable_id("span", "sv_x", "blk-1", "0:12") == stable_id("span", "sv_x", "blk-1", "0:12")
    assert stable_id("span", "a", "bc") != stable_id("span", "ab", "c")


def test_kind_of_rejects_unknown_prefix() -> None:
    with pytest.raises(ValueError):
        kind_of("zzz_01JC0000000000000000000001")


def test_content_hash_format() -> None:
    assert re.fullmatch(r"sha256:[0-9a-f]{64}", content_hash("住宿"))


def test_event_round_trip() -> None:
    payload = ClaimsUpdated(origin="extracted", added=[new_id("claim")], updated=[], superseded=[])
    first = new_event(
        DocumentFetched(
            source_id=new_id("source"),
            source_version_id=new_id("source_version"),
            external_id="doxcn123",
            changed={"content": True, "metadata": False, "acl": False},
            deleted=False,
        ),
        tenant_id=new_id("tenant"),
        producer="m2.sync",
    )
    event = new_event(payload, tenant_id=first.tenant_id, producer="m5.extractor", causation=first)
    assert event.type == EventType.CLAIMS_UPDATED
    assert event.causation_id == first.id
    assert event.correlation_id == first.id
    assert payload_of(event, ClaimsUpdated) == payload
    with pytest.raises(TypeError):
        payload_of(event, DocumentFetched)


def test_every_event_type_has_a_payload() -> None:
    assert set(PAYLOADS) == set(EventType)
