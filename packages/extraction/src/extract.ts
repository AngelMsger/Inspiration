import {
  type BlocksChanged,
  type ChatMessage,
  type Claim,
  type ClaimEvidence,
  type ClaimsUpdated,
  contentHash,
  type EventEnvelope,
  type EventHandler,
  GatewayException,
  type KnowledgeStore,
  type ModelGateway,
  newEvent,
  type ProducerInfo,
  payloadOf,
  type SourceBlock,
  type SourceVersion,
  type Span,
  slotOf,
  stableId,
} from "@inspiration/contracts";
import { logger } from "@inspiration/kernel";
import { PromptRegistry } from "@inspiration/model-gateway";
import {
  type ExtractedClaim,
  OUTPUT_SCHEMA,
  PROMPT_VERSION,
  TASK,
  type WindowBlock,
  type WindowInput,
  type WindowOutput,
} from "./protocol.ts";
import type { Vocabulary } from "./vocabulary.ts";

const log = logger("extraction");

export const COMPONENT = "extraction";

/** Characters of passage text per model call. */
export const WINDOW_CHARS = 1500;
/** Statement similarity at which a claim from an edited block replaces one that lost its evidence. */
export const SAME_CLAIM = 0.5;

const PROMPTS_DIR = new URL("../prompts/", import.meta.url).pathname;

export interface ExtractionOptions {
  store: KnowledgeStore;
  models: ModelGateway;
  /** Defaults to the prompts shipped in this package. */
  prompts?: PromptRegistry;
  /** The tenant's predicate catalogue, if it has one. */
  vocabulary?: (tenantId: string) => Vocabulary | undefined | Promise<Vocabulary | undefined>;
  clock?: () => Date;
  windowChars?: number;
}

export interface ExtractionResult {
  /** Model calls, and those whose output stayed invalid after the gateway's retry. */
  windows: number;
  failed_windows: number;
  added: string[];
  superseded: string[];
  retracted: string[];
  /** Claims the model returned without a verbatim quote from a span it was given. */
  rejected: number;
}

interface Built {
  claim: Claim;
  evidence: ClaimEvidence[];
  /** The blocks of the spans it cites. */
  blocks: Set<string>;
}

interface Window {
  blocks: WindowBlock[];
  /** Local span reference to span. */
  spans: Map<string, Span>;
  text: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The start of a YYYY-MM-DD day, in UTC: the engine knows no tenant time zone yet. */
function dayStart(day: unknown): string | undefined {
  return typeof day === "string" && DAY.test(day) && !Number.isNaN(Date.parse(day)) ? `${day}T00:00:00Z` : undefined;
}

/** Dice similarity of character bigrams. */
function similarity(a: string, b: string): number {
  const grams = (s: string) => {
    const out = new Map<string, number>();
    for (let i = 0; i + 1 < s.length; i++) out.set(s.slice(i, i + 2), (out.get(s.slice(i, i + 2)) ?? 0) + 1);
    return out;
  };
  const x = grams(a);
  const y = grams(b);
  let shared = 0;
  for (const [g, n] of x) shared += Math.min(n, y.get(g) ?? 0);
  const total = Math.max(a.length - 1, 0) + Math.max(b.length - 1, 0);
  return total ? (2 * shared) / total : a === b ? 1 : 0;
}

export class Extraction {
  readonly store: KnowledgeStore;
  readonly models: ModelGateway;
  readonly prompts: PromptRegistry;
  readonly clock: () => Date;
  readonly windowChars: number;
  /** Totals since the process started, for run reports. */
  readonly totals = { windows: 0, failed_windows: 0, rejected: 0 };
  readonly #vocabulary: NonNullable<ExtractionOptions["vocabulary"]>;
  readonly #running = new Map<string, Promise<unknown>>();

  constructor(options: ExtractionOptions) {
    this.store = options.store;
    this.models = options.models;
    this.clock = options.clock ?? (() => new Date());
    this.windowChars = options.windowChars ?? WINDOW_CHARS;
    this.#vocabulary = options.vocabulary ?? (() => undefined);
    if (options.prompts) {
      this.prompts = options.prompts;
    } else {
      this.prompts = new PromptRegistry();
      this.prompts.loadDir(PROMPTS_DIR);
    }
  }

  get producer(): ProducerInfo {
    return { component: COMPONENT, name: "extract_claims", version: PROMPT_VERSION };
  }

