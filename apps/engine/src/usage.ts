// The usage page's numbers (GET /v0/usage, the super admin's): one month of a company's model
// cost against its budgets, its answers and how long they took, and what the inbox asked of
// people and the assistant decided for them, in total, by member, by space and by day. Only
// counts, times and cost: never a question, an answer, a document or a topic.

import type { MemberUsage, Money, Principal, SpaceUsage, Usage, UsageDay, UsageRow } from "@inspiration/contracts";
import { dayIn, periodStart } from "@inspiration/model-gateway";
import { ANSWERS, type AnswerRecord } from "@inspiration/retrieval";
import type { Engine } from "./engine.ts";
import { badRequest, forbidden, notFound } from "./http-errors.ts";
import { readingOf } from "./reading.ts";

const MONTH = /^([0-9]{4})-(0[1-9]|1[0-2])$/;

/** The components whose model calls a company pays for, by their budget keys (tenant:<id>/<component>). */
const CHARGED = ["extraction", "retrieval", "page-compiler"] as const;

/** One row's sums while they are counted. */
interface Tally {
  cost: number;
  calls: number;
  ms: number[];
  agent: number;
  todos: number;
  decided: number;
  left: number;
  undone: number;
}

const tally = (): Tally => ({ cost: 0, calls: 0, ms: [], agent: 0, todos: 0, decided: 0, left: 0, undone: 0 });

/** The month after "2026-11", as "2026-12". */
function after(month: string): string {
  const [year, m] = month.split("-").map(Number) as [number, number];
  return m === 12 ? `${year + 1}-01` : `${year}-${String(m + 1).padStart(2, "0")}`;
}

/** The nearest-rank percentile of the values, which are sorted. */
const percentile = (sorted: readonly number[], p: number) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];

