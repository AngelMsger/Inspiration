/**
 * The snapshot's page, which snapshot.ts builds in place of main.tsx: it loads the recording,
 * answers the page's calls from it (replay.ts), and shows the app with the demo script's guide
 * (guide.tsx). A snapshot is one static page, so its addresses are the part after "#".
 */

import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import { Guide } from "./guide.tsx";
import { install, type Recording } from "./replay.ts";
import "./style.css";

document.documentElement.dataset.routes = "hash";
const recording = (await (await fetch("./snapshot.json")).json()) as Recording;
const replay = install(recording);

function Snapshot() {
  // Each time the guide moves the demo to another person or state, the app reads it again.
  const [generation, setGeneration] = useState(0);
  return (
    <>
      <App generation={generation} />
      <Guide recording={recording} replay={replay} onRestart={() => setGeneration((n) => n + 1)} />
    </>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <Snapshot />
  </StrictMode>,
);
