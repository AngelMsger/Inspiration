/**
 * The product web app: a React page over the business backend's browser API and, through it,
 * the engine's HTTP API; in development, over its stand-in (backend.ts). Signed out, it shows
 * how to sign in; signed in to no company yet, how to make one (signin.tsx). Then it shows the
 * Knowledge area of the design canvas: home and asking,
 * a space's Documents and topics, reading a document in its Original and Annotated views,
 * the inbox and its decisions, and maintaining a space for its owner (space.tsx), in
 * English, Chinese and Japanese. Run it with pnpm demo (demo.ts); pnpm snapshot (snapshot.ts)
 * records the demo script into a static page that answers from the recording.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import "./style.css";

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
