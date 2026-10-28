/**
 * The measurement harness: runs the engine process (@inspiration/engine) over a corpus on
 * disk and reports what it produced, so the prototype can be sized and checked against
 * answers written by hand. Nothing in the product depends on it.
 *
 * ingest syncs every source of a corpus once, delivers all events and reports the volumes
 * (documents, blocks and spans by kind, parse outcomes, duplicates, unmapped ACL entries,
 * claims, conflicts, review clocks, the topic outline, the inbox). Topic owners stand in for
 * the business layer's: each topic gets the member who owns most of its documents
 * (assignOwners).
 * The CLI runs it:
 * `pnpm bench ingest examples/corpus`. synthesize writes a larger synthetic tenant with a
 * ground-truth list of the facts its documents state, current, stale or wrong, for scale
 * runs and for measuring later stages; edit changes a share of it in place, and days()
 * runs the daily tick over simulated days. A corpus with an expected.yaml gets the control
 * check (controlReport): per case, which slot each statement lands in, each value's
 * independent sources with copies counted once, the proposed value and what becomes of the
 * others, against the answers and the engine's recorded gaps (examples/control). A corpus
 * with a history.yaml can be replayed (replay, `pnpm bench replay`): the real versions of a
 * document, one at a time on their own dates, with what governance led with after each,
 * against timeline.yaml's answers and recorded gaps (examples/gitlab-expenses).
 *
 * With --gateway the CLI runs on real models (config/gateway.deepseek.yaml) and reports what
 * the calls cost by task and by answering path (costReport); --dry-run prices the same run
 * with stand-ins first. A corpus with a keys.yaml also gets the reading check
 * (readingReport): which keyed statements extraction put in their slot, and which values it
 * put there that no key gives.
 *
 * Every paid run leaves a log in apps/bench/runs, and its replies outlive the container:
 * `pnpm bench cache export` writes the gateway's response cache to a file (exportReplies) and
 * `cache import` reads it back (importReplies), so the next run pays only for new calls.
 *
 * It is the one app that depends on another: components.yaml lists the engine under its
 * `uses`, and nothing else may depend on an app.
 */

export {
  type CaseResult,
  type Control,
  type ControlCase,
  ControlError,
  type ControlReport,
  controlLines,
  controlReport,
  loadControl,
  type SlotOutcome,
  type ValueCounts,
} from "./control.ts";
export { type CostReport, costLines, costReport, RunUsage, type Spend, spendOf, usageSince } from "./cost.ts";
export { type DaysReport, days, type FreshnessReport, SimulatedClock } from "./freshness.ts";
export {
  type History,
  HistoryError,
  type HistoryStep,
  inEffect,
  loadHistory,
  loadTimeline,
  type ReplayReport,
  replay,
  replayLines,
  type SlotCheck,
  type SlotState,
  type StepResult,
  type Timeline,
  type TimelineEntry,
} from "./history.ts";
export { type InboxReport, inboxReport } from "./inbox.ts";
export { daysSummary, type IngestReport, ingest, plantedDuplicates, type Spread, summary } from "./ingest.ts";
export { type OutlineReport, type OutlineRun, outlineReport } from "./outline.ts";
export { assignOwners, type OwnersReport } from "./owners.ts";
export {
  type FactKey,
  type Keys,
  type KeyValue,
  type Kind,
  loadKeys,
  loadQuestions,
  type Outcome,
  type Question,
  type QuestionResult,
  QuestionsError,
  type QuestionsReport,
  questionLines,
  questionsReport,
  type Score,
  type SearchReport,
  type SearchResult,
  type SearchTally,
  sampleQuestions,
  says,
  searchLines,
  searchReport,
  type Tally,
  valueOn,
} from "./questions.ts";
export { type FactReading, type ReadingReport, readingLines, readingReport } from "./reading.ts";
export { exportReplies, importReplies } from "./replies.ts";
export {
  type EditOptions,
  type Edits,
  edit,
  type Stated,
  type Synthesis,
  type SynthesisOptions,
  synthesize,
} from "./synthesize.ts";
