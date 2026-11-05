// The page talks only to its backend: /api/session, /api/account and /api/members for who is
// signed in and their company, /api/v0/ for the engine's HTTP API as that member, and, in the
// demo only, /api/demo/. Bodies are the contract types, the business ones for the first.
//
// The session works in one company at a time, and switching moves it for every tab, so a call
// that acts in a company names the company of the frame that makes it (x-inspiration-company).
// The backend answers 409 conflict when the session has moved on to another. A frame never sees
// that answer: its call stays unanswered, and the page reads the session again, unless it is
// already switching (`showCompany`). The calls that switch read the next company with `apiIn`.

import type {
  ApiError,
  DocumentTree,
  DocumentView,
  GroundedAnswer,
  Inbox,
  ResolveTodo,
  SearchResult,
  Space,
  SpaceList,
  SpaceOverview,
  SyncReport,
  Tenant,
  Todo,
  TopicList,
  TopicView,
} from "@inspiration/contracts";
import type {
  AccountChange,
  CompanyMember,
  InviteLink,
  InviteList,
  JoinPreview,
  MemberList,
  NewCompany,
  ProductRole,
  RoleChange,
  Session,
  SignOut,
  SwitchCompany,
} from "@inspiration/contracts/business";
import { useEffect, useState } from "react";
import type { Person } from "./people.ts";
import type { Update } from "./updates.ts";

