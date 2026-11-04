/**
 * A snapshot's backend, in the browser: it answers the page's /api calls from a recording
 * (snapshot.ts) in place of backend.ts and the engine, so a snapshot is a static page anyone
 * can open. The recording holds a state for the start of the demo script and one for each
 * step that acts (deciding a todo, putting in an upstream edit): in each, every read the page
 * can make, as each person. Taking a step's action moves to its state; anything the recording
 * lacks answers 404 with the code not_recorded, and the questions it can answer.
 */

import type { People, Person, Session } from "./backend.ts";

/** One step of the demo script (<corpus>/script.yaml). */
export interface ScriptStep {
  /** The member who takes it. */
  as: string;
  /** Where it starts, as the page's address ("/inbox", "/ask?q=..."). */
  open: string;
  /** What to look at or do, by language tag. */
  text: Record<string, string>;
  /** The action that moves the demo on: confirm the suggestion of the todo about a slot, or put in an upstream edit. */
  do?: { resolve?: string; update?: string };
}

export interface Reply {
  status: number;
  /** The body's key in Recording.bodies. */
  body: string;
  /** The state this call leads to, for a step's action. */
  next?: number;
}

export interface Recording {
  recorded_at: string;
  people: People;
  steps: ScriptStep[];
  /** The questions the script asks, which are the ones the recording can answer. */
  questions: string[];
  /** Each response body once, by a hash of its JSON. */
  bodies: Record<string, unknown>;
  /** By state, then member: each call ("GET /v0/spaces", "POST /v0/answers {...}") and its reply. */
  states: Record<string, Record<string, Reply>>[];
}

/** Where a snapshot is in the script, kept for the browser tab. */
export interface Place {
  state: number;
  member: string;
  /** The script step the guide last opened, by index. */
  step?: number;
}

/** The key a call is recorded under: the method, the path under /api, and the body. */
export function callKey(method: string, path: string, body?: string): string {
  return `${method} ${path}${body ? ` ${body}` : ""}`;
}

/** What the recording answers to one call, and where the demo goes next. */
export function answer(
  recording: Recording,
  place: Place,
  method: string,
  path: string,
  body?: string,
): { status: number; json: unknown; place: Place } {
  const person =
    recording.people.people.find((p) => p.member === place.member) ?? (recording.people.people[0] as Person);
  if (path === "/session") {
    if (method === "POST") {
      const member = (JSON.parse(body || "{}") as { member?: unknown }).member;
      const next = recording.people.people.find((p) => p.member === member);
      if (!next) return { status: 400, json: failure("bad_request", "no such person in this tenant"), place };
      return {
        status: 200,
        json: { ...recording.people, person: next } satisfies Session,
        place: { ...place, member: next.member },
      };
    }
    return { status: 200, json: { ...recording.people, person } satisfies Session, place };
  }
  const reply = recording.states[place.state]?.[person.member]?.[callKey(method, path, body)];
  if (!reply) {
    const asked = path === "/v0/answers";
    return { status: 404, json: failure("not_recorded", asked ? recording.questions.join("\n") : ""), place };
  }
  return {
    status: reply.status,
    json: recording.bodies[reply.body],
    place: { ...place, state: reply.next ?? place.state },
  };
}

const failure = (code: string, message: string) => ({ error: { code, message } });

const PLACE = "inspiration.snapshot.place";

/** The tab's place in the script; the start when it keeps none, or `otherwise` when it can keep nothing. */
export function savedPlace(recording: Recording, otherwise?: Place): Place {
  const start = { state: 0, member: (recording.people.people[0] as Person).member };
  try {
    const saved = JSON.parse(sessionStorage.getItem(PLACE) ?? "null") as Place | null;
    return saved && recording.states[saved.state] ? saved : start;
  } catch {
    return otherwise ?? start;
  }
}

export function savePlace(place: Place | undefined): void {
  try {
    if (place) sessionStorage.setItem(PLACE, JSON.stringify(place));
    else sessionStorage.removeItem(PLACE);
  } catch {
    // A private window may keep nothing; the demo then starts over on a reload.
  }
}

/** Fired on window when the demo moves to another state or person. */
export const MOVED = "inspiration:snapshot-moved";

/**
 * Answer the page's /api calls from the recording, as fetch would from the backend. The place
 * is read from the tab on every call, since the guide changes it there before it reloads the page.
 */
export function install(recording: Recording): void {
  const fetchFromNetwork = window.fetch.bind(window);
  let place = savedPlace(recording);
  window.fetch = async (input, init) => {
    if (typeof input !== "string" || !input.startsWith("/api/")) return fetchFromNetwork(input, init);
    const body = typeof init?.body === "string" ? init.body : undefined;
    place = savedPlace(recording, place);
    const reply = answer(recording, place, init?.method ?? "GET", input.slice("/api".length), body);
    const moved = reply.place.state !== place.state || reply.place.member !== place.member;
    place = reply.place;
    savePlace(place);
    if (moved) window.dispatchEvent(new Event(MOVED));
    return new Response(JSON.stringify(reply.json), {
      status: reply.status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  };
}
