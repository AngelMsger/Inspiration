/**
 * A snapshot's backend, in the browser: it answers the page's /api calls from a recording
 * (snapshot.ts) in place of backend.ts and the engine, so a snapshot is a static page anyone
 * can open. The recording holds a state for the start of the demo script and one for each
 * step that acts (deciding a todo, putting in an upstream edit): in each, every read the page
 * can make, as each person. Taking a step's action moves to its state; anything the recording
 * lacks answers 404 with the code not_recorded, and the questions it can answer. Roles, members
 * who leave and invite links live in the tab (company.ts), and the people the script acts as
 * cannot be removed, so the guide always has them.
 */

import type { AccountChange, NewAccessToken, ProductRole } from "@inspiration/contracts/business";
import { Company, Refused } from "./company.ts";
import type { People, Person } from "./people.ts";

/** One step of the demo script (<corpus>/script.yaml). */
export interface ScriptStep {
  /** The member who takes it. */
  as: string;
  /**
   * Where it starts, as the page's address ("/inbox", "/ask?q=..."), or an address by language
   * tag, as for a question put in each language the app speaks.
   */
  open: string | Record<string, string>;
  /** What to look at or do, by language tag. */
  text: Record<string, string>;
  /** The action that moves the demo on: confirm the suggestion of the todo about a slot, or put in an upstream edit. */
  do?: { resolve?: string; update?: string };
}

