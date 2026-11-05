// The browser API (docs in index.ts): which routes there are, who may call each, and how each
// answers from accounts and tenancy, or passes the call on to the engine.

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  type Accounts,
  localeOf,
  SESSION_DAYS,
  SIGN_IN_MINUTES,
  type SignedIn,
  SignInError,
} from "@inspiration/accounts";
import { ContractError, parseAs } from "@inspiration/contracts";
import type {
  AccountChange,
  CompanyMember,
  Invite,
  InviteLink,
  InviteList,
  JoinPreview,
  MemberList,
  NewCompany,
  RoleChange,
  Session,
  SignOut,
  SwitchCompany,
} from "@inspiration/contracts/business";
import { logger } from "@inspiration/kernel";
import {
  type InviteRecord,
  type Member,
  type Membership,
  type Person,
  type Tenancy,
  TenancyError,
} from "@inspiration/tenancy";
import { type EngineClient, EngineError } from "./engine.ts";
import {
  cookie,
  cookieOf,
  HttpError,
  readBody,
  readJson,
  redirect,
  sendError,
  sendJson,
  sendRaw,
  sendsJson,
  serveWeb,
} from "./http.ts";
import type { Tokens } from "./tokens.ts";

const log = logger("business.http");

/** The session cookie. */
export const SESSION_COOKIE = "inspiration_session";
/** The state of the sign-in this browser began, so a callback begun elsewhere is refused. */
export const SIGN_IN_COOKIE = "inspiration_sign_in";
/** Where the browser lands when signing in fails; the page says so. */
export const SIGN_IN_FAILED = "/?sign_in=failed";
/** The company the page shows, sent with calls that act in one. */
export const COMPANY_HEADER = "x-inspiration-company";
/** The largest body passed on to the engine. */
const FORWARD_LIMIT = 1024 * 1024;

export interface BackendOptions {
  accounts: Accounts;
  tenancy: Tenancy;
  engine: EngineClient;
  tokens: Tokens;
  /** This site as the browser reaches it: invite links start with it, and https makes the cookie Secure. */
  publicUrl: string;
  /** The built web app, served for every path outside /api/ and /.well-known/. */
  webDir?: string;
}

/** Who a route needs: anyone, a signed-in account, or a member of the company the session works in. */
type Needs = "anyone" | "account" | "member";

interface Call {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  /** The path's parameters, decoded. */
  params: string[];
  signedIn: SignedIn;
  current: Membership;
}

interface Route {
  method: string;
  path: RegExp;
  needs: Needs;
  run(call: Call): Promise<void>;
}

/** The request listener of the business backend. */
export function backendHandler(options: BackendOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const backend = new Backend(options);
  return (req, res) => backend.handle(req, res);
}

const personOf = (signedIn: SignedIn): Person => ({
  userId: signedIn.user.id,
  name: signedIn.user.name,
  email: signedIn.user.email,
});

const memberOf = (m: Member): CompanyMember => ({
  member_id: m.id,
  display_name: m.display_name,
  email: m.email,
  role: m.role,
});

const inviteOf = (i: InviteRecord, maker: string): Invite => ({
  id: i.id,
  created_by: { member_id: i.created_by, display_name: maker },
  created_at: i.created_at,
  expires_at: i.expires_at,
  joined: i.joined,
});

/** A name as given, without the spaces around it; a blank one is refused. */
function nameOf(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new HttpError(400, "bad_request", "the name is blank");
  return trimmed;
}

class Backend {
  readonly #o: BackendOptions;
  readonly #secure: boolean;
  readonly #routes: Route[];

