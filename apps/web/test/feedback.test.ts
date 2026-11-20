import type { Inbox, InboxTodo } from "@inspiration/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";
import feedback from "../../../libs/contracts/examples/DocumentComment.correction.json" with { type: "json" };
import { canQuote } from "../src/discussion.tsx";
import { quotedText } from "../src/document.tsx";
import { DecisionScreen } from "../src/inbox.tsx";
import { parse } from "../src/route.tsx";

vi.mock("../src/words.ts", () => ({ useWords: () => ({ say: (key: string) => key, tag: "en" }) }));
afterEach(() => vi.unstubAllGlobals());

test("a feedback link marks the saved occurrence, including its offset within a table cell", () => {
  vi.stubGlobal("document", { documentElement: { dataset: {} } });
  const item = {
    todo: {
      id: "todo",
      status: "open",
      kind: "feedback",
      title: "Review source",
      tenant_id: feedback.tenant_id,
      space_id: "space",
      priority: "normal",
      unit_ids: [],
      created_at: feedback.created_at,
      created_by: "collaboration",
    },
    statements: [],
    choices: [],
    comment: { ...feedback, comment: { ...feedback.comment, start: 4, end: 7, quote: "cap" } },
  } as InboxTodo;
  const inbox = { cards: [{ todos: [item], kind: "review", batch_key: "card:example" }] } as Inbox;
  const html = renderToStaticMarkup(
    createElement(DecisionScreen, { id: "todo", inbox: { state: "done", value: inbox }, onChanged: () => {} }),
  );
  const link = html.match(/href="(\/document\?[^"]+)"/)?.[1];
  expect(link).toBeTruthy();
  const route = parse(new URL(link?.replaceAll("&amp;", "&") ?? "", "http://local"));
  if (route.name !== "document") throw new Error("missing document link");
  expect(route).toMatchObject({
    version: feedback.comment.source_version_id,
    block: feedback.comment.block_id,
    range: { start: 4, end: 7 },
  });
  const mark = '<mark class="feedback-quote">cap</mark>';
  expect(renderToStaticMarkup(quotedText("cap cap", route.range))).toBe(`cap ${mark}`);
  expect(renderToStaticMarkup(quotedText("cap", route.range, 0))).toBe("cap");
  expect(renderToStaticMarkup(quotedText("cap", route.range, 4))).toBe(mark);
});

test("the composer accepts the contract limit in Unicode characters", () => {
  expect(canQuote(" ")).toBe(false);
  expect(canQuote("x".repeat(20_001))).toBe(false);
  expect(canQuote("😀".repeat(20_000))).toBe(true);
  expect(canQuote("😀".repeat(20_001))).toBe(false);
});