  /**
   * Extract claims from a version's added and changed blocks, and close the claims whose
   * evidence the version removed: superseded by a new claim of the same slot or a similar
   * statement from the same block, retracted otherwise. Doing it again changes nothing.
   * Versions of one document are handled one at a time. Given the blocks.changed event,
   * claims.updated carries on its correlation.
   */
  async extract(change: BlocksChanged, cause?: EventEnvelope): Promise<ExtractionResult> {
    const version = await this.store.getSourceVersion(change.source_version_id);
    if (!version) throw new RangeError(`unknown source version ${change.source_version_id}`);
    const key = `${version.source_id}\x1f${version.external_id}`;
    const before = this.#running.get(key) ?? Promise.resolve();
    const run = before.catch(() => undefined).then(() => this.#extract(version, change, cause));
    this.#running.set(key, run);
    try {
      return await run;
    } finally {
      if (this.#running.get(key) === run) this.#running.delete(key);
    }
  }

  readonly onBlocksChanged: EventHandler = async (event: EventEnvelope) => {
    await this.extract(payloadOf(event, "blocks.changed"), event);
  };

  handlers(): Record<string, EventHandler> {
    return { "blocks.changed": this.onBlocksChanged };
  }

  async #extract(version: SourceVersion, change: BlocksChanged, cause?: EventEnvelope): Promise<ExtractionResult> {
    const result: ExtractionResult = {
      windows: 0,
      failed_windows: 0,
      added: [],
      superseded: [],
      retracted: [],
      rejected: 0,
    };
    const extracted: Built[] = [];
    const targets = new Set([...change.added_block_ids, ...change.changed_block_ids]);
    if (!change.deleted && targets.size) {
      const vocabulary = (await this.#vocabulary(version.tenant_id))?.predicates ?? [];
      for (const window of await this.#windows(version, targets)) {
        result.windows++;
        const output = await this.#complete(version, window, vocabulary);
        if (!output) {
          result.failed_windows++;
          continue;
        }
        for (const claim of output.claims) {
          const built = this.#build(version, window, claim);
          if (built) extracted.push(built);
          else result.rejected++;
        }
      }
    }

    this.totals.windows += result.windows;
    this.totals.failed_windows += result.failed_windows;
    this.totals.rejected += result.rejected;
    const byId = new Map(extracted.map((e) => [e.claim.id, e]));
    const stored = new Set((await this.store.getClaims([...byId.keys()])).map((c) => c.id));
    const fresh = [...byId.values()].filter((e) => !stored.has(e.claim.id));
    const lost = await this.#lost(change.removed_span_ids, [...byId.values()]);
    const restated = await this.#restated(fresh, new Set(byId.keys()));
    const closing = [...new Map([...lost, ...restated].map((c) => [c.claim.id, c])).values()];
    const now = this.clock().toISOString();
    for (const { claim, by } of closing) (by ? result.superseded : result.retracted).push(claim.id);
    result.added = fresh.map((e) => e.claim.id);
    if (!fresh.length && !closing.length) return result;

    const payload: ClaimsUpdated = {
      origin: "extracted",
      added: result.added,
      updated: [],
      superseded: [...result.superseded, ...result.retracted].sort(),
      source_version_id: version.id,
    };
    const event = newEvent("claims.updated", payload, {
      tenantId: version.tenant_id,
      producer: COMPONENT,
      subject: `${version.source_id}:${version.external_id}`,
      ...(cause && { causation: cause }),
      occurredAt: this.clock(),
    });
    await this.store.transaction(async (tx) => {
      if (fresh.length) {
        await tx.upsertClaims(
          fresh.map((e) => e.claim),
          fresh.flatMap((e) => e.evidence),
        );
      }
      for (const { claim, by } of closing) {
        if (by) {
          await tx.supersede(claim.id, by, `evidence removed in ${version.id}`);
        } else {
          await tx.upsertClaims([{ ...claim, status: "retracted", superseded_at: now, updated_at: now }], []);
        }
      }
      await tx.publish(event);
    });
    log.debug("extracted claims", {
      source_version: version.id,
      windows: result.windows,
      added: result.added.length,
      superseded: result.superseded.length,
      retracted: result.retracted.length,
      rejected: result.rejected,
    });
    return result;
  }

  /** Target blocks in reading order, cut into windows of about windowChars characters. */
  async #windows(version: SourceVersion, targets: ReadonlySet<string>): Promise<Window[]> {
    const blocks = (await this.store.blocksOf(version.id)).sort((a, b) => a.ordinal - b.ordinal);
    // A table row is read with its table's header row, which is never sent on its own; a
    // changed header changes how every row of its table reads.
    const headerRows = new Map<string, SourceBlock>();
    for (const b of blocks) {
      if (b.kind !== "table_row" || !b.parent_id || headerRows.has(b.parent_id)) continue;
      const table = blocks.find((t) => t.id === b.parent_id);
      if (Number(table?.attrs?.header_rows ?? 0) > 0) headerRows.set(b.parent_id, b);
    }
    const headerIds = new Set([...headerRows.values()].map((b) => b.id));
    const rereadTables = new Set([...headerRows].filter(([, h]) => targets.has(h.id)).map(([table]) => table));
    const wanted = blocks.filter(
      (b) => (targets.has(b.id) || (b.parent_id !== undefined && rereadTables.has(b.parent_id))) && b.span_ids.length,
    );
    const needed = [...new Set([...wanted, ...headerRows.values()].flatMap((b) => b.span_ids))];
    const spans = new Map((await this.store.getSpans(needed)).map((s) => [s.id, s]));
    const textOf = (b: SourceBlock) => b.span_ids.map((id) => spans.get(id)?.text ?? "");

    const windows: Window[] = [];
    let current: Window = { blocks: [], spans: new Map(), text: "" };
    for (const b of wanted) {
      if (headerIds.has(b.id)) continue;
      const length = textOf(b).join("").length;
      if (current.blocks.length && current.text.length + length > this.windowChars) {
        windows.push(current);
        current = { blocks: [], spans: new Map(), text: "" };
      }
      const block: WindowBlock = { kind: b.kind, heading_path: b.heading_path ?? [], spans: [] };
      const header = b.kind === "table_row" && b.parent_id ? headerRows.get(b.parent_id) : undefined;
      if (b.kind === "table_row") block.header = header ? textOf(header).map((t) => t.trim()) : [];
      for (const id of b.span_ids) {
        const span = spans.get(id);
        if (!span) continue;
        const ref = `s${current.spans.size + 1}`;
        current.spans.set(ref, span);
        block.spans.push({ ref, text: span.text });
      }
      current.blocks.push(block);
      current.text += `${[...block.heading_path, ...(block.header ?? []), ...block.spans.map((s) => s.text)].join("\n")}\n`;
    }
    if (current.blocks.length) windows.push(current);
    return windows;
  }

  async #complete(
    version: SourceVersion,
    window: Window,
    vocabulary: Vocabulary["predicates"],
  ): Promise<WindowOutput | undefined> {
    const title = version.title ?? version.external_id;
    const named = `${title}\n${window.text}`;
    const input: WindowInput = {
      document: {
        title,
        ...(version.language && { language: version.language }),
        ...(dayStart(version.metadata?.extra?.date) && { date: version.metadata?.extra?.date as string }),
      },
      vocabulary: vocabulary.filter((e) => e.aliases.some((a) => named.includes(a))),
      blocks: window.blocks,
    };
    try {
      const completion = await this.models.complete({
        task: TASK,
        prompt_version: PROMPT_VERSION,
        messages: this.prompts.render(TASK, PROMPT_VERSION, { input: JSON.stringify(input) }) as [
          ChatMessage,
          ...ChatMessage[],
        ],
        response_schema: OUTPUT_SCHEMA,
        tier: "flash",
        sensitivity: version.sensitivity,
        budget_key: `tenant:${version.tenant_id}/${COMPONENT}`,
        tenant_id: version.tenant_id,
        temperature: 0,
        metadata: { source_version_id: version.id },
      });
      return completion.json as WindowOutput;
    } catch (e) {
      // A window the model cannot answer validly is skipped; budgets and outages are retried.
      if (e instanceof GatewayException && e.code === "invalid_output") {
        log.warn("no valid claims for a window", { source_version: version.id, error: e.message });
        return undefined;
      }
      throw e;
    }
  }

