// The page talks only to its backend: /api/session for who it acts as, /api/v0/ for the
// engine's HTTP API as that person. Bodies are the contract types.

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
import { useEffect, useState } from "react";
import type { Session } from "./backend.ts";
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

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(
    `/api${path}`,
    body === undefined
      ? {}
      : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  const json = (await res.json().catch(() => undefined)) as unknown;
  if (!res.ok) {
    const e = (json as ApiError | undefined)?.error;
    throw new ApiFailure(res.status, e?.code ?? "internal", e?.message ?? res.statusText);
  }
  return json as T;
}

export const api = {
  session: () => call<Session>("/session"),
  actAs: (member: string) => call<Session>("/session", { member }),
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

export async function loadLibrary(): Promise<Library> {
  const { tenant, spaces } = await api.spaces();
  const [trees, topics] = await Promise.all([
    Promise.all(spaces.map((s) => api.tree(s.id))),
    Promise.all(spaces.map((s) => api.topics(s.id))),
  ]);
  return {
    tenant,
    spaces,
    trees: new Map(trees.map((t) => [t.space_id, t])),
    topics: new Map(topics.map((t) => [t.space_id, t])),
  };
}
