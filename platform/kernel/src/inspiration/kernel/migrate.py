"""Plain-SQL migrations, owned per component.

Each package that owns tables ships numbered SQL files ("0001_init.sql") and announces
them through the "inspiration.migrations" entry point group:

    [project.entry-points."inspiration.migrations"]
    kb = "inspiration.store:MIGRATIONS"

where MIGRATIONS is a MigrationSet. Components own separate Postgres schemas (bus, kb,
gateway, audit), so they never share tables. Applied files are recorded with a checksum;
editing an applied file is an error, add a new file instead.

Usage: inspiration-migrate [--database-url URL] [--list]
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import sys
from dataclasses import dataclass
from importlib.resources import files
from importlib.resources.abc import Traversable

import psycopg

from .plugins import registry
from .settings import get_settings

LOCK_KEY = 0x1A5_0001  # advisory lock held while migrating

LEDGER = """
CREATE TABLE IF NOT EXISTS public.inspiration_migrations (
    component  text        NOT NULL,
    version    text        NOT NULL,
    checksum   text        NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (component, version)
)
"""

RECORD = "INSERT INTO public.inspiration_migrations (component, version, checksum) VALUES (%s, %s, %s)"


@dataclass(frozen=True)
class MigrationSet:
    component: str
    package: str
    directory: str = "migrations"
    order: int = 100  # lower runs first; platform components use < 100

    def files(self) -> list[tuple[str, str]]:
        root: Traversable = files(self.package).joinpath(self.directory)
        out = []
        for entry in sorted(root.iterdir(), key=lambda t: t.name):
            if entry.name.endswith(".sql"):
                out.append((entry.name.removesuffix(".sql"), entry.read_text(encoding="utf-8")))
        return out


class MigrationError(RuntimeError):
    pass


def discover() -> list[MigrationSet]:
    sets = [p.target for p in registry("migrations").plugins()]
    for s in sets:
        if not isinstance(s, MigrationSet):
            raise MigrationError(f"migrations entry point must be a MigrationSet, got {s!r}")
    return sorted(sets, key=lambda s: (s.order, s.component))


async def apply(database_url: str, sets: list[MigrationSet] | None = None) -> list[str]:
    """Apply pending migrations. Returns the "component/version" names applied."""
    sets = discover() if sets is None else sorted(sets, key=lambda s: (s.order, s.component))
    applied_now: list[str] = []
    async with await psycopg.AsyncConnection.connect(database_url, autocommit=True) as conn:
        await conn.execute("SELECT pg_advisory_lock(%s)", (LOCK_KEY,))
        try:
            await conn.execute(LEDGER)
            rows = await (
                await conn.execute("SELECT component, version, checksum FROM public.inspiration_migrations")
            ).fetchall()
            done = {(c, v): cs for c, v, cs in rows}
            for mset in sets:
                for version, sql in mset.files():
                    checksum = hashlib.sha256(sql.encode("utf-8")).hexdigest()
                    key = (mset.component, version)
                    if key in done:
                        if done[key] != checksum:
                            raise MigrationError(f"{mset.component}/{version} changed after it was applied")
                        continue
                    async with conn.transaction():
                        await conn.execute(sql.encode("utf-8"))
                        await conn.execute(RECORD, (mset.component, version, checksum))
                    applied_now.append(f"{mset.component}/{version}")
        finally:
            await conn.execute("SELECT pg_advisory_unlock(%s)", (LOCK_KEY,))
    return applied_now


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--database-url", default=None)
    parser.add_argument("--list", action="store_true", help="list migration sets and files, apply nothing")
    args = parser.parse_args()
    if args.list:
        for s in discover():
            print(f"{s.component} ({s.package}): {', '.join(v for v, _ in s.files())}")
        return 0
    url = args.database_url or get_settings().database_url
    applied = asyncio.run(apply(url))
    print("migrate: up to date" if not applied else "migrate: applied " + ", ".join(applied))
    return 0


if __name__ == "__main__":
    sys.exit(main())
