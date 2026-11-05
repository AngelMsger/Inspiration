// Admin › Usage: one month of the company's usage for its super admin, the measures the trial
// reports (docs/design/mvp.md): model cost against the budgets, answers and how long they took,
// and todos per 100 documents with what the assistant decided for people and left to them, in
// total, by day, by member and by space. Only counts, times and cost; never content.

import type { SpaceList, Usage, UsageDay } from "@inspiration/contracts";
import type { CompanyMember } from "@inspiration/contracts/business";
import { type ReactNode, useRef, useState } from "react";
import { api, type Loaded, useLoad } from "./api.ts";
import { Failure, Metric } from "./parts.tsx";
import {
  axisTop,
  budgetsOf,
  byCost,
  costPerAnswer,
  daysOf,
  dayText,
  moneyText,
  monthText,
  perHundred,
  recentMonths,
  secondsText,
  spentShare,
} from "./usage.ts";
import { useWords } from "./words.ts";

export function UsageScreen(props: {
  company: string;
  members: Loaded<{ members: CompanyMember[] }>;
  spaces: Loaded<SpaceList>;
}) {
  const { say, tag } = useWords();
  const [month, setMonth] = useState<string>();
  const usage = useLoad(`usage:${month ?? ""}`, () => api.usage(month));
  // Shown as it was while another month is read; the months offered run back from the current one.
  const last = useRef<Usage>(undefined);
  const current = useRef<string>(undefined);
  if (usage.state === "done") {
    last.current = usage.value;
    current.current ??= usage.value.month;
  }
  const shown = last.current;
  return (
    <>
      <div className="heading">
        <h1 className="title">{say("admin.usage")}</h1>
        {current.current && shown && (
          <select
            className="usage-month"
            value={shown.month}
            aria-label={say("usage.month")}
            onChange={(e) => setMonth(e.target.value)}
          >
            {recentMonths(current.current).map((m) => (
              <option key={m} value={m}>
                {monthText(tag, m)}
              </option>
            ))}
          </select>
        )}
      </div>
      {usage.state === "failed" && <Failure error={usage.error} />}
      {!shown && usage.state === "loading" && <p className="quiet">{say("usage.loading")}</p>}
      {shown && <Month usage={shown} company={props.company} members={props.members} spaces={props.spaces} />}
    </>
  );
}

function Month(props: {
  usage: Usage;
  company: string;
  members: Loaded<{ members: CompanyMember[] }>;
  spaces: Loaded<SpaceList>;
}) {
  const { say, tag } = useWords();
  const { usage } = props;
  const t = usage.totals;
  const money = (amount: number) => moneyText(tag, { amount, currency: t.cost.currency });
  const perAnswer = costPerAnswer(usage);
  const hundred = perHundred(t.todos, t.documents);
  const answersHint = [
    say("usage.from_apps", { count: t.agent_answers }),
    perAnswer && say("usage.per_answer", { cost: moneyText(tag, perAnswer) }),
  ];
  return (
    <>
      <p className="lede">{say("usage.lede", { company: props.company, zone: usage.time_zone })}</p>
      <div className="metrics">
        <Metric label={say("usage.cost")} value={moneyText(tag, t.cost)}>
          {say("usage.calls", { count: t.calls })}
        </Metric>
        <Metric label={say("usage.answers")} value={t.answers}>
          {answersHint.filter(Boolean).join(" · ")}
        </Metric>
        <Metric label={say("usage.time")} value={secondsText(tag, t.answer_ms_p50)}>
          {say("usage.time_hint", { p90: secondsText(tag, t.answer_ms_p90) })}
        </Metric>
        <Metric label={say("usage.per_hundred")} value={hundred ?? "–"}>
          {say("usage.todos_hint", { todos: t.todos, decided: t.decided, left: t.left, undone: t.undone })}
        </Metric>
        <Metric label={say("usage.documents")} value={t.documents ?? 0}>
          {say("usage.documents_hint", { read: t.documents_read ?? 0 })}
        </Metric>
      </div>
      <div className="usage-charts">
        <DayChart
          title={say("usage.cost_by_day")}
          month={usage.month}
          days={usage.days}
          value={(d) => d.cost.amount}
          text={money}
        />
        <DayChart
          title={say("usage.answers_by_day")}
          month={usage.month}
          days={usage.days}
          value={(d) => d.answers}
          text={String}
        />
      </div>
      <Budgets usage={usage} />
      <Members usage={usage} members={props.members} />
      <Spaces usage={usage} spaces={props.spaces} />
      <p className="quiet usage-note">{say("usage.footnote")}</p>
    </>
  );
}

