// The parsing worker over HTTP, on the files in test/data (make_fixtures.py writes them): what
// each parser reads, and how the worker refuses what it cannot read. The worker runs on the
// Python with its libraries: INSPIRATION_PYTHON, else the repository's .venv, else python3.
// Without one the tests are skipped, or fail when INSPIRATION_REQUIRE_STACK=1 (as in CI).

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { contractErrors, type DocBlock, type ModelGateway, type ParseResult } from "@inspiration/contracts";
import { MemoryBlobStore, workspaceRoot } from "@inspiration/kernel";
import { testData } from "@inspiration/testkit";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { WORKER_TYPES, workerParserAt } from "../src/index.ts";

const WORKER = fileURLToPath(new URL("../worker/", import.meta.url));
const DATA = fileURLToPath(new URL("./data/", import.meta.url));
const ZH = testData<{ heading: string; paragraph: string }>(import.meta.url, "zh.yaml");

const venv = `${workspaceRoot()}/.venv/bin/python`;
const python = process.env.INSPIRATION_PYTHON ?? (existsSync(venv) ? venv : "python3");
const ready =
  spawnSync(python, ["-c", "import docx, pptx, openpyxl, pdfminer"], { cwd: WORKER, stdio: "ignore" }).status === 0;
const required = process.env.INSPIRATION_REQUIRE_STACK === "1";

let worker: ChildProcess | undefined;
let url = "";
const blobs = new MemoryBlobStore();
const parser = workerParserAt(() => url);