  constructor(options: BackendOptions) {
    this.#o = options;
    this.#secure = new URL(options.publicUrl).protocol === "https:";
    const { accounts, tenancy } = options;
    this.#routes = [
      {
        method: "GET",
        path: /^\/api\/health$/,
        needs: "anyone",
        run: async ({ res }) => sendJson(res, 200, { ok: true }),
      },
      { method: "GET", path: /^\/api\/auth\/sign-in$/, needs: "anyone", run: (c) => this.#signIn(c) },
      { method: "GET", path: /^\/api\/auth\/callback$/, needs: "anyone", run: (c) => this.#callback(c) },
      { method: "POST", path: /^\/api\/auth\/sign-out$/, needs: "anyone", run: (c) => this.#signOut(c) },
      {
        method: "GET",
        path: /^\/api\/session$/,
        needs: "account",
        run: async ({ res, signedIn }) => sendJson(res, 200, await this.#session(signedIn)),
      },
      {
        method: "POST",
        path: /^\/api\/session$/,
        needs: "account",
        run: async ({ req, res, signedIn }) => {
          const { tenant_id } = parseAs<SwitchCompany>("SwitchCompany", await readJson(req));
          const opened =
            tenant_id === tenancy.sample?.id
              ? await tenancy.visit(personOf(signedIn))
              : await tenancy.membership(tenant_id, signedIn.user.id);
          if (!opened) throw new RangeError(`no company ${tenant_id}`);
          const session = await accounts.workIn(signedIn.session, tenant_id);
          sendJson(res, 200, await this.#session({ ...signedIn, session }));
        },
      },
      {
        method: "PATCH",
        path: /^\/api\/account$/,
        needs: "account",
        run: async ({ req, res, signedIn }) => {
          const change = parseAs<AccountChange>("AccountChange", await readJson(req));
          const user = await accounts.update(signedIn.user, {
            ...(change.name !== undefined && { name: nameOf(change.name) }),
            ...(change.locale && { locale: change.locale }),
          });
          const next = { ...signedIn, user };
          if (user.name !== signedIn.user.name) await tenancy.rename(personOf(next));
          sendJson(res, 200, await this.#session(next));
        },
      },
      {
        method: "POST",
        path: /^\/api\/companies$/,
        needs: "account",
        run: async ({ req, res, signedIn }) => {
          const input = parseAs<NewCompany>("NewCompany", await readJson(req));
          const { company } = await tenancy.create(personOf(signedIn), {
            name: nameOf(input.name),
            default_locale: input.default_locale ?? signedIn.user.locale,
          });
          const session = await accounts.workIn(signedIn.session, company.id);
          sendJson(res, 201, await this.#session({ ...signedIn, session }));
        },
      },
      {
        method: "GET",
        path: /^\/api\/join\/([^/]+)$/,
        needs: "anyone",
        run: async ({ res, params: [code] }) => {
          const found = await tenancy.preview(code ?? "");
          if (!found) throw new RangeError("no such invite");
          const preview: JoinPreview = {
            company: { name: found.company.name },
            invited_by: { display_name: found.invitedBy.display_name },
            expires_at: found.invite.expires_at,
          };
          sendJson(res, 200, preview);
        },
      },
      {
        method: "POST",
        path: /^\/api\/join\/([^/]+)$/,
        needs: "account",
        run: async ({ res, params: [code], signedIn }) => {
          const { company } = await tenancy.join(personOf(signedIn), code ?? "");
          const session = await accounts.workIn(signedIn.session, company.id);
          sendJson(res, 200, await this.#session({ ...signedIn, session }));
        },
      },
      {
        method: "GET",
        path: /^\/api\/members$/,
        needs: "member",
        run: async ({ res, current }) => {
          const list: MemberList = { members: (await tenancy.members(current.member)).map(memberOf) };
          sendJson(res, 200, list);
        },
      },
      {
        method: "PUT",
        path: /^\/api\/members\/([^/]+)\/role$/,
        needs: "member",
        run: async ({ req, res, params: [id], current }) => {
          const { role } = parseAs<RoleChange>("RoleChange", await readJson(req));
          sendJson(res, 200, memberOf(await tenancy.setRole(current.member, id ?? "", role)));
        },
      },
      {
        method: "DELETE",
        path: /^\/api\/members\/([^/]+)$/,
        needs: "member",
        run: async ({ res, params: [id], current }) => {
          await tenancy.remove(current.member, id ?? "");
          sendJson(res, 204);
        },
      },
      {
        method: "POST",
        path: /^\/api\/invites$/,
        needs: "member",
        run: async ({ res, current }) => {
          const { invite, code } = await tenancy.invite(current.member);
          const link: InviteLink = {
            invite: inviteOf(invite, current.member.display_name),
            url: `${options.publicUrl.replace(/\/$/, "")}/join/${code}`,
          };
          sendJson(res, 201, link);
        },
      },
      {
        method: "GET",
        path: /^\/api\/invites$/,
        needs: "member",
        run: async ({ res, current }) => {
          const invites = await tenancy.invites(current.member);
          const names = new Map((await tenancy.members(current.member)).map((m) => [m.id, m.display_name]));
          const list: InviteList = { invites: invites.map((i) => inviteOf(i, names.get(i.created_by) ?? "")) };
          sendJson(res, 200, list);
        },
      },
      {
        method: "DELETE",
        path: /^\/api\/invites\/([^/]+)$/,
        needs: "member",
        run: async ({ res, params: [id], current }) => {
          await tenancy.revoke(current.member, id ?? "");
          sendJson(res, 204);
        },
      },
      { method: "*", path: /^\/api\/v0\/.+$/, needs: "member", run: (c) => this.#forward(c) },
      {
        method: "GET",
        path: /^\/\.well-known\/jwks\.json$/,
        needs: "anyone",
        run: async ({ res }) => sendJson(res, 200, options.tokens.jwks(), { "cache-control": "public, max-age=300" }),
      },
    ];
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    let path = req.url ?? "/";
    try {
      // Parsed inside the try: a listener that throws would take the process down with it.
      const url = URL.parse(path, "http://localhost");
      if (!url) throw new HttpError(400, "bad_request", `the request target ${path} is not a valid URL`);
      path = url.pathname;
      const route = this.#routes.find((r) => (r.method === "*" || r.method === method) && r.path.test(path));
      if (!route) {
        const api = path.startsWith("/api/") || path.startsWith("/.well-known/");
        if (api || !this.#o.webDir || (method !== "GET" && method !== "HEAD")) {
          throw new HttpError(404, "not_found", `no route ${method} ${path}`);
        }
        return await serveWeb(this.#o.webDir, path, req, res);
      }
      if (["POST", "PUT", "PATCH"].includes(method) && !sendsJson(req)) {
        throw new HttpError(400, "bad_request", "send the body as application/json");
      }
      const params = (path.match(route.path) ?? []).slice(1).map((p) => decodeURIComponent(p));
      const call = { req, res, url, params } as Call;
      if (route.needs !== "anyone") call.signedIn = await this.#signedIn(req);
      if (route.needs === "member") call.current = await this.#current(call.signedIn, req);
      await route.run(call);
    } catch (error) {
      const e = httpErrorOf(error);
      if (!e) log.error("request failed", { method, path, error });
      if (error instanceof EngineError) log.warn("the engine did not take a call", { method, path });
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendError(res, e ?? new HttpError(500, "internal", "internal error"));
    }
  }

  async #signedIn(req: IncomingMessage): Promise<SignedIn> {
    const signedIn = await this.#o.accounts.session(cookieOf(req, SESSION_COOKIE));
    if (!signedIn) throw new HttpError(401, "unauthenticated", "sign in first");
    return signedIn;
  }

  /**
   * The membership the session works in: the company it names while the account is still an
   * active member of it, else the account's first company, which the session then keeps. A
   * page that names the company it shows (COMPANY_HEADER) and shows another, as a second tab
   * may after the first switched, is answered 409, so it never acts in a company it does not show.
   */
  async #current(signedIn: SignedIn, req: IncomingMessage): Promise<Membership> {
    const { session, user } = signedIn;
    let current = session.tenant_id ? await this.#o.tenancy.membership(session.tenant_id, user.id) : undefined;
    if (!current) {
      [current] = await this.#o.tenancy.companiesOf(user.id);
      if (!current) throw new HttpError(400, "bad_request", "the account has no company yet");
      await this.#o.accounts.workIn(session, current.company.id);
    }
    const shown = req.headers[COMPANY_HEADER];
    if (typeof shown === "string" && shown !== current.company.id) {
      throw new HttpError(409, "conflict", "the session works in another company now");
    }
    return current;
  }

  async #session(signedIn: SignedIn): Promise<Session> {
    const { user, session } = signedIn;
    const { tenancy } = this.#o;
    const companies = await tenancy.companiesOf(user.id);
    let current = session.tenant_id ? await tenancy.membership(session.tenant_id, user.id) : undefined;
    if (!current && companies[0]) {
      current = companies[0];
      await this.#o.accounts.workIn(session, current.company.id);
    }
    return {
      account: { name: user.name, email: user.email, locale: user.locale },
      companies: companies.map(({ company, member }) => ({
        tenant_id: company.id,
        name: company.name,
        role: member.role,
      })),
      ...(tenancy.sample && { sample: { tenant_id: tenancy.sample.id, name: tenancy.sample.name } }),
      ...(current && {
        current: {
          tenant_id: current.company.id,
          member_id: current.member.id,
          display_name: current.member.display_name,
          role: current.member.role,
        },
      }),
    };
  }

  /** The start of a sign-in, a page the browser opens: when the provider cannot be reached, it lands on SIGN_IN_FAILED. */
  async #signIn({ req, res, url }: Call): Promise<void> {
    let started: { url: string; state: string };
    try {
      started = await this.#o.accounts.startSignIn({
        returnTo: url.searchParams.get("return_to") ?? undefined,
        screen: url.searchParams.get("screen") === "sign_up" ? "sign_up" : "sign_in",
        locale: localeOf(req.headers["accept-language"]),
      });
    } catch (error) {
      log.error("the identity provider did not answer", { error });
      return redirect(res, SIGN_IN_FAILED);
    }
    const maxAgeSeconds = SIGN_IN_MINUTES * 60;
    redirect(res, started.url, [cookie(SIGN_IN_COOKIE, started.state, { maxAgeSeconds, secure: this.#secure })]);
  }

  /** The provider's redirect back, a page too: every failure lands on SIGN_IN_FAILED. */
  async #callback({ req, res, url }: Call): Promise<void> {
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    const done = cookie(SIGN_IN_COOKIE, "", { maxAgeSeconds: 0, secure: this.#secure });
    try {
      if (!state || !code) throw new SignInError(`the provider sent ${url.searchParams.get("error") ?? "no code"}`);
      if (cookieOf(req, SIGN_IN_COOKIE) !== state) throw new SignInError("the sign-in began in another browser");
      const { token, returnTo } = await this.#o.accounts.finishSignIn({
        state,
        code,
        locale: localeOf(req.headers["accept-language"]),
      });
      const maxAgeSeconds = SESSION_DAYS * 24 * 60 * 60;
      redirect(res, returnTo, [done, cookie(SESSION_COOKIE, token, { maxAgeSeconds, secure: this.#secure })]);
    } catch (error) {
      if (error instanceof SignInError) log.info("sign-in refused", { reason: error.message });
      else log.error("sign-in failed", { error });
      redirect(res, SIGN_IN_FAILED, [done]);
    }
  }

  async #signOut({ req, res }: Call): Promise<void> {
    const signedIn = await this.#o.accounts.session(cookieOf(req, SESSION_COOKIE));
    const answer: SignOut = { next: await this.#o.accounts.signOut(signedIn?.session) };
    sendJson(res, 200, answer, {
      "set-cookie": cookie(SESSION_COOKIE, "", { maxAgeSeconds: 0, secure: this.#secure }),
    });
  }

  /** /api/v0/… on to the engine's /v0/… as the current member; provisioning stays the backend's own. */
  async #forward({ req, res, url, signedIn, current }: Call): Promise<void> {
    const path = url.pathname.slice("/api".length);
    if (/^\/v0\/tenants(\/|$)/.test(path))
      throw new HttpError(404, "not_found", `no route ${req.method} ${url.pathname}`);
    const method = req.method ?? "GET";
    const body = method === "GET" || method === "HEAD" ? undefined : await readBody(req, FORWARD_LIMIT);
    const token = this.#o.tokens.member(current.member, signedIn.user.locale, signedIn.session.created_at, {
      readOnly: current.company.sample,
    });
    const answer = await this.#o.engine.forward(
      `${path}${url.search}`,
      { method, headers: req.headers, ...(body && { body: new Uint8Array(body) }) },
      { tenantId: current.company.id, token },
    );
    sendRaw(res, answer.status, answer.contentType, answer.body);
  }
}

function httpErrorOf(error: unknown): HttpError | undefined {
  if (error instanceof HttpError) return error;
  if (error instanceof ContractError || error instanceof SyntaxError || error instanceof URIError) {
    return new HttpError(400, "bad_request", error.message);
  }
  if (error instanceof TenancyError) {
    return error.code === "conflict"
      ? new HttpError(409, "conflict", error.message)
      : new HttpError(403, "forbidden", error.message);
  }
  if (error instanceof RangeError) return new HttpError(404, "not_found", error.message);
  if (error instanceof EngineError) {
    return new HttpError(502, "internal", "the engine did not answer; the change is kept and sent again later");
  }
  return undefined;
}
