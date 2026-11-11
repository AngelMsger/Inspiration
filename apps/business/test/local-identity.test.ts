import { createHash, randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import { LocalIdentity } from "../src/local-identity.ts";

test("local identity is explicitly restricted to loopback origins", () => {
  for (const origin of [
    "https://example.test",
    "http://localhost.example.test",
    "http://localhost/path",
    "http://user@localhost",
  ]) {
    expect(() => new LocalIdentity(origin)).toThrow("local mode");
  }
});

test("local sign-in is browser-bound, one use, and keeps the same owner across restarts", async () => {
  const verifier = randomBytes(32).toString("base64url");
  const request = {
    state: randomBytes(16).toString("hex"),
    nonce: randomBytes(16).toString("hex"),
    challenge: createHash("sha256").update(verifier).digest("base64url"),
    screen: "sign_in" as const,
  };
  const provider = new LocalIdentity("http://localhost:4200");
  const url = new URL(await provider.signInUrl(request));
  expect(url.origin).toBe("http://localhost:4200");
  expect(url.searchParams.get("state")).toBe(request.state);
  const code = url.searchParams.get("code") ?? "";
  const identity = await provider.finish(code, verifier, request.nonce);
  await expect(provider.finish(code, verifier, request.nonce)).rejects.toThrow();
  const restarted = new LocalIdentity("http://localhost:4200");
  const newCode = new URL(await restarted.signInUrl(request)).searchParams.get("code") ?? "";
  expect(await restarted.finish(newCode, verifier, request.nonce)).toEqual(identity);
  const badCode = new URL(await provider.signInUrl(request)).searchParams.get("code") ?? "";
  await expect(provider.finish(badCode, "another-browser", request.nonce)).rejects.toThrow();
});
