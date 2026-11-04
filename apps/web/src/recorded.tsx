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
  // The app reads whom it acts as once, so the guide starts it again for another person.
  const [run, setRun] = useState(0);
  return (
    <>
      <App key={run} />
      <Guide recording={recording} replay={replay} onRestart={() => setRun((n) => n + 1)} />
    </>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <Snapshot />
  </StrictMode>,
);