  /** The claim and its evidence, or undefined when no quote is verbatim from a given span. */
  #build(version: SourceVersion, window: Window, extracted: ExtractedClaim): Built | undefined {
    const cited = extracted.evidence.flatMap((e) => {
      const span = window.spans.get(e.span);
      const start = span?.text.indexOf(e.quote) ?? -1;
      return span && start >= 0 ? [{ span, quote: e.quote, start }] : [];
    });
    if (!cited.length) return undefined;
    const spanIds = [...new Set(cited.map((c) => c.span.id))].sort();
    const statement = extracted.statement.trim();
    const id = stableId("claim", version.tenant_id, PROMPT_VERSION, statement, ...spanIds);
    const confidence = extracted.confidence ?? 0.7;
    const authority = version.authority ?? 0.5;
    const now = this.clock().toISOString();
    const claim: Claim = {
      id,
      tenant_id: version.tenant_id,
      space_id: version.space_id,
      statement,
      claim_type: extracted.claim_type,
      knowledge_class: extracted.knowledge_class ?? "general",
      valid_time: {},
      recorded_at: now,
      confidence,
      authority,
      weight: Number((authority * confidence).toFixed(4)),
      status: "active",
      origin: "extracted",
      sensitivity: version.sensitivity,
      producer: this.producer,
      inputs_hash: contentHash(JSON.stringify([PROMPT_VERSION, statement, cited.map((c) => [c.span.id, c.quote])])),
      created_at: now,
      updated_at: now,
    };
    const start = dayStart(extracted.valid_from) ?? dayStart(version.metadata?.extra?.effective_from);
    if (start) claim.valid_time = { start };
    if (version.language) claim.language = version.language;
    if (extracted.subject) claim.subject_text = extracted.subject;
    if (extracted.predicate) claim.predicate = extracted.predicate;
    if (extracted.value) claim.value = extracted.value;
    if (extracted.qualifiers?.length) claim.qualifiers = extracted.qualifiers;
    const evidence = cited.map(
      (c): ClaimEvidence => ({
        claim_id: id,
        span_id: c.span.id,
        source_version_id: c.span.source_version_id,
        role: "supports",
        quote: c.quote,
        quote_start: c.start,
        quote_end: c.start + c.quote.length,
      }),
    );
    const blocks = new Set(cited.flatMap((c) => (c.span.block_id ? [c.span.block_id] : [])));
    return { claim, evidence, blocks };
  }

