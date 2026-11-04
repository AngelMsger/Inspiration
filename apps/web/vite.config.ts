// The web app's development server: the React page, its language packs, and the stand-in for
// its backend (backend.ts) in front of the engine's HTTP API.

import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { parse } from "yaml";
import { backend, loadPeople } from "./src/backend.ts";
import { Updates } from "./src/updates.ts";

/** A language pack (languages/<tag>.yaml) imported as a module of its words. */
const languagePacks: Plugin = {
  name: "inspiration-language-packs",
  transform(code, id) {
    if (!id.endsWith(".yaml")) return undefined;
    return { code: `export default ${JSON.stringify(parse(code))};`, map: null };
  },
};

/** The development backend, as middleware of the Vite server. */
const devBackend: Plugin = {
  name: "inspiration-dev-backend",
  configureServer(server) {
    const people =
      process.env.INSPIRATION_PEOPLE ?? fileURLToPath(new URL("../../examples/corpus/people.yaml", import.meta.url));
    const engine = process.env.INSPIRATION_ENGINE_URL ?? "http://127.0.0.1:4100";
    // pnpm demo names the copy of the corpus the engine serves, which its upstream edits change.
    const corpus = process.env.INSPIRATION_DEMO_CORPUS;
    server.middlewares.use(backend({ engine, ...loadPeople(people), ...(corpus && { updates: new Updates(corpus) }) }));
  },
};

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), languagePacks, devBackend],
  server: { host: "127.0.0.1", port: 5173 },
});
