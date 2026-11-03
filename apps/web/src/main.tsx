/**
 * The product web app, for the demo: a React page over the engine's HTTP API, through its
 * backend (backend.ts). It shows the Knowledge area of the design canvas: home and asking,
 * a space's Documents, and reading a document in its Original and Annotated views, in
 * English, Chinese and Japanese. Run it with pnpm demo (demo.ts).
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
