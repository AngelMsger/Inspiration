"""Content-addressed blob stores."""

from __future__ import annotations

import asyncio
import hashlib
from pathlib import Path
from urllib.parse import unquote, urlparse

from inspiration.contracts.models import BlobRef


class LocalBlobStore:
    """Blobs on a local or mounted filesystem, at <root>/<aa>/<sha256>. Prototype default;
    an S3-compatible store implements the same BlobStore protocol."""

    def __init__(self, root: Path) -> None:
        self.root = root.resolve()

    def _path(self, digest: str) -> Path:
        return self.root / digest[:2] / digest

    async def put(self, data: bytes, *, mime_type: str, filename: str | None = None) -> BlobRef:
        digest = hashlib.sha256(data).hexdigest()
        path = self._path(digest)
        if not path.exists():
            await asyncio.to_thread(self._write, path, data)
        return BlobRef(
            uri=path.as_uri(), sha256=f"sha256:{digest}", size_bytes=len(data), mime_type=mime_type, filename=filename
        )

    @staticmethod
    def _write(path: Path, data: bytes) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_bytes(data)
        tmp.replace(path)

    def _resolve(self, ref: BlobRef) -> Path:
        parsed = urlparse(ref.uri)
        if parsed.scheme != "file":
            raise ValueError(f"LocalBlobStore cannot read {ref.uri!r}")
        path = Path(unquote(parsed.path)).resolve()
        if not path.is_relative_to(self.root):
            raise ValueError(f"blob {ref.uri!r} is outside the store")
        return path

    async def get(self, ref: BlobRef) -> bytes:
        data = await asyncio.to_thread(self._resolve(ref).read_bytes)
        if "sha256:" + hashlib.sha256(data).hexdigest() != ref.sha256:
            raise ValueError(f"blob {ref.uri!r} does not match its hash")
        return data

    async def delete(self, ref: BlobRef) -> None:
        await asyncio.to_thread(self._resolve(ref).unlink, missing_ok=True)


class MemoryBlobStore:
    """In-memory BlobStore for tests."""

    def __init__(self) -> None:
        self._data: dict[str, bytes] = {}

    async def put(self, data: bytes, *, mime_type: str, filename: str | None = None) -> BlobRef:
        digest = hashlib.sha256(data).hexdigest()
        self._data[digest] = data
        return BlobRef(
            uri=f"memory://{digest}",
            sha256=f"sha256:{digest}",
            size_bytes=len(data),
            mime_type=mime_type,
            filename=filename,
        )

    async def get(self, ref: BlobRef) -> bytes:
        return self._data[ref.sha256.removeprefix("sha256:")]

    async def delete(self, ref: BlobRef) -> None:
        self._data.pop(ref.sha256.removeprefix("sha256:"), None)
