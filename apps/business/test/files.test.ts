import { request } from "node:http";
import type { ApiError } from "@inspiration/contracts";
import type { Session } from "@inspiration/contracts/business";
import { afterEach, beforeEach, expect, test } from "vitest";
import { COMPANY_HEADER } from "../src/index.ts";
import type { Browser } from "../src/testing.ts";
import { type Backend, startBackend, ZHOU } from "./fixtures.ts";

let site: Backend;
let zhou: Browser;
let company: string;
beforeEach(async () => {
  site = await startBackend();
  zhou = await site.signIn(ZHOU);
  company = (await zhou.call<Session>("POST", "/api/companies", { name: "Qinghe Tech" })).body.current?.tenant_id ?? "";
});
afterEach(() => site.close());

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PATH = `/api/v0/spaces/spc_01X0000000/files/${encodeURIComponent("Policies")}/${encodeURIComponent("travel policy.docx")}`;
const bytes = new TextEncoder().encode("PK\u0003\u0004 a travel policy");

test("streams a file on to the engine as it came, with its type and its date", async () => {
  const modified = "2026-10-01T08:00:00.000Z";
  const out = await zhou.call("PUT", PATH, bytes, { "content-type": DOCX, "x-inspiration-modified": modified });
  expect(out.status).toBe(200);
  const call = site.engine.calls.at(-1);
  expect(call?.path).toBe(PATH.slice("/api".length));
  expect(call?.body).toBe("PK\u0003\u0004 a travel policy");
  expect(call?.headers["content-type"]).toBe(DOCX);
  expect(call?.headers["x-inspiration-modified"]).toBe(modified);
  expect(call?.claims).toMatchObject({ tid: company, scope: "knowledge.read knowledge.propose" });
});

test("refuses a file that does not name the page's company, as a form on another site would send it", async () => {
  const before = site.engine.calls.length;
  expect((await zhou.call("PUT", PATH, bytes, { [COMPANY_HEADER]: "ten_01OTHER00000000" })).status).toBe(409);
  zhou.company = undefined;
  const out = await zhou.call<ApiError>("PUT", PATH, bytes, { "content-type": "text/plain" });
  expect([out.status, out.body.error.code]).toEqual([400, "bad_request"]);
  expect(site.engine.calls.length).toBe(before);
});

test("answers 413 for a file over 50 MiB before reading it", async () => {
  const { hostname, port } = new URL(site.url);
  const answer = await new Promise<{ status?: number; body: string }>((resolve, reject) => {
    const req = request(
      {
        host: hostname,
        port,
        method: "PUT",
        path: PATH,
        headers: {
          cookie: [...zhou.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
          [COMPANY_HEADER]: company,
          "content-length": String(50 * 1024 * 1024 + 1),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode, body });
          req.destroy();
        });
      },
    );
    req.on("error", reject);
    req.write(bytes);
  });
  expect(answer.status).toBe(413);
  expect((JSON.parse(answer.body) as ApiError).error.code).toBe("too_large");
});
