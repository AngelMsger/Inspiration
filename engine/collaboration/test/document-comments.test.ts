import type { DocumentComment, EventEnvelope } from "@inspiration/contracts";
import { describe, expect } from "vitest";
import { DocumentComments } from "../src/index.ts";
import { BACKENDS, inboxTest, LI, SPACE, TENANT } from "./fixtures.ts";

describe.each(BACKENDS)("source comments on $backend", ({ backend, skip }) => {
  describe.skipIf(skip)("durable reviews", () => {
    const test = inboxTest(backend);
    test("concurrent retries create one immutable discussion and one todo; closing it keeps its anchor", async ({
      world,
    }) => {
      const { version } = await world.document(["The limit is 500."]);
      const comments = new DocumentComments(world.records, () => new Date("2026-11-13T00:00:00Z"));
      const input = {
        request_id: "one-review",
        source_version_id: version.id,
        block_id: "blk_01JC0000000000000000BLOCK1",
        start: 13,
        end: 16,
        quote: "500",
        body: "See the revised policy.",
        replacement: "600",
      };
      const [first, again] = await Promise.all([
        comments.create(TENANT, LI, SPACE, "Policy", input),
        comments.create(TENANT, LI, SPACE, "Policy", input),
      ]);
      expect(first?.id).toBe(again?.id);
      const events = await world.published("todo.requested");
      expect(events).toHaveLength(1);
      await world.deliver(events[0] as EventEnvelope);
      const saved = (
        await new DocumentComments(world.records, () => new Date()).list(TENANT, version.id)
      )[0] as DocumentComment;
      expect(saved.comment).toEqual(input);
      expect(saved.todo_id).toBeDefined();
      expect(saved.status).toBe("open");
      expect((await world.inbox.todo(TENANT, saved.todo_id as string))?.kind).toBe("feedback");
      await world.inbox.resolve(TENANT, saved.todo_id as string, { by: LI, status: "done" });
      expect((await comments.list(TENANT, version.id))[0]).toMatchObject({ status: "done", comment: input });
      await comments.create(TENANT, LI, SPACE, "Policy", input);
      expect(await world.published("todo.requested")).toHaveLength(1);
      await expect(comments.create(TENANT, LI, SPACE, "Policy", { ...input, body: "Changed request" })).rejects.toThrow(
        "request ID already used",
      );
      expect(await comments.list("ten_another", version.id)).toEqual([]);
    });
  });
});
