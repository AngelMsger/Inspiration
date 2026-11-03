/**
 * The engine process. It wires the built components to one knowledge store, one blob store
 * and one event bus, and subscribes each component's handlers under its own consumer group:
 * source sync, normalization, extraction, governance, freshness, page-compiler's topics and
 * collaboration's inbox. tick() is its daily work: freshness publishes the reviews that fell due, and governance decides again the
 * slots in which a dated change took effect. With a database URL it runs on Postgres with
 * the transactional outbox, relayed to Valkey Streams when a Valkey URL is given; without
 * one, everything stays in memory.
 *
 * Corpus is the prototype's provisioning, standing in for the business layer: a corpus.yaml
 * declares a tenant, its spaces, sources and a stand-in directory. Runs over a corpus, their
 * reports and the checks against hand-written answers are the measurement harness's
 * (apps/bench).
 *
 * serve.ts runs the engine in memory over a corpus and serves its HTTP API (http.ts), version
 * 0, for the business layer's web app: `pnpm engine serve <corpus>`. The corpus stands in for
 * the business layer's directory (tenants and spaces by name) and its identity, which the
 * API takes from two development headers until principal tokens exist.
 *
 * Apps are composition roots: they may depend on any component; nothing depends on them but
 * the harness that measures this one.
 */

export { Corpus, CorpusError, type CorpusManifest } from "./corpus.ts";
export { Engine, type EngineOptions } from "./engine.ts";
export { apiHandler, type Directory, serveApi } from "./http.ts";
export { seed } from "./serve.ts";
