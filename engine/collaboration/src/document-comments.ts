// Source discussions keep their original version and text offsets. A correction requests a
// human review; resolving its todo never silently rewrites a source or asserts a claim.
import { type DocumentComment, type NewDocumentComment, newEvent, newId } from "@inspiration/contracts";
import { defineTable, type Records } from "@inspiration/eventbus";
import { ITEMS } from "./inbox.ts";

const COMMENTS = defineTable<DocumentComment>("collaboration.document_comments", {
  key: (c) => `${c.tenant_id}:${c.author_id}:${c.comment.request_id}`,
  columns: { tenant_id: (c) => c.tenant_id, version_id: (c) => c.comment.source_version_id },
});

export class DocumentComments {
  readonly records: Records;
  readonly clock: () => Date;
  constructor(records: Records, clock: () => Date) {
    this.records = records;
    this.clock = clock;
  }

  async create(tenant: string, author: string, space: string, title: string, comment: NewDocumentComment) {
    const entry: DocumentComment = {
      id: newId("comment"),
      tenant_id: tenant,
      author_id: author,
      created_at: this.clock().toISOString(),
      document_title: title,
      comment,
    };
    return this.records.transaction(async (tx) => {
      // The request ID survives a failed response and makes retries safe.
      await tx.firstDelivery("collaboration.document-comments", `${tenant}:${author}:${comment.request_id}`);
      const previous = await tx.get(COMMENTS, `${tenant}:${author}:${comment.request_id}`);
      if (previous) {
        const canonical = (value: NewDocumentComment) =>
          JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
        if (canonical(previous.comment) !== canonical(comment)) throw new RangeError("request ID already used");
        return previous;
      }
      await tx.put(COMMENTS, [entry]);
      await tx.publish(
        newEvent(
          "todo.requested",
          {
            kind: comment.replacement === undefined ? "comment_followup" : "feedback",
            space_id: space,
            title,
            priority: "normal",
            unit_ids: [comment.source_version_id],
            dedupe_key: `document-comment:${entry.id}`,
          },
          { tenantId: tenant, producer: "collaboration", occurredAt: this.clock() },
        ),
      );
      return entry;
    });
  }

  async list(tenant: string, version?: string): Promise<DocumentComment[]> {
    const comments = await this.records.find(COMMENTS, { tenant_id: tenant, ...(version && { version_id: version }) });
    const items = await this.records.find(ITEMS, { tenant_id: tenant });
    const todos = new Map(items.map((i) => [i.dedupe_key, i.todo]));
    return comments
      .map((c) => {
        const todo = todos.get(`document-comment:${c.id}`);
        return { ...c, ...(todo && { todo_id: todo.id, status: todo.status, assignee_id: todo.assignee_id }) };
      })
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
}
