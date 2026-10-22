"""Exact-match response cache for deterministic completions (temperature 0 or unset)."""

from __future__ import annotations

from collections import OrderedDict
from typing import Protocol

from redis.asyncio import Redis


class ResponseCache(Protocol):
    async def get(self, key: str) -> str | None: ...

    async def set(self, key: str, value: str, ttl_s: int) -> None: ...


class MemoryCache:
    def __init__(self, max_entries: int = 10_000) -> None:
        self.max_entries = max_entries
        self._data: OrderedDict[str, str] = OrderedDict()

    async def get(self, key: str) -> str | None:
        value = self._data.get(key)
        if value is not None:
            self._data.move_to_end(key)
        return value

    async def set(self, key: str, value: str, ttl_s: int) -> None:
        self._data[key] = value
        self._data.move_to_end(key)
        while len(self._data) > self.max_entries:
            self._data.popitem(last=False)


class ValkeyCache:
    def __init__(self, client: Redis, prefix: str = "insp") -> None:
        self.client = client
        self.prefix = f"{prefix}:gw:cache:"

    async def get(self, key: str) -> str | None:
        value = await self.client.get(self.prefix + key)
        return value if value is None or isinstance(value, str) else value.decode()

    async def set(self, key: str, value: str, ttl_s: int) -> None:
        await self.client.set(self.prefix + key, value, ex=ttl_s)