/** The company's usage in a month (the current one unless asked), for its super admin only. */
export async function usage(engine: Engine, who: Principal, asked?: string): Promise<Usage> {
  const ledger = engine.ledger;
  if (!ledger) throw notFound("usage: this engine keeps no ledger");
  const admin = await engine.authz.check(who, "admin", { type: "tenant", id: who.tenant_id });
  if (!admin.allow) throw forbidden("only the super admin reads usage");
  const tenantId = who.tenant_id;
  const zone = ledger.timeZone;
  const today = dayIn(engine.clock(), zone);
  const month = asked ?? today.slice(0, 7);
  if (!MONTH.test(month)) throw badRequest(`month ${month} is not a month such as 2026-11`);
  // Mid-month is inside the month in every zone, so its period starts on the zone's first.
  const from = periodStart("month", new Date(`${month}-15T00:00:00Z`), zone) as Date;
  const until = periodStart("month", new Date(`${after(month)}-15T00:00:00Z`), zone) as Date;
  const within = (at: string) => {
    const t = new Date(at);
    return t >= from && t < until;
  };

  const totals = tally();
  const members = new Map<string, Tally>();
  const spaces = new Map<string, Tally>();
  for (const s of await engine.directory.spaces(tenantId)) spaces.set(s.id, tally());
  // A todo's assignee may be a group; only members have rows.
  const of = (rows: Map<string, Tally>, id: string | undefined) => {
    if (!id || (rows === members && !id.startsWith("mem_"))) return [];
    if (!rows.has(id)) rows.set(id, tally());
    return [rows.get(id) as Tally];
  };
  const days = new Map<string, { cost: number; answers: number }>();
  const day = (date: string) => {
    if (!days.has(date)) days.set(date, { cost: 0, answers: 0 });
    return days.get(date) as { cost: number; answers: number };
  };

  for (const c of await ledger.usage.charges(tenantId, from, until, zone)) {
    for (const t of [totals, ...of(members, c.member_id), ...of(spaces, c.space_id)]) {
      t.cost += c.cost;
      t.calls += c.calls;
    }
    day(c.date).cost += c.cost;
  }
  for (const a of await answersIn(engine, tenantId, from, until)) {
    for (const t of [totals, ...of(members, a.member_id), ...a.space_ids.flatMap((s) => of(spaces, s))]) {
      t.ms.push(a.ms);
      if (a.agent_id) t.agent++;
    }
    day(dayIn(new Date(a.at), zone)).answers++;
  }
  for (const item of await engine.inbox.items(tenantId)) {
    const rows = [totals, ...of(members, item.todo.assignee_id), ...of(spaces, item.todo.space_id)];
    if (within(item.todo.created_at)) for (const t of rows) t.todos++;
    if (item.left && item.left.why !== "undone" && within(item.left.at)) for (const t of rows) t.left++;
  }
  for (const d of await engine.assistant.decisions(tenantId)) {
    if (!within(d.decided_at)) continue;
    for (const t of [totals, ...of(members, d.decided_by), ...of(spaces, d.todo.space_id)]) {
      t.decided++;
      if (d.undone_at) t.undone++;
    }
  }

  const money = (amount: number): Money => ({ amount: Number(amount.toFixed(8)), currency: ledger.config.currency });
  const row = (t: Tally): UsageRow => {
    const ms = [...t.ms].sort((a, b) => a - b);
    return {
      cost: money(t.cost),
      calls: t.calls,
      answers: ms.length,
      agent_answers: t.agent,
      ...(ms.length && { answer_ms_p50: percentile(ms, 0.5), answer_ms_p90: percentile(ms, 0.9) }),
      todos: t.todos,
      decided: t.decided,
      left: t.left,
      undone: t.undone,
    };
  };
  const documents = new Map<string, { documents: number; documents_read: number }>();
  for (const spaceId of spaces.keys()) documents.set(spaceId, await documentsIn(engine, tenantId, spaceId));
  const sorted = <T>(rows: Map<string, T>) => [...rows].sort(([a], [b]) => (a < b ? -1 : 1));
  const counted = [...documents.values()];

  return {
    tenant_id: tenantId,
    month,
    time_zone: zone,
    budgets: await ledger.budgetStatus(CHARGED.map((c) => `tenant:${tenantId}/${c}`)),
    totals: {
      ...row(totals),
      documents: counted.reduce((n, d) => n + d.documents, 0),
      documents_read: counted.reduce((n, d) => n + d.documents_read, 0),
    },
    by_member: sorted(members).map(([member_id, t]): MemberUsage => ({ member_id, ...row(t) })),
    by_space: sorted(spaces).map(
      ([space_id, t]): SpaceUsage => ({
        space_id,
        ...row(t),
        ...(documents.get(space_id) ?? { documents: 0, documents_read: 0 }),
      }),
    ),
    days: datesOf(month, today).map((date): UsageDay => {
      const d = days.get(date);
      return { date, cost: money(d?.cost ?? 0), answers: d?.answers ?? 0 };
    }),
  };
}

/** The answers the company gave from from to until, the baselines measured against them aside. */
async function answersIn(engine: Engine, tenantId: string, from: Date, until: Date): Promise<AnswerRecord[]> {
  // Records are kept by UTC month, and a month in a zone spans two of them.
  const months = [...new Set([from, new Date(until.getTime() - 1)].map((d) => d.toISOString().slice(0, 7)))];
  const found = await Promise.all(months.map((month) => engine.records.find(ANSWERS, { tenant_id: tenantId, month })));
  return found.flat().filter((a) => {
    const at = new Date(a.at);
    return !a.baseline && at >= from && at < until;
  });
}

/** How many documents a space has at their latest versions, and how many of them are read. */
async function documentsIn(engine: Engine, tenantId: string, spaceId: string) {
  const { documents } = await engine.sync.documents(tenantId, spaceId);
  const readings = await readingOf(
    engine,
    tenantId,
    documents.map((d) => d.version),
  );
  return { documents: documents.length, documents_read: readings.filter((r) => r === undefined).length };
}

/** Every date of the month up to last, as "2026-11-01". */
function datesOf(month: string, last: string): string[] {
  const [year, m] = month.split("-").map(Number) as [number, number];
  const length = new Date(Date.UTC(year, m, 0)).getUTCDate();
  return Array.from({ length }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`).filter((d) => d <= last);
}
