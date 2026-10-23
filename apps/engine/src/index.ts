/**
 * The engine process. It wires the built components to one knowledge store, one blob store
 * and one event bus, and subscribes each component's handlers under its own consumer group:
 * source sync (source.changed) and normalization (document.fetched). With a database URL it
 * runs on Postgres with the transactional outbox, relayed to Valkey Streams when a Valkey
 * URL is given; without one, everything stays in memory.
 *
 * Corpus and ingest are the prototype's batch entry: a corpus.yaml declares a tenant, its
 * spaces, sources and a stand-in directory; ingest syncs every source once, delivers all
 * events and reports the volumes (documents, blocks and spans by kind, parse outcomes,
 * duplicates, unmapped ACL entries). The CLI runs it: `pnpm engine ingest examples/corpus`.
 * synthesize writes a larger synthetic tenant with a ground-truth list of the facts its
 * documents state, current, stale or wrong, for scale runs and for measuring later stages.
 *
 * Apps are composition roots: they may depend on any component; nothing depends on them.
 */

export { Corpus, CorpusError, type CorpusManifest } from "./corpus.ts";
export { Engine, type EngineOptions } from "./engine.ts";
export { type IngestReport, ingest, plantedDuplicates, type Spread, summary } from "./ingest.ts";
export { FACTS, type Stated, type Synthesis, type SynthesisOptions, synthesize } from "./synthesize.ts";
