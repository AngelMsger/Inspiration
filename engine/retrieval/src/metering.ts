// What each answer cost and how long it took, with the member it was for and the spaces it
// read, for the usage page: never the question or the answer.

import { AsyncLocalStorage } from "node:async_hooks";
import type { ModelGateway, Money, Principal, TokenUsage } from "@inspiration/contracts";
import { defineTable } from "@inspiration/eventbus";
import type { Baseline } from "./search.ts";

/** One model call an answer made. */
export interface AnswerCall {
  operation: "complete" | "embed" | "rerank";
  /** A completion's task. */
  task?: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost: Money;
}

/** One answer given. */
export interface AnswerRecord {
  answer_id: string;
  tenant_id: string;
  /** The member it was for: the asker, or the member an agent asked for. */
  member_id: string;
  /** The agent that asked, when one did. */
  agent_id?: string;
  /** When it was asked, and that instant's month in UTC ("2026-11"), by which usage is read. */
  at: string;
  month: string;
  /** From the question to the answer, search included. */
  ms: number;
  /** The spaces of the sources it read; none when it found nothing. */
  space_ids: string[];
  /** What its calls cost together; absent when it made none. */
  cost?: Money;
  calls: AnswerCall[];
  /** What it read: as many passages and statements of what search found, or everything. */
  reads: { passages: number; statements: number } | "everything";
  baseline?: Baseline;
}

export const ANSWERS = defineTable<AnswerRecord>("retrieval.answers", {
  key: (a) => a.answer_id,
  columns: { tenant_id: (a) => a.tenant_id, month: (a) => a.month },
});

/**
 * The calls of the answer running now. An answer's calls are made deep in search, and several
 * answers run at once, so each call finds its answer through the async context rather than
 * through every signature on the way.
 */
const running = new AsyncLocalStorage<AnswerCall[]>();

/** The member the calls running now are charged to, as search and answers are. */
const charged = new AsyncLocalStorage<string>();

/** The member a principal's work is charged to: the member, or the one an agent acts for. */
export function memberOf(who: Principal): string | undefined {
  return who.kind === "agent" ? who.on_behalf_of : who.kind === "member" ? who.id : undefined;
}

/** What fn gives, each call it makes through a metered gateway charged to the principal's member. */
export function chargedTo<T>(who: Principal, fn: () => Promise<T>): Promise<T> {
  const member = memberOf(who);
  return member ? charged.run(member, fn) : fn();
}

/**
 * The gateway, each call charged to the member it is made for, if any, and counted for the
 * answer it is made for, if any.
 */
export function metered(models: ModelGateway): ModelGateway {
  const note = (call: Omit<AnswerCall, "input_tokens" | "output_tokens">, usage: TokenUsage) => {
    running.getStore()?.push({ ...call, input_tokens: usage.input_tokens, output_tokens: usage.output_tokens });
  };
  const charge = <R extends { member_id?: string }>(req: R): R => {
    const member = charged.getStore();
    return member && !req.member_id ? { ...req, member_id: member } : req;
  };
  return {
    async complete(req) {
      const done = await models.complete(charge(req));
      note(
        { operation: "complete", task: req.task, provider: done.provider, model: done.model, cost: done.cost },
        done.usage,
      );
      return done;
    },
    async embed(req) {
      const done = await models.embed(charge(req));
      note({ operation: "embed", provider: done.provider, model: done.model, cost: done.cost }, done.usage);
      return done;
    },
    async rerank(req) {
      const done = await models.rerank(charge(req));
      note({ operation: "rerank", provider: done.provider, model: done.model, cost: done.cost }, done.usage);
      return done;
    },
    ocr: (req) => models.ocr(req),
  };
}

/** What fn gives, and the calls it made through a metered gateway. */
export async function metering<T>(fn: () => Promise<T>): Promise<{ value: T; calls: AnswerCall[] }> {
  const calls: AnswerCall[] = [];
  const value = await running.run(calls, fn);
  return { value, calls };
}

/** The calls' cost together, in their currency; undefined without calls. */
export function costOf(calls: readonly AnswerCall[]): Money | undefined {
  const [first] = calls;
  if (!first) return undefined;
  const mixed = calls.find((c) => c.cost.currency !== first.cost.currency);
  if (mixed) throw new RangeError(`one answer's calls in ${first.cost.currency} and ${mixed.cost.currency}`);
  return { amount: calls.reduce((n, c) => n + c.cost.amount, 0), currency: first.cost.currency };
}
