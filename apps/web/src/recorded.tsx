/**
 * The snapshot's page, which snapshot.ts builds in place of main.tsx: it loads the recording,
 * answers the page's calls from it (replay.ts), shows the demo script's guide over the app
 * (guide.tsx) and starts the app.
 */

import { createRoot } from "react-dom/client";
import { Guide } from "./guide.tsx";
import { install, type Recording } from "./replay.ts";

const recording = (await (await fetch("./snapshot.json")).json()) as Recording;
install(recording);
const holder = document.createElement("div");
document.body.append(holder);
createRoot(holder).render(<Guide recording={recording} />);
await import("./main.tsx");
