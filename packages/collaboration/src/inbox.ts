import {
  type EventEnvelope,
  type EventHandler,
  type IdKind,
  type KnowledgeStore,
  kindOf,
  newEvent,
  newId,
  payloadOf,
  type ReviewDueKind,
  type TaxonomyNode,
  type Todo,
  type TodoKind,
  type TodoStatus,
} from "@inspiration/contracts";
import { defineTable, type Records, type RecordTx } from "@inspiration/eventbus";
import { logger } from "@inspiration/kernel";
import { addWeeks, isoWeek } from "./weeks.ts";

const log = logger("collaboration");

export const COMPONENT = "collaboration";

export const INBOX_DEFAULTS = {
  /** Cards an owner gets in a week, notes aside. */
  budget: 10,
  /** Todos on one card. */
  cardSize: 20,
  /** Weeks past its due week the budget may move a todo. */
  horizon: 26,
};

export type InboxSettings = typeof INBOX_DEFAULTS;

/** A todo as the inbox keeps it, with what routing needs. */
export interface Item {
  todo: Todo;
  dedupe_key: string;
  /** The week it fell due. todo.week is the week it is scheduled in, later when the budget was full. */
  due_week: string;
  /** The source update that asked for it: a copy review joins the conflict card of the same update. */
  correlation_id?: string;
  /** For a copy review on a conflict todo's card: that todo. */
  with_todo?: string;
  /** A review already due when freshness first saw its document: first-review campaign work. */
  campaign?: true;
}

export const ITEMS = defineTable<Item>("collaboration.items", {
  key: (i) => i.todo.id,
  columns: {
    tenant_id: (i) => i.todo.tenant_id,
    dedupe_key: (i) => i.dedupe_key,
    status: (i) => i.todo.status,
    assignee: (i) => i.todo.assignee_id,
    week: (i) => i.todo.week,
    batch_key: (i) => i.todo.batch_key,
    correlation_id: (i) => i.correlation_id,
  },
});

/**
 * review: an owner's todos about one topic in one week, counted against the budget. notes:
 * an owner's notes of one week. campaign: a space's first reviews of one topic. steward:
 * todos of a topic nobody owns, for the space's steward.
 */
export type CardKind = "review" | "notes" | "campaign" | "steward";

export interface Card {
  batch_key: string;
  kind: CardKind;
  assignee_id?: string;
  taxonomy_key?: string;
  week?: string;
  todos: Todo[];
}

const OPEN: TodoStatus[] = ["open", "in_progress"];
const UNFILED = "unfiled";

const REVIEW_KIND: Record<ReviewDueKind, TodoKind> = {
  ttl: "review_due",
  verification_expiry: "review_due",
  assumption: "assumption_drift",
  evidence_changed: "stale",
};

const URGENT = new Set(["high", "urgent"]);
const PRIORITY: readonly Todo["priority"][] = ["low", "normal", "high", "urgent"];

/** What a request or a due review asks for, before it is a todo. */
interface Request {
  kind: TodoKind;
  space_id: string;
  title: string;
  detail?: string;
  priority: Todo["priority"];
  unit_ids: string[];
  dedupe_key: string;
  slot_key?: string;
  due_at?: string;
  campaign?: boolean;
}

/** The topic a todo's units are placed in, and who owns it. */
interface Route {
  topic?: string;
  owner?: string;
}

function idKind(id: string): IdKind | undefined {
  try {
    return kindOf(id);
  } catch {
    return undefined;
  }
}

function majority(keys: readonly string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  return [...counts].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))[0]?.[0];
}

const part = (base: string, n: number) => (n > 1 ? `${base}:${n}` : base);

export function cardKind(batchKey: string): CardKind {
  const kind = batchKey.split(":")[0];
  if (kind === "card") return "review";
  if (kind === "notes" || kind === "campaign" || kind === "steward") return kind;
  throw new RangeError(`not an inbox card: ${batchKey}`);
}

export interface InboxOptions {
  store: KnowledgeStore;
  records: Records;
  clock?: () => Date;
  settings?: Partial<InboxSettings>;
}

/**
 * The inbox: turns todo requests and due reviews into todos, merged by dedupe key, and puts
 * each on a card of its topic's owner for the week it falls due, within the owner's weekly
 * budget. See the package doc comment for the rules.
 */
