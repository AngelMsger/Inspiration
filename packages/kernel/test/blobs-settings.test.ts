import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { LocalBlobStore, loadSettings, MemoryBlobStore } from "../src/index.ts";

const data = new TextEncoder().encode("差旅报销制度 v3");

describe.each([
  ["local", () => new LocalBlobStore(mkdtempSync(join(tmpdir(), "inspiration-blobs-")))],
  ["memory", () => new MemoryBlobStore()],
])("%s blob store", (_name, make) => {
  test("stores content by its hash", async () => {
    const store = make();
    const ref = await store.put(data, { mimeType: "text/plain", filename: "policy.txt" });
    expect(ref.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(ref).toMatchObject({ size_bytes: data.byteLength, mime_type: "text/plain", filename: "policy.txt" });
    expect(await store.get(ref)).toEqual(data);
    expect((await store.put(data, { mimeType: "text/plain" })).uri).toBe(ref.uri);
    await store.delete(ref);
    await expect(store.get(ref)).rejects.toThrow();
  });
});

test("the local store refuses tampered and foreign blobs", async () => {
  const root = mkdtempSync(join(tmpdir(), "inspiration-blobs-"));
  const store = new LocalBlobStore(root);
  const ref = await store.put(data, { mimeType: "text/plain" });
  writeFileSync(fileURLToPath(ref.uri), "tampered");
  await expect(store.get(ref)).rejects.toThrow("does not match its hash");
  await expect(store.get({ ...ref, uri: "file:///etc/passwd" })).rejects.toThrow("outside the store");
  await expect(store.get({ ...ref, uri: "s3://bucket/x" })).rejects.toThrow("cannot read");
});

test("settings come from INSPIRATION_* variables over the defaults", () => {
  const defaults = loadSettings({});
  expect(defaults.databaseUrl).toBe("postgresql://inspiration:inspiration@localhost:5432/inspiration");
  expect(defaults.spicedbInsecure).toBe(true);
  expect(defaults.gatewayConfig).toBeUndefined();
  const custom = loadSettings({
    INSPIRATION_VALKEY_URL: "redis://cache:6379/1",
    INSPIRATION_SPICEDB_INSECURE: "false",
    INSPIRATION_GATEWAY_CONFIG: "config/gateway.yaml",
    INSPIRATION_STREAM_PREFIX: "",
  });
  expect(custom).toMatchObject({ valkeyUrl: "redis://cache:6379/1", spicedbInsecure: false, streamPrefix: "insp" });
  expect(custom.gatewayConfig).toBe("config/gateway.yaml");
  expect(() => loadSettings({ INSPIRATION_SPICEDB_INSECURE: "maybe" })).toThrow(/INSPIRATION_SPICEDB_INSECURE/);
});
