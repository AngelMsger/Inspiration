// Drive the browser's connection and answer APIs with a page from each vendor in one space.
import { randomBytes } from "node:crypto";
import type { ConnectionList, DocumentView, GroundedAnswer, Source, SpaceWritten } from "@inspiration/contracts";
import type { Session } from "@inspiration/contracts/business";
import { afterEach, describe, expect, vi } from "vitest";
import { BACKENDS, siteTest } from "./site.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe.each(BACKENDS)("$backend", ({ backend, skip }) => {
  siteTest(backend).skipIf(skip)(
    "two local connections answer from the selected pages and retain their citations",
    async ({ site }) => {
      const confluence = "https://wiki.example.test/confluence";
      const feishu = "https://example.feishu.cn/wiki/meals";
      vi.stubEnv("INSPIRATION_LOCAL_CONNECTIONS", "1");
      vi.stubEnv("INSPIRATION_CONFLUENCE_URL", confluence);
      vi.stubEnv("INSPIRATION_CONFLUENCE_TOKEN", randomBytes(24).toString("hex"));
      vi.stubEnv("INSPIRATION_FEISHU_APP_ID", "test-app");
      vi.stubEnv("INSPIRATION_FEISHU_APP_SECRET", randomBytes(24).toString("hex"));
      let revision = 1;
      const localFetch = globalThis.fetch;
      vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input);
        if (url.origin === new URL(confluence).origin) {
          expect(url.pathname).toBe("/confluence/rest/api/content/12");
          return Response.json({
            id: "12",
            title: "Travel policy",
            space: { key: "HR" },
            ancestors: [],
            version: { number: revision, when: "2026-11-01T00:00:00.000+0800" },
            body: { view: { value: `<p>Hotel allowance: ${revision === 1 ? 600 : 650} yuan per night.</p>` } },
          });
        }
        if (url.hostname !== "open.feishu.cn") return localFetch(input, init);
        switch (url.pathname) {
          case "/open-apis/auth/v3/tenant_access_token/internal":
            return Response.json({ code: 0, tenant_access_token: randomBytes(24).toString("hex"), expire: 7200 });
          case "/open-apis/wiki/v2/spaces/get_node":
            return Response.json({ code: 0, data: { node: { obj_type: "docx", obj_token: "mealGuide" } } });
          case "/open-apis/docx/v1/documents/mealGuide":
            return Response.json({
              code: 0,
              data: { document: { document_id: "mealGuide", title: "Meals", revision_id: 1 } },
            });
          case "/open-apis/docx/v1/documents/mealGuide/blocks":
            return Response.json({
              code: 0,
              data: {
                has_more: false,
                items: [
                  { block_type: 1, block_id: "root", children: ["meal"] },
                  {
                    block_type: 2,
                    block_id: "meal",
                    text: { elements: [{ text_run: { content: "Meal allowance: 80 yuan per day." } }] },
                  },
                ],
              },
            });
          default:
            throw new Error("unexpected Feishu route");
        }
      });

      const owner = await site.signIn({
        subject: "local",
        name: "Owner",
        email: "owner@example.test",
        email_verified: true,
      });
      const company = await owner.call<Session>("POST", "/api/companies", {
        name: "Local trial",
        default_locale: "en",
      });
      expect(company.status).toBe(201);
      const space = await owner.call<SpaceWritten>(
        "POST",
        "/api/v0/spaces",
        { name: "Policies", owner_ids: [company.body.current?.member_id] },
        { "idempotency-key": "local-policies" },
      );
      expect(space.status).toBe(200);
      const list = `/api/v0/spaces/${space.body.space.id}/sources`;
      const sources: Source[] = [];
      for (const fields of [
        { type: "confluence", name: "Travel", targets: ["HR"], page_ids: ["12"] },
        { type: "feishu.docx", name: "Meals", targets: [feishu] },
      ]) {
        const connected = await owner.call<Source>("POST", list, { ...fields, governance_level: "reference" });
        expect(connected.status).toBe(200);
        sources.push(connected.body);
      }
      async function sync() {
        for (const source of sources) {
          const run = await owner.call("POST", `/api/v0/sources/${source.id}/sync/start`, {});
          expect(run.status).toBe(200);
        }
        const statuses = async () => (await owner.call<ConnectionList>("GET", list)).body.sources;
        await expect.poll(async () => (await statuses()).map((s) => s.sync?.state)).toEqual(["succeeded", "succeeded"]);
        await site.engine.settle();
        return Object.fromEntries((await statuses()).map((s) => [s.name, s.sync?.report?.outcomes]));
      }
      async function citation(question: string, quote: string, original: string) {
        const answer = await owner.call<GroundedAnswer>("POST", "/api/v0/answers", { question });
        expect(answer.status).toBe(200);
        const cited = answer.body.citations.find((c) => c.quote.includes(quote));
        expect(cited).toBeDefined();
        const version = `/api/v0/documents?version=${cited?.source_version_id}`;
        const view = await owner.call<DocumentView>("GET", version);
        expect(view.body.document.url).toBe(original);
        expect(view.body.blocks.some((b) => b.text?.includes(quote))).toBe(true);
        return version;
      }

      expect(await sync()).toMatchObject({ Travel: { created: 1 }, Meals: { created: 1 } });
      const travelUrl = `${confluence}/pages/viewpage.action?pageId=12`;
      const old = await citation("What is the hotel allowance?", "600 yuan per night", travelUrl);
      await citation("What is the meal allowance?", "80 yuan per day", feishu);
      revision++;
      expect(await sync()).toMatchObject({ Travel: { updated: 1 }, Meals: { unchanged: 1 } });
      expect(await citation("What is the hotel allowance?", "650 yuan per night", travelUrl)).not.toBe(old);
      const previous = await owner.call<DocumentView>("GET", old);
      expect(previous.body.blocks.some((b) => b.text?.includes("600 yuan per night"))).toBe(true);
    },
  );
});