/** One measure a day across the month, as columns on one scale, with a table of the same numbers. */
function DayChart(props: {
  title: string;
  month: string;
  days: UsageDay[];
  value: (day: UsageDay) => number;
  text: (n: number) => string;
}) {
  const { say, tag } = useWords();
  const [at, setAt] = useState<string>();
  const byDate = new Map(props.days.map((d) => [d.date, props.value(d)]));
  const top = axisTop(Math.max(0, ...byDate.values()));
  const all = daysOf(props.month);
  const pointed = at ?? props.days.at(-1)?.date;

  return (
    <figure className="usage-chart">
      <figcaption>
        <b>{props.title}</b>
        {pointed && (
          <span className="usage-readout">
            {dayText(tag, pointed)} <b>{props.text(byDate.get(pointed) ?? 0)}</b>
          </span>
        )}
      </figcaption>
      <div className="chart-plot" role="img" aria-label={props.title}>
        <span className="chart-top">{props.text(top)}</span>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: the pointer's readout; the table below says the same to keyboards and screen readers */}
        <div className="chart-columns" onMouseLeave={() => setAt(undefined)}>
          {all.map((date) => {
            const n = byDate.get(date);
            return (
              // biome-ignore lint/a11y/noStaticElementInteractions: as above, the table is the readout for keyboards
              <div key={date} className="chart-slot" onMouseEnter={() => n !== undefined && setAt(date)}>
                {n !== undefined && n > 0 && (
                  <div
                    className={date === pointed ? "chart-bar chart-bar-at" : "chart-bar"}
                    style={{ height: `${(n / top) * 100}%` }}
                  />
                )}
              </div>
            );
          })}
        </div>
        <div className="chart-days" aria-hidden>
          {all.map((date, i) => (
            <span key={date}>{i % 7 === 0 ? Number(date.slice(8)) : ""}</span>
          ))}
        </div>
      </div>
      <details className="chart-table">
        <summary>{say("usage.as_table")}</summary>
        <table className="files admin-table">
          <thead>
            <tr>
              <th>{say("usage.day")}</th>
              <th className="number">{props.title}</th>
            </tr>
          </thead>
          <tbody>
            {props.days.map((d) => (
              <tr key={d.date}>
                <td>{dayText(tag, d.date)}</td>
                <td className="number">{props.text(props.value(d))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

/** The budgets with a limit, as they stand now whichever month is shown. */
function Budgets(props: { usage: Usage }) {
  const { say, tag } = useWords();
  const lines = budgetsOf(props.usage);
  if (lines.length === 0) return null;
  return (
    <section className="usage-section">
      <h2>{say("usage.budgets")}</h2>
      <p className="quiet">{say("usage.budgets_hint")}</p>
      <div className="budgets">
        {lines.map(({ budget, component, words }) => {
          const what = words ? say(words) : (component ?? say("usage.budget.pooled"));
          const share = spentShare(budget);
          const money = (amount: number) => moneyText(tag, { amount, currency: budget.currency });
          const state = share >= 1 ? "budget-reached" : share >= 0.8 ? "budget-near" : "";
          return (
            <div key={budget.budget_key} className={`budget ${state}`}>
              <div className="budget-line">
                <span>{say(`usage.period.${budget.period}`, { what })}</span>
                <span className="number">
                  {say("usage.budget.spent", { spent: money(budget.spent), limit: money(budget.limit ?? 0) })}
                  {state && (
                    <b className="budget-flag"> {say(share >= 1 ? "usage.budget.reached" : "usage.budget.near")}</b>
                  )}
                </span>
              </div>
              <div className="meter">
                <div className="meter-fill" style={{ width: `${share * 100}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Members(props: { usage: Usage; members: Loaded<{ members: CompanyMember[] }> }) {
  const { say, tag } = useWords();
  const people = props.members.state === "done" ? props.members.value.members : [];
  const name = (id: string) => people.find((m) => m.member_id === id)?.display_name ?? say("usage.former_member");
  const used = new Set(props.usage.by_member.map((m) => m.member_id));
  const idle = people.filter((m) => !used.has(m.member_id)).map((m) => m.display_name);
  const money = (amount: number) => moneyText(tag, { amount, currency: props.usage.totals.cost.currency });
  return (
    <section className="usage-section">
      <h2>{say("usage.by_member")}</h2>
      {props.usage.by_member.length > 0 && (
        <Table
          head={[say("usage.member"), say("usage.answers"), say("usage.apps"), say("usage.median"), say("usage.cost")]}
          rows={byCost(props.usage.by_member).map((m) => ({
            key: m.member_id,
            cells: [
              name(m.member_id),
              m.answers,
              m.agent_answers,
              secondsText(tag, m.answer_ms_p50),
              money(m.cost.amount),
            ],
            row: m,
          }))}
        />
      )}
      {idle.length > 0 && <p className="quiet">{say("usage.idle", { names: idle.join(say("list.mark")) })}</p>}
    </section>
  );
}

function Spaces(props: { usage: Usage; spaces: Loaded<SpaceList> }) {
  const { say, tag } = useWords();
  const spaces = props.spaces.state === "done" ? props.spaces.value.spaces : [];
  const name = (id: string) => spaces.find((s) => s.id === id)?.name ?? say("usage.removed_space");
  const money = (amount: number) => moneyText(tag, { amount, currency: props.usage.totals.cost.currency });
  if (props.usage.by_space.length === 0) return null;
  return (
    <section className="usage-section">
      <h2>{say("usage.by_space")}</h2>
      <Table
        head={[
          say("usage.space"),
          say("usage.documents_read"),
          say("usage.per_hundred"),
          say("usage.answers"),
          say("usage.cost"),
        ]}
        rows={byCost(props.usage.by_space).map((s) => ({
          key: s.space_id,
          cells: [
            name(s.space_id),
            say("usage.read_of", { read: s.documents_read ?? 0, documents: s.documents ?? 0 }),
            perHundred(s.todos, s.documents) ?? "–",
            s.answers,
            money(s.cost.amount),
          ],
          row: s,
        }))}
      />
    </section>
  );
}

/** A table of rows whose first cell names them, then their figures and what the inbox asked of them. */
function Table(props: {
  head: string[];
  rows: { key: string; cells: ReactNode[]; row: { todos: number; decided: number; left: number; undone: number } }[];
}) {
  const { say } = useWords();
  return (
    <div className="usage-table">
      <table className="files admin-table">
        <thead>
          <tr>
            {props.head.map((h, i) => (
              <th key={h} className={i > 0 ? "number" : undefined}>
                {h}
              </th>
            ))}
            <th className="number">{say("usage.todos")}</th>
            <th className="number">{say("usage.decided")}</th>
            <th className="number">{say("usage.left")}</th>
            <th className="number">{say("usage.undone")}</th>
          </tr>
        </thead>
        <tbody>
          {props.rows.map((r) => (
            <tr key={r.key}>
              {r.cells.map((c, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a row's cells are its columns, in order
                <td key={i} className={i > 0 ? "number" : undefined}>
                  {c}
                </td>
              ))}
              <td className="number">{r.row.todos}</td>
              <td className="number">{r.row.decided}</td>
              <td className="number">{r.row.left}</td>
              <td className="number">{r.row.undone}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