beforeAll(async () => {
  if (!ready) {
    if (required) throw new Error(`INSPIRATION_REQUIRE_STACK=1 but ${python} lacks the worker's libraries`);
    return;
  }
  worker = spawn(python, ["-m", "inspiration_parsing", "--port", "0"], {
    cwd: WORKER,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const [line] = (await once(createInterface({ input: worker.stdout as NodeJS.ReadableStream }), "line")) as [string];
  url = /listening on (\S+)/.exec(line)?.[1] ?? "";
  expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
});

afterAll(() => {
  worker?.kill();
});

async function parse(name: string, mimeType?: string): Promise<ParseResult> {
  const ext = name.slice(name.lastIndexOf("."));
  const type = mimeType ?? WORKER_TYPES[ext] ?? "application/octet-stream";
  const data = readFileSync(`${DATA}${name}`);
  const file = await blobs.put(data, { mimeType: type, filename: name });
  const meta = { mime_type: type, filename: name, size_bytes: data.length };
  const result = await parser.parse(file, meta, {}, { blobs, models: {} as ModelGateway });
  expect(contractErrors("ParseResult", result)).toEqual([]);
  return result;
}

const shape = (b: DocBlock) => [b.kind, b.text ?? null, b.level ?? null];
const cells = (table: DocBlock | undefined) => table?.children?.map((row) => row.children?.map((c) => c.text));

describe.skipIf(!ready && !required)("the parsing worker", () => {
  test("reads Word: headings by outline level, list items, tables with a merged cell once, CJK text", async () => {
    const { blocks, parser: producer } = await parse("policy.docx");
    expect(producer).toEqual({ component: "parsing", name: "docx", version: "1" });
    expect(blocks.filter((b) => b.kind !== "table").map(shape)).toEqual([
      ["heading", "Travel policy", 1],
      ["heading", "Hotels", 1],
      ["paragraph", "Hotels cost at most 600 a night in tier-1 cities.", null],
      ["list_item", "Book through the travel desk.", 0],
      ["list_item", "Keep the invoice.", 0],
      ["heading", ZH.heading, 2],
      ["paragraph", ZH.paragraph, null],
    ]);
    const tables = blocks.filter((b) => b.kind === "table");
    expect(cells(tables[0])).toEqual([
      ["City tier", "Cap", "Note"],
      ["Tier 1", "600", ""],
      ["Tier 2", "450", "Since 2026"],
    ]);
    expect(tables[0]?.children?.[1]?.children?.[1]?.cell).toEqual({ row: 1, col: 1 });
    expect(cells(tables[1])).toEqual([["Approvals"], ["Manager", "Finance"]]);
  });

  test("reads PowerPoint: each slide's title, text, list items, tables and notes on its page", async () => {
    const { blocks } = await parse("deck.pptx");
    expect(blocks.map((b) => [...shape(b), b.page])).toEqual([
      ["heading", "Quarterly review", 1, 1],
      ["paragraph", "Travel spend fell 8%", null, 1],
      ["list_item", "Hotels drove most of it", 0, 1],
      ["paragraph", "Mention the new cap.", null, 1],
      ["heading", "Caps by tier", 1, 2],
      ["table", null, null, 2],
    ]);
    expect(blocks[3]?.attrs).toEqual({ notes: true });
    expect(cells(blocks[5])).toEqual([
      ["Tier", "Cap"],
      ["Tier 1", "600"],
    ]);
  });

  test("reads Excel: each visible sheet's values as a table, and names the hidden ones", async () => {
    const { blocks, warnings } = await parse("budget.xlsx");
    expect(blocks.map((b) => b.kind)).toEqual(["heading", "table"]);
    expect(blocks[0]?.text).toBe("Budget");
    // The empty row is left out; a formula Excel never calculated shows nothing.
    expect(cells(blocks[1])).toEqual([
      ["Item", "Amount", "Due", "Approved"],
      ["Hotels", "600", "2026-11-15", "TRUE"],
      ["Flights", "1250.5", "2026-11-20 09:30", "FALSE"],
    ]);
    expect(blocks[1]?.children?.[2]?.children?.[0]?.cell).toEqual({ sheet: "Budget", row: 3, col: 0 });
    expect(warnings).toEqual(["sheet Scratch is hidden and was not read"]);
  });

  test("reads PDF: paragraphs with page and box, headings by size, without running headers or footers", async () => {
    const { blocks, warnings } = await parse("policy.pdf");
    expect(blocks.map((b) => [...shape(b), b.page])).toEqual([
      ["heading", "Travel policy", 1, 1],
      ["paragraph", "Hotels cost at most 600 a night. The cap holds in every tier-1 city.", null, 1],
      ["heading", "Approvals", 2, 2],
      ["paragraph", "A manager approves every trip.", null, 2],
      ["paragraph", "Finance checks the invoices each month.", null, 3],
    ]);
    expect(blocks[0]?.bbox).toHaveLength(4);
    expect(warnings).toBeUndefined();
  });

  test("says why it cannot read a file: a scan, a broken file, a type it does not read", async () => {
    await expect(parse("scan.pdf")).rejects.toThrow(/no text layer/);
    await expect(parse("broken.docx")).rejects.toThrow(/not a readable Word file/);
    const text = await fetch(`${url}/v1/parse`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "x",
    });
    expect([text.status, await text.json()]).toEqual([
      415,
      {
        error: {
          code: "unsupported_type",
          message: "the worker reads Word, PowerPoint, Excel and PDF, not text/plain",
        },
      },
    ]);
    const health = await (await fetch(`${url}/v1/health`)).json();
    expect(health).toMatchObject({ ok: true, types: Object.values(WORKER_TYPES).sort() });
  });
});

test("takes Word, PowerPoint, Excel and PDF by type or name, and says when the worker is not there", async () => {
  const meta = (mime_type: string, filename?: string) => ({ mime_type, size_bytes: 1, ...(filename && { filename }) });
  expect(parser.accepts(meta(WORKER_TYPES[".pdf"] as string))).toBe(1);
  expect(parser.accepts(meta("application/octet-stream", "Budget.XLSX"))).toBe(1);
  expect(parser.accepts(meta("text/plain", "notes.txt"))).toBe(0);
  const away = workerParserAt(() => "http://127.0.0.1:9");
  const file = await blobs.put(new Uint8Array([1]), { mimeType: "application/pdf" });
  await expect(away.parse(file, meta("application/pdf"), {}, { blobs, models: {} as ModelGateway })).rejects.toThrow(
    /not reachable/,
  );
});