export class Inbox {
  readonly store: KnowledgeStore;
  readonly records: Records;
  readonly clock: () => Date;
  readonly settings: InboxSettings;
  readonly totals = { received: 0, created: 0, merged: 0, withdrawn: 0, rerouted: 0 };
  readonly #running = new Map<string, Promise<unknown>>();

  constructor(options: InboxOptions) {
    this.store = options.store;
    this.records = options.records;
    this.clock = options.clock ?? (() => new Date());
    this.settings = { ...INBOX_DEFAULTS, ...options.settings };
  }

  readonly onTodoRequested: EventHandler = async (event: EventEnvelope) => {
    const r = payloadOf(event, "todo.requested");
    if (r.withdrawn) return this.#withdraw(event, r.dedupe_key);
    await this.#receive(event, {
      kind: r.kind,
      space_id: r.space_id,
      title: r.title,
      ...(r.detail !== undefined && { detail: r.detail }),
      priority: r.priority,
      unit_ids: r.unit_ids,
      dedupe_key: r.dedupe_key,
      ...(r.slot_key !== undefined && { slot_key: r.slot_key }),
    });
  };

  readonly onReviewDue: EventHandler = async (event: EventEnvelope) => {
    const r = payloadOf(event, "review.due");
    const space = r.space_id ?? (await this.#spaceOf(r.unit_ids));
    if (!space) throw new RangeError(`review ${event.id}: no space for ${r.unit_ids.join(", ")}`);
    await this.#receive(event, {
      kind: REVIEW_KIND[r.kind],
      space_id: space,
      title: r.reason ?? `${r.kind} review`,
      priority: r.backlog ? "low" : "normal",
      unit_ids: r.unit_ids,
      dedupe_key: r.dedupe_key ?? `freshness:${r.kind}:${r.unit_ids.join(",")}`,
      due_at: r.due_at,
      ...(r.backlog && { campaign: true }),
    });
  };

  handlers(): Record<string, EventHandler> {
    return { "todo.requested": this.onTodoRequested, "review.due": this.onReviewDue };
  }

  /**
   * Route open todos again after topics or their owners changed: a todo whose topic or owner
   * is no longer the one it has moves to the new owner's card, within the budget from its due
   * week; a copy review follows its conflict todo. Urgent and high todos go first.
   */
  async reroute(tenantId: string): Promise<{ moved: number }> {
    return this.#serial(tenantId, async () => {
      const topics = await this.#topics(tenantId);
      const open = await this.records.find(ITEMS, { tenant_id: tenantId, status: OPEN });
      const rank = (i: Item) => (URGENT.has(i.todo.priority) ? 0 : 1);
      let moved = 0;
      for (const item of open
        .filter((i) => !i.with_todo && !i.campaign)
        .sort((a, b) => rank(a) - rank(b) || (a.todo.created_at < b.todo.created_at ? -1 : 1))) {
        const route = await this.#route(item.todo.unit_ids, topics);
        if (route.topic === item.todo.taxonomy_key && route.owner === item.todo.assignee_id) continue;
        await this.records.transaction(async (tx) => {
          await this.#schedule(tx, item, route);
          await tx.put(ITEMS, [item]);
        });
        moved++;
      }
      for (const item of open.filter((i) => i.with_todo)) {
        const host = await this.records.get(ITEMS, item.with_todo as string);
        if (!host || host.todo.batch_key === item.todo.batch_key) continue;
        this.#ride(item, host);
        await this.records.transaction((tx) => tx.put(ITEMS, [item]));
        moved++;
      }
      this.totals.rerouted += moved;
      return { moved };
    });
  }

  /** Close a todo: done (with the key of the resolution chosen, if any) or dismissed. */
  async resolve(
    tenantId: string,
    todoId: string,
    how: { by: string; with?: string; status?: "done" | "dismissed" },
  ): Promise<Todo> {
    const [todo] = await this.#close(tenantId, [todoId], how);
    return todo as Todo;
  }

  /** Acknowledge notes, as one action: they are done. */
  async acknowledge(tenantId: string, todoIds: readonly string[], by: string): Promise<Todo[]> {
    return this.#close(tenantId, todoIds, { by, with: "acknowledged" }, "note");
  }

  /** The tenant's todos as the inbox keeps them, optionally only open ones. */
  async items(tenantId: string, options: { open?: boolean } = {}): Promise<Item[]> {
    return this.records.find(ITEMS, options.open ? { tenant_id: tenantId, status: OPEN } : { tenant_id: tenantId });
  }

  /**
   * Cards with their todos, optionally one assignee's or one week's, open todos only. A card
   * lists its todos by priority, then oldest first.
   */
  async cards(tenantId: string, filter: { assignee?: string; week?: string } = {}): Promise<Card[]> {
    const items = await this.records.find(ITEMS, {
      tenant_id: tenantId,
      status: OPEN,
      ...(filter.assignee !== undefined && { assignee: filter.assignee }),
      ...(filter.week !== undefined && { week: filter.week }),
    });
    const cards = new Map<string, Card>();
    for (const { todo } of items) {
      const k = todo.batch_key as string;
      let card = cards.get(k);
      if (!card) {
        card = {
          batch_key: k,
          kind: cardKind(k),
          ...(todo.assignee_id && { assignee_id: todo.assignee_id }),
          ...(todo.taxonomy_key && { taxonomy_key: todo.taxonomy_key }),
          ...(todo.week && { week: todo.week }),
          todos: [],
        };
        cards.set(k, card);
      }
      card.todos.push(todo);
    }
    // Most urgent first, then oldest, a conflict before the reviews that ride on it.
    const later = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    const decision = (t: Todo) => (t.kind === "conflict" ? 0 : 1);
    const order = (a: Todo, b: Todo) =>
      PRIORITY.indexOf(b.priority) - PRIORITY.indexOf(a.priority) ||
      later(a.created_at, b.created_at) ||
      decision(a) - decision(b) ||
      later(a.id, b.id);
    for (const card of cards.values()) card.todos.sort(order);
    return [...cards.values()].sort((a, b) =>
      a.week !== b.week ? ((a.week ?? "") < (b.week ?? "") ? -1 : 1) : a.batch_key < b.batch_key ? -1 : 1,
    );
  }

  async #serial<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    const before = this.#running.get(tenantId) ?? Promise.resolve();
    const run = before.catch(() => undefined).then(fn);
    this.#running.set(tenantId, run);
    try {
      return await run;
    } finally {
      if (this.#running.get(tenantId) === run) this.#running.delete(tenantId);
    }
  }

  async #receive(event: EventEnvelope, request: Request): Promise<void> {
    await this.#serial(event.tenant_id, async () => {
      const tenantId = event.tenant_id;
      const route = await this.#route(request.unit_ids, await this.#topics(tenantId));
      const now = this.clock();
      const created = await this.records.transaction(async (tx) => {
        if (!(await tx.firstDelivery(COMPONENT, event.id))) return undefined;
        this.totals.received++;
        const [open] = await tx.find(ITEMS, { tenant_id: tenantId, dedupe_key: request.dedupe_key, status: OPEN });
        if (open) {
          // A later request replaces what the todo says; where it sits stays.
          const { detail: _detail, slot_key: _slot, ...todo } = open.todo;
          open.todo = {
            ...todo,
            title: request.title,
            priority: request.priority,
            unit_ids: request.unit_ids,
            ...(request.detail !== undefined && { detail: request.detail }),
            ...(request.slot_key !== undefined && { slot_key: request.slot_key }),
          };
          await tx.put(ITEMS, [open]);
          this.totals.merged++;
          return undefined;
        }
        const due = request.due_at && Date.parse(request.due_at) > now.getTime() ? new Date(request.due_at) : now;
        const item: Item = {
          todo: {
            id: newId("todo"),
            tenant_id: tenantId,
            space_id: request.space_id,
            kind: request.kind,
            title: request.title,
            priority: request.priority,
            status: "open",
            unit_ids: request.unit_ids,
            created_by: event.producer,
            created_at: now.toISOString(),
            ...(request.detail !== undefined && { detail: request.detail }),
            ...(request.slot_key !== undefined && { slot_key: request.slot_key }),
            ...(request.due_at !== undefined && { due_at: request.due_at }),
          },
          dedupe_key: request.dedupe_key,
          due_week: isoWeek(due),
          ...(event.correlation_id && { correlation_id: event.correlation_id }),
          ...(request.campaign && { campaign: true }),
        };
        await this.#schedule(tx, item, route);
        await tx.put(ITEMS, [item]);
        const t = item.todo;
        await tx.publish(
          newEvent(
            "todo.created",
            {
              todo_id: t.id,
              kind: t.kind,
              space_id: t.space_id,
              priority: t.priority,
              ...(t.assignee_id && { assignee_id: t.assignee_id }),
              ...(t.batch_key && { batch_key: t.batch_key }),
            },
            { tenantId, producer: COMPONENT, subject: t.id, causation: event, occurredAt: now },
          ),
        );
        this.totals.created++;
        return t;
      });
      if (created) log.debug("todo created", { tenant: tenantId, todo: created.id, card: created.batch_key });
    });
  }

  /** The reason for a todo went away: its open todo is dismissed, and nothing opens. */
  async #withdraw(event: EventEnvelope, dedupeKey: string): Promise<void> {
    await this.#serial(event.tenant_id, () =>
      this.records.transaction(async (tx) => {
        if (!(await tx.firstDelivery(COMPONENT, event.id))) return;
        this.totals.received++;
        const open = await tx.find(ITEMS, { tenant_id: event.tenant_id, dedupe_key: dedupeKey, status: OPEN });
        if (!open.length) return;
        const at = this.clock().toISOString();
        for (const item of open) {
          item.todo = { ...item.todo, status: "dismissed", resolved_with: "withdrawn", resolved_at: at };
        }
        await tx.put(ITEMS, open);
        this.totals.withdrawn += open.length;
      }),
    );
  }

  /**
   * Put a todo on its card: a note on its owner's notes of the week, a first review on its
   * topic's campaign, a copy review on the card of the conflict its source update opened, a
   * todo of a topic nobody owns on the steward's card, and any other on its owner's card for
   * the topic, in the first week from its due week with room in the budget.
   */
  async #schedule(tx: RecordTx, item: Item, route: Route): Promise<void> {
    const { assignee_id: _assignee, taxonomy_key: _topic, week: _week, batch_key: _batch, ...todo } = item.todo;
    item.todo = {
      ...todo,
      ...(route.topic && { taxonomy_key: route.topic }),
      ...(route.owner && !item.campaign && { assignee_id: route.owner }),
    };
    delete item.with_todo;
    const t = item.todo;
    const due = item.due_week;
    const topic = route.topic ?? UNFILED;
    const set = (week: string, batchKey: string) => {
      t.week = week;
      t.batch_key = batchKey;
    };
    if (t.kind === "note")
      return set(due, route.owner ? `notes:${route.owner}:${due}` : `notes:steward:${t.space_id}:${due}`);
    // Campaign and steward cards hold at most cardSize todos, as an owner's do.
    const fill = async (base: string) => {
      for (let n = 1; ; n++) {
        const on = await tx.find(ITEMS, { tenant_id: t.tenant_id, batch_key: part(base, n) });
        if (on.filter((i) => i.todo.id !== t.id).length < this.settings.cardSize) return part(base, n);
      }
    };
    if (item.campaign) return set(due, await fill(`campaign:${t.space_id}:${topic}`));
    if (t.kind === "stale" && item.correlation_id) {
      const host = (
        await tx.find(ITEMS, { tenant_id: t.tenant_id, correlation_id: item.correlation_id, status: OPEN })
      ).find((i) => i.todo.kind === "conflict");
      if (host) return this.#ride(item, host);
    }
    if (!route.owner) return set(due, await fill(`steward:${t.space_id}:${topic}:${due}`));

    const owner = route.owner;
    const urgent = URGENT.has(t.priority);
    const slot = async (week: string) => {
      const cards = new Map<string, number>();
      for (const other of await tx.find(ITEMS, { tenant_id: t.tenant_id, assignee: owner, week })) {
        const k = other.todo.batch_key;
        if (other.todo.id !== t.id && k && cardKind(k) === "review") cards.set(k, (cards.get(k) ?? 0) + 1);
      }
      const base = `card:${owner}:${topic}:${week}`;
      let n = 1;
      for (; cards.has(part(base, n)); n++) {
        if ((cards.get(part(base, n)) as number) < this.settings.cardSize) return { key: part(base, n), room: true };
      }
      return { key: part(base, n), room: cards.size < this.settings.budget };
    };
    for (let i = 0; i <= this.settings.horizon; i++) {
      const week = addWeeks(due, i);
      const { key, room } = await slot(week);
      if (room || urgent) return set(week, key);
    }
    // No week within the horizon has room: the due week, over the budget.
    set(due, (await slot(due)).key);
  }

  /** A copy review on its conflict todo's card. */
  #ride(item: Item, host: Item): void {
    const { assignee_id: _assignee, taxonomy_key: _topic, week: _week, batch_key: _batch, ...todo } = item.todo;
    const h = host.todo;
    item.todo = {
      ...todo,
      ...(h.assignee_id && { assignee_id: h.assignee_id }),
      ...(h.taxonomy_key && { taxonomy_key: h.taxonomy_key }),
      ...(h.week && { week: h.week }),
      ...(h.batch_key && { batch_key: h.batch_key }),
    };
    item.with_todo = h.id;
  }

  async #close(
    tenantId: string,
    todoIds: readonly string[],
    how: { by: string; with?: string; status?: "done" | "dismissed" },
    kind?: TodoKind,
  ): Promise<Todo[]> {
    return this.#serial(tenantId, () =>
      this.records.transaction(async (tx) => {
        const items = await tx.getMany(ITEMS, todoIds);
        const found = new Map(items.filter((i) => i.todo.tenant_id === tenantId).map((i) => [i.todo.id, i]));
        const at = this.clock().toISOString();
        const out: Todo[] = [];
        for (const id of todoIds) {
          const item = found.get(id);
          if (!item) throw new RangeError(`unknown todo ${id}`);
          if (kind && item.todo.kind !== kind) throw new RangeError(`todo ${id} is a ${item.todo.kind}, not a ${kind}`);
          if (!OPEN.includes(item.todo.status)) {
            out.push(item.todo);
            continue;
          }
          item.todo = {
            ...item.todo,
            status: how.status ?? "done",
            resolved_by: how.by,
            resolved_at: at,
            ...(how.with !== undefined && { resolved_with: how.with }),
          };
          out.push(item.todo);
        }
        await tx.put(ITEMS, [...found.values()]);
        return out;
      }),
    );
  }

  async #topics(tenantId: string): Promise<Map<string, TaxonomyNode>> {
    return new Map((await this.store.topics(tenantId)).map((n) => [n.key, n]));
  }

  /**
   * The topic of a todo's units: the placement of its first claim (the proposed value of a
   * conflict, the governed value of a note), else the topic most of them are in; for a
   * document, the topic most of its statements are in. Its owner is the topic's, else the
   * nearest owner above it.
   */
  async #route(units: readonly string[], topics: ReadonlyMap<string, TaxonomyNode>): Promise<Route> {
    const claims = units.filter((u) => idKind(u) === "claim");
    let topic: string | undefined;
    if (claims.length) {
      const placed = new Map((await this.store.placementsOf(claims)).map((p) => [p.claim_id, p.taxonomy_key]));
      topic = placed.get(claims[0] as string) ?? majority([...placed.values()]);
    } else {
      const ids: string[] = [];
      for (const v of units.filter((u) => idKind(u) === "source_version")) {
        const spans = await this.store.spansOf(v);
        if (spans.length) ids.push(...(await this.store.claimsCiting(spans.map((s) => s.id))));
      }
      const placed: string[] = [];
      for (let i = 0; i < ids.length; i += 500) {
        placed.push(...(await this.store.placementsOf(ids.slice(i, i + 500))).map((p) => p.taxonomy_key));
      }
      topic = majority(placed);
    }
    const node = topic === undefined ? undefined : topics.get(topic);
    if (!node || node.status === "retired") return {};
    for (let n: TaxonomyNode | undefined = node; n; n = n.parent_key ? topics.get(n.parent_key) : undefined) {
      if (n.owner_id) return { topic: node.key, owner: n.owner_id };
    }
    return { topic: node.key };
  }

  async #spaceOf(units: readonly string[]): Promise<string | undefined> {
    for (const u of units) {
      if (idKind(u) === "source_version") return (await this.store.getSourceVersion(u))?.space_id;
      if (idKind(u) === "claim") return (await this.store.getClaims([u]))[0]?.space_id;
    }
    return undefined;
  }
}