export class ApiFailure extends Error {
  override name = "ApiFailure";
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** A failure as the page shows it; a network error is one the backend never answered. */
export const failureOf = (error: unknown): ApiFailure =>
  error instanceof ApiFailure ? error : new ApiFailure(0, "internal", String(error));

/** The calls that act in a company, which name it. */
const IN_COMPANY = /^\/(members|invites|v0\/|demo\/(people|updates))/;

/** The company of the frame on screen, and what to do when the session has moved on from it. */
let shown: string | undefined;
let moved = () => {};

/** Binds the frame's calls to the company it shows; `onMoved` hears when the session left it. */
export function showCompany(tenant: string | undefined, onMoved: () => void): void {
  shown = tenant;
  moved = onMoved;
}

/** One call. `company` is the one the caller works in; `frame` when the frame on screen makes it. */
async function send<T>(path: string, body: unknown, method: string, company: string | undefined, frame: boolean) {
  const named = IN_COMPANY.test(path) ? company : undefined;
  const headers: Record<string, string> = named ? { "x-inspiration-company": named } : {};
  const res = await fetch(
    `/api${path}`,
    body === undefined
      ? { method, headers }
      : { method, headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  const json = (await res.json().catch(() => undefined)) as unknown;
  if (!res.ok) {
    const e = (json as ApiError | undefined)?.error;
    // The business backend's code, which the engine's ApiErrorCode does not list yet.
    const code: string | undefined = e?.code;
    // A 409 conflict also refuses what the company's rules forbid, such as leaving it with no
    // super admin; it says the session moved on only when the session is in another company now.
    if (frame && named && res.status === 409 && code === "conflict" && !(await stillIn(named))) {
      moved();
      return new Promise<T>(() => {});
    }
    throw new ApiFailure(res.status, e?.code ?? "internal", e?.message ?? res.statusText);
  }
  return json as T;
}

/** Whether the session still works in `tenant`; when it cannot be read, it is taken to have moved. */
async function stillIn(tenant: string): Promise<boolean> {
  const res = await fetch("/api/session").catch(() => undefined);
  const session = res?.ok ? ((await res.json().catch(() => undefined)) as Session | undefined) : undefined;
  return session?.current?.tenant_id === tenant;
}

/** The calls, made in the company `company` names when they are made. */
function apiOf(company: () => string | undefined, frame: boolean) {
  const call = <T>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    send<T>(path, body, method, company(), frame);
  return {
    session: () => call<Session>("/session"),
    enterCompany: (tenant: string) => call<Session>("/session", { tenant_id: tenant } satisfies SwitchCompany),
    account: (change: AccountChange) => call<Session>("/account", change, "PATCH"),
    signOut: () => call<SignOut>("/auth/sign-out", {}),
    createCompany: (company: NewCompany) => call<Session>("/companies", company),
    members: () => call<MemberList>("/members"),
    setRole: (member: string, role: ProductRole) =>
      call<CompanyMember>(`/members/${encodeURIComponent(member)}/role`, { role } satisfies RoleChange, "PUT"),
    removeMember: (member: string) => call<void>(`/members/${encodeURIComponent(member)}`, undefined, "DELETE"),
    invites: () => call<InviteList>("/invites"),
    invite: () => call<InviteLink>("/invites", {}),
    revoke: (invite: string) => call<void>(`/invites/${encodeURIComponent(invite)}`, undefined, "DELETE"),
    joinPreview: (code: string) => call<JoinPreview>(`/join/${encodeURIComponent(code)}`),
    join: (code: string) => call<Session>(`/join/${encodeURIComponent(code)}`, {}),
    /** Whom the demo lets the page act as; the business backend has no such route. */
    demoPeople: () => call<{ people: Person[] }>("/demo/people"),
    actAs: (member: string) => call<Session>("/demo/act-as", { member }),
    spaces: () => call<SpaceList>("/v0/spaces"),
    tree: (space: string) => call<DocumentTree>(`/v0/spaces/${encodeURIComponent(space)}/documents`),
    document: (by: { source?: string; item?: string; version?: string }) =>
      call<DocumentView>(
        `/v0/documents?${new URLSearchParams(
          by.version ? { version: by.version } : { source: by.source ?? "", item: by.item ?? "" },
        )}`,
      ),
    search: (text: string) => call<SearchResult>("/v0/search", { text }),
    answer: (question: string) => call<GroundedAnswer>("/v0/answers", { question }),
    topics: (space: string) => call<TopicList>(`/v0/spaces/${encodeURIComponent(space)}/topics`),
    topic: (key: string) => call<TopicView>(`/v0/topics/${encodeURIComponent(key)}`),
    inbox: () => call<Inbox>("/v0/inbox"),
    resolve: (todo: string, how: ResolveTodo) => call<Todo>(`/v0/todos/${encodeURIComponent(todo)}/resolve`, how),
    overview: (space: string) => call<SpaceOverview>(`/v0/spaces/${encodeURIComponent(space)}/overview`),
    updates: () => call<{ updates: Update[] }>("/demo/updates"),
    putUpdate: (name: string) => call<SyncReport>(`/demo/updates/${encodeURIComponent(name)}`, {}),
  };
}

export type Api = ReturnType<typeof apiOf>;

/** The calls of the frame on screen, in the company it shows. */
export const api = apiOf(() => shown, true);

/** The calls that read a company before its frame is shown, as a switch does; a 409 fails them. */
export const apiIn = (tenant: string): Api => apiOf(() => tenant, false);

/** Where signing in, or up, starts: the identity provider's page, then back to `back`. */
export const signInAt = (screen: "sign_in" | "sign_up", back: string) =>
  `/api/auth/sign-in?${new URLSearchParams({ return_to: back, screen })}`;

export type Loaded<T> = { state: "loading" } | { state: "done"; value: T } | { state: "failed"; error: ApiFailure };

/** Load once per key; a newer key wins over an answer still on its way for an older one. */
export function useLoad<T>(key: string, load: () => Promise<T>): Loaded<T> {
  const [loaded, setLoaded] = useState<{ key: string; value: Loaded<T> }>({ key, value: { state: "loading" } });
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key names everything load reads
  useEffect(() => {
    let current = true;
    setLoaded({ key, value: { state: "loading" } });
    load().then(
      (value) => current && setLoaded({ key, value: { state: "done", value } }),
      (error: unknown) =>
        current &&
        setLoaded({
          key,
          value: {
            state: "failed",
            error: failureOf(error),
          },
        }),
    );
    return () => {
      current = false;
    };
  }, [key]);
  return loaded.key === key ? loaded.value : { state: "loading" };
}

/**
 * What the left column, home and the palette show: the spaces the person reads, with their
 * Documents trees and knowledge outlines.
 */
export interface Library {
  tenant: Tenant;
  spaces: Space[];
  trees: Map<string, DocumentTree>;
  topics: Map<string, TopicList>;
}

export async function loadLibrary(calls: Api = api): Promise<Library> {
  const { tenant, spaces } = await calls.spaces();
  const [trees, topics] = await Promise.all([
    Promise.all(spaces.map((s) => calls.tree(s.id))),
    Promise.all(spaces.map((s) => calls.topics(s.id))),
  ]);
  return {
    tenant,
    spaces,
    trees: new Map(trees.map((t) => [t.space_id, t])),
    topics: new Map(topics.map((t) => [t.space_id, t])),
  };
}