/** A step's address in a language: its only one, else the one in that language, else the English. */
export function addressOf(step: ScriptStep, tag: string): string {
  if (typeof step.open === "string") return step.open;
  return step.open[tag] ?? step.open.en ?? Object.values(step.open)[0] ?? "/";
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
  /** The day the engine's clock stood at while it recorded, YYYY-MM-DD: the demo's day. */
  day?: string;
  people: People;
  steps: ScriptStep[];
  /** The questions the script asks, which are the ones the recording can answer. */
  questions: string[];
  /**
   * The model the recording's gateway config prefers for answers, when it is not a development
   * stand-in. It is not who wrote each answer: the gateway falls back to another model on a
   * retryable error, and an answer from content that model is not cleared for goes to one that is.
   */
  answer_model?: string;
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

/** The company a recording's people make up, as one tab changes it; `site` starts its invite links. */
export interface Replayed {
  company: Company;
  site: string;
}

export const replayed = (recording: Recording, site: string): Replayed => ({
  company: new Company(
    recording.people,
    recording.steps.map((s) => s.as),
  ),
  site,
});

/** What the recording answers to one call, and where the demo goes next. */
export function answer(
  recording: Recording,
  place: Place,
  method: string,
  path: string,
  body?: string,
  tab: Replayed = replayed(recording, "."),
): { status: number; json: unknown; place: Place } {
  const { people } = recording;
  const { company } = tab;
  const person = people.people.find((p) => p.member === place.member) ?? (people.people[0] as Person);
  // Who is signed in, and their company, as the stand-in backend answers them (company.ts).
  const route = `${method} ${path}`;
  // A change comes from the page in the same tab, so it is taken as it is.
  const signedIn = (as: Person, change?: AccountChange) => ({
    status: 200,
    json: company.sessionOf(as, companyOf(recording), change),
    place: { ...place, member: as.member },
  });
  if (route === "GET /session" || route === "POST /session") return signedIn(person);
  if (route === "PATCH /account") return signedIn(person, JSON.parse(body || "{}") as AccountChange);
  if (route === "GET /demo/people") return { status: 200, json: { people: people.people }, place };
  const managed = companyAnswer(tab, person, method, path, body, companyOf(recording));
  if (managed?.joined) return signedIn(person);
  if (managed) return { status: managed.status, json: managed.json, place };
  if (route === "POST /demo/act-as") {
    const member = (JSON.parse(body || "{}") as { member?: unknown }).member;
    const next = people.people.find((p) => p.member === member);
    if (!next) return { status: 400, json: failure("bad_request", "no such person in this company"), place };
    return signedIn(next);
  }
  // A recording has no account to leave: signing out opens it again.
  if (route === "POST /auth/sign-out") return { status: 200, json: { next: "./" }, place };
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

/** The company's members, invite links and access tokens, and joining it, as the business backend answers them. */
function companyAnswer(
  tab: Replayed,
  person: Person,
  method: string,
  path: string,
  body: string | undefined,
  name: string,
): { status: number; json?: unknown; joined?: boolean } | undefined {
  const { company } = tab;
  const [bare = "", query = ""] = path.split("?");
  const [, kind, id = "", role] = bare.match(/^\/(members|invites|tokens|join)(?:\/([^/]+)(\/role)?)?$/) ?? [];
  const named = decodeURIComponent(id);
  try {
    if (kind === "join" && method === "GET") return { status: 200, json: company.preview(named, name) };
    if (kind === "join" && method === "POST") {
      company.join(person, named);
      return { status: 200, joined: true };
    }
    if (kind && !company.isMember(person)) return { status: 400, json: failure("bad_request", "no current company") };
    if (kind === "members" && !id && method === "GET") return { status: 200, json: { members: company.members() } };
    if (kind === "members" && role && method === "PUT") {
      const asked = (JSON.parse(body || "{}") as { role: ProductRole }).role;
      return { status: 200, json: company.setRole(person, named, asked) };
    }
    if (kind === "members" && id && method === "DELETE") {
      company.remove(person, named);
      return { status: 204 };
    }
    if (kind === "invites" && !id && method === "GET") return { status: 200, json: company.invites(person) };
    if (kind === "invites" && !id && method === "POST") {
      return { status: 201, json: company.invite(person, (code) => `${tab.site}#/join/${code}`) };
    }
    if (kind === "invites" && id && method === "DELETE") {
      company.revoke(person, named);
      return { status: 204 };
    }
    if (kind === "tokens" && !id && method === "GET") {
      return {
        status: 200,
        json: company.tokens(person, `${tab.site}/mcp`, new URLSearchParams(query).get("all") === "true"),
      };
    }
    if (kind === "tokens" && !id && method === "POST") {
      return { status: 201, json: company.createToken(person, JSON.parse(body || "{}") as NewAccessToken) };
    }
    if (kind === "tokens" && id && method === "DELETE") {
      company.revokeToken(person, named);
      return { status: 204 };
    }
  } catch (e) {
    if (e instanceof Refused) return { status: e.status, json: failure(e.code, e.message) };
    if (e instanceof RangeError) return { status: 404, json: failure("not_found", e.message) };
    throw e;
  }
  return undefined;
}

/** The company's name, from the spaces the first person read at the start. */
function companyOf(recording: Recording): string {
  const first = (recording.people.people[0] as Person).member;
  const reply = recording.states[0]?.[first]?.[callKey("GET", "/v0/spaces")];
  return ((reply && recording.bodies[reply.body]) as { tenant?: { name?: string } } | undefined)?.tenant?.name ?? "";
}

const PLACE = "inspiration.snapshot.place";

/** The start of the script: its first state, as the first person. */
export function startOf(recording: Recording): Place {
  return { state: 0, member: (recording.people.people[0] as Person).member };
}

/** The tab's place in the script, so a reload carries on; the start when it keeps none. */
export function savedPlace(recording: Recording): Place {
  try {
    const saved = JSON.parse(sessionStorage.getItem(PLACE) ?? "null") as Place | null;
    return saved && recording.states[saved.state] ? saved : startOf(recording);
  } catch {
    return startOf(recording);
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

/** Fired on window when the demo moves to another state, person or step. */
export const MOVED = "inspiration:snapshot-moved";

/** Where the demo is: the page's calls move it, and so does the guide. */
export interface Replay {
  place(): Place;
  moveTo(place: Place): void;
}

/** Answer the page's /api calls from the recording, as fetch would from the backend. */
export function install(recording: Recording): Replay {
  const fetchFromNetwork = window.fetch.bind(window);
  let place = savedPlace(recording);
  // Invite links open this page at the join screen.
  const tab = replayed(recording, location.href.split("#")[0] ?? "");
  const moveTo = (next: Place) => {
    const moved = next.state !== place.state || next.member !== place.member || next.step !== place.step;
    place = next;
    savePlace(place);
    if (moved) window.dispatchEvent(new Event(MOVED));
  };
  window.fetch = async (input, init) => {
    if (typeof input !== "string" || !input.startsWith("/api/")) return fetchFromNetwork(input, init);
    const body = typeof init?.body === "string" ? init.body : undefined;
    const reply = answer(recording, place, init?.method ?? "GET", input.slice("/api".length), body, tab);
    moveTo(reply.place);
    return new Response(reply.status === 204 ? null : JSON.stringify(reply.json), {
      status: reply.status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  };
  return { place: () => place, moveTo };
}