  /**
   * Current claims that a new claim restates: it cites exactly the same spans, but says it
   * differently (a changed table header, another prompt version).
   */
  async #restated(fresh: readonly Built[], extracted: ReadonlySet<string>): Promise<{ claim: Claim; by: string }[]> {
    const spansOf = (e: readonly ClaimEvidence[]) =>
      e
        .filter((x) => x.role === "supports")
        .map((x) => x.span_id)
        .sort()
        .join("\x1f");
    const bySpans = new Map(fresh.map((f) => [spansOf(f.evidence), f.claim.id]));
    const cited = [...new Set(fresh.flatMap((f) => f.evidence.map((e) => e.span_id)))];
    if (!cited.length) return [];
    const current = (await this.store.getClaims(await this.store.claimsCiting(cited))).filter(
      (c) => c.superseded_at === undefined && !extracted.has(c.id),
    );
    if (!current.length) return [];
    const evidence = await this.store.evidenceOf(current.map((c) => c.id));
    return current.flatMap((claim) => {
      const by = bySpans.get(spansOf(evidence.filter((e) => e.claim_id === claim.id)));
      return by ? [{ claim, by }] : [];
    });
  }

  /**
   * Current claims whose every supporting span was removed, each with the new claim that
   * replaces it, if any: one of the same slot, else the most similar statement cut from the
   * same block.
   */
  async #lost(
    removedSpanIds: readonly string[],
    extracted: readonly Built[],
  ): Promise<{ claim: Claim; by?: string }[]> {
    if (!removedSpanIds.length) return [];
    const removed = new Set(removedSpanIds);
    const candidates = (await this.store.getClaims(await this.store.claimsCiting(removedSpanIds))).filter(
      (c) => c.superseded_at === undefined,
    );
    if (!candidates.length) return [];
    const evidence = await this.store.evidenceOf(candidates.map((c) => c.id));
    const support = new Map<string, string[]>();
    for (const e of evidence) {
      if (e.role === "supports") support.set(e.claim_id, [...(support.get(e.claim_id) ?? []), e.span_id]);
    }
    const lost = candidates.filter((c) => (support.get(c.id) ?? []).every((id) => removed.has(id)));
    const blockOf = new Map(
      (await this.store.getSpans([...new Set(lost.flatMap((c) => support.get(c.id) ?? []))])).map((s) => [
        s.id,
        s.block_id,
      ]),
    );
    return lost.map((old) => {
      const slot = slotOf(old);
      const blocks = new Set((support.get(old.id) ?? []).map((id) => blockOf.get(id)));
      let by = slot ? extracted.find((e) => e.claim.id !== old.id && slotOf(e.claim) === slot)?.claim.id : undefined;
      if (!by) {
        let best = SAME_CLAIM;
        for (const e of extracted) {
          const sameBlock = [...e.blocks].some((id) => blocks.has(id));
          const score = sameBlock ? similarity(old.statement, e.claim.statement) : 0;
          if (score >= best && e.claim.id !== old.id) [by, best] = [e.claim.id, score];
        }
      }
      return by ? { claim: old, by } : { claim: old };
    });
  }
}
