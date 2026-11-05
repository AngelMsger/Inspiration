// The engine as the business backend calls it: provisioning companies and members as the
// tenancy service, and every other call as the member, passed on from the browser.

import type { PutMember, PutTenant } from "@inspiration/contracts";
import { logger } from "@inspiration/kernel";
import { type Company, type EngineDirectory, engineRoles, type Member } from "@inspiration/tenancy";
import type { Tokens } from "./tokens.ts";

const log = logger("business.engine");

/** The engine did not take a call: down, or it refused it. Answered as 502. */
export class EngineError extends Error {
  override name = "EngineError";
}

/** A call passed on to the engine, and its answer as it came back. */
export interface Forwarded {
  status: number;
  contentType: string;
  body: Uint8Array;
}

/** Headers of the browser's request that reach the engine; everything else stays behind. */
const PASSED_ON = ["content-type", "idempotency-key", "accept"];
/** How many companies' consistency tokens are remembered. */
const REMEMBERED = 10_000;

export class EngineClient implements EngineDirectory {
  readonly url: string;
  readonly #tokens: Tokens;
  readonly #fetch: typeof fetch;
  /** The newest consistency token each company's writes answered, sent with its next reads. */
  readonly #consistency = new Map<string, string>();

  constructor(url: string, tokens: Tokens, options: { fetch?: typeof fetch } = {}) {
    this.url = url.replace(/\/$/, "");
    this.#tokens = tokens;
    this.#fetch = options.fetch ?? fetch;
  }

  async putTenant(company: Company): Promise<void> {
    const body: PutTenant = {
      name: company.name,
      kind: "team",
      default_locale: company.default_locale,
      version: company.version,
    };
    await this.#provision(company.id, `/v0/tenants/${company.id}`, `tenant:${company.id}:${company.version}`, body);
  }

  async putMember(member: Member): Promise<void> {
    const body: PutMember = {
      status: member.status,
      display_name: member.display_name,
      roles: engineRoles(member.role) as PutMember["roles"],
      version: member.version,
    };
    const key = `member:${member.tenant_id}:${member.id}:${member.version}`;
    await this.#provision(member.tenant_id, `/v0/tenants/${member.tenant_id}/members/${member.id}`, key, body);
  }

  /**
   * Pass a browser's call under /api/v0/ on to the engine as the member, with the newest
   * consistency token of their company, so a grant made a moment ago already shows.
   */
  async forward(
    path: string,
    request: { method: string; headers: Record<string, string | string[] | undefined>; body?: Uint8Array },
    member: { tenantId: string; token: string },
  ): Promise<Forwarded> {
    const headers: Record<string, string> = { authorization: `Bearer ${member.token}` };
    for (const name of PASSED_ON) {
      const value = request.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    const consistency = this.#consistency.get(member.tenantId);
    if (consistency) headers["x-inspiration-consistency"] = consistency;
    const answer = await this.#call(`${this.url}${path}`, {
      method: request.method,
      headers,
      ...(request.body && { body: request.body }),
    });
    const body = new Uint8Array(await answer.arrayBuffer());
    const contentType = answer.headers.get("content-type") ?? "application/json; charset=utf-8";
    if (request.method !== "GET" && answer.ok && contentType.startsWith("application/json")) {
      this.#remember(member.tenantId, body);
    }
    return { status: answer.status, contentType, body };
  }

  async #provision(tenantId: string, path: string, idempotencyKey: string, body: PutTenant | PutMember): Promise<void> {
    const answer = await this.#call(`${this.url}${path}`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${this.#tokens.service({ id: tenantId })}`,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify(body),
    });
    const text = await answer.text();
    if (!answer.ok) {
      log.warn("the engine refused a provisioning call", { path, status: answer.status, answer: text.slice(0, 500) });
      throw new EngineError(`the engine answered ${answer.status} to PUT ${path}`);
    }
    this.#remember(tenantId, Buffer.from(text));
  }

  async #call(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.#fetch(url, init);
    } catch (error) {
      log.warn("the engine did not answer", { url, error });
      throw new EngineError(`the engine at ${this.url} did not answer`);
    }
  }

  #remember(tenantId: string, body: Uint8Array): void {
    let token: unknown;
    try {
      token = (JSON.parse(Buffer.from(body).toString("utf8")) as { consistency_token?: unknown }).consistency_token;
    } catch {
      return;
    }
    if (typeof token !== "string") return;
    this.#consistency.delete(tenantId);
    this.#consistency.set(tenantId, token);
    if (this.#consistency.size > REMEMBERED) this.#consistency.delete(this.#consistency.keys().next().value as string);
  }
}
