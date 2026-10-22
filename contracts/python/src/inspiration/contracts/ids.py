"""Identifier and hash helpers shared by every module."""

from __future__ import annotations

import hashlib
import os
import re
import time
from typing import Final

# Prefix of every ID kind, as used in contracts/schema/common.yaml.
PREFIXES: Final[dict[str, str]] = {
    "tenant": "ten",
    "space": "spc",
    "source": "src",
    "source_version": "sv",
    "span": "spn",
    "chunk": "chk",
    "claim": "clm",
    "entity": "ent",
    "relation": "rel",
    "sop": "sop",
    "knowledge_model": "kmd",
    "page": "pg",
    "comment": "cmt",
    "override": "ovr",
    "proposal": "prp",
    "todo": "todo",
    "conflict": "cfl",
    "publish_request": "pub",
    "view": "view",
    "event": "evt",
    "run": "run",
    "request": "req",
    "user": "usr",
    "group": "grp",
    "department": "dep",
    "agent": "agt",
    "service": "svc",
}
KIND_OF_PREFIX: Final[dict[str, str]] = {v: k for k, v in PREFIXES.items()}

_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
_ID = re.compile(r"^(?P<prefix>[a-z]+)_(?P<suffix>[0-9A-Za-z]{8,64})$")


def ulid(timestamp_ms: int | None = None) -> str:
    """A 26-character ULID: 48-bit millisecond timestamp plus 80 random bits."""
    ts = int(time.time() * 1000) if timestamp_ms is None else timestamp_ms
    value = (ts << 80) | int.from_bytes(os.urandom(10), "big")
    chars = []
    for _ in range(26):
        value, rem = divmod(value, 32)
        chars.append(_CROCKFORD[rem])
    return "".join(reversed(chars))


def new_id(kind: str) -> str:
    """New time-ordered ID for a kind, for example new_id("claim") -> "clm_01J..."."""
    return f"{PREFIXES[kind]}_{ulid()}"


def stable_id(kind: str, *parts: str) -> str:
    """Deterministic ID derived from content, for units that must keep their ID across rebuilds."""
    digest = hashlib.sha256("\x1f".join(parts).encode("utf-8")).hexdigest()[:32]
    return f"{PREFIXES[kind]}_{digest}"


def kind_of(id_: str) -> str:
    """The kind of an ID ("claim" for "clm_..."). Raises ValueError for malformed IDs."""
    m = _ID.match(id_)
    if not m or m.group("prefix") not in KIND_OF_PREFIX:
        raise ValueError(f"not an Inspiration ID: {id_!r}")
    return KIND_OF_PREFIX[m.group("prefix")]


def content_hash(data: bytes | str) -> str:
    """ContentHash of bytes or UTF-8 text: "sha256:<hex>"."""
    if isinstance(data, str):
        data = data.encode("utf-8")
    return "sha256:" + hashlib.sha256(data).hexdigest()


def combine_hashes(*parts: str) -> str:
    """Order-sensitive hash of other hashes and version strings (for inputs_hash)."""
    return content_hash("\x1f".join(parts))
