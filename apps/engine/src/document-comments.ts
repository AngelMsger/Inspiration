// Reading permissions are checked against the immutable version, then comment permission
// on the space. Readers never supply a tenant, author, assignee or trusted source quote.
import { type NewDocumentComment, type Principal, parseAs } from "@inspiration/contracts";
import type { Engine } from "./engine.ts";
import { documentView } from "./http.ts";
import { badRequest, HttpError } from "./http-errors.ts";

export async function documentComments(engine: Engine, who: Principal, version: string) {
  await documentView(engine, who, new URLSearchParams({ version }));
  return engine.comments.list(who.tenant_id, version);
}

export async function addDocumentComment(engine: Engine, who: Principal, body: unknown) {
  const comment = parseAs<NewDocumentComment>("NewDocumentComment", body);
  const view = await documentView(engine, who, new URLSearchParams({ version: comment.source_version_id }));
  const [permission] = await engine.authz.checkMany(who, "comment", [{ type: "space", id: view.space_id as string }]);
  if (!permission?.allow) throw new HttpError(403, "forbidden", "comment permission required");
  const block = view.blocks.find((b) => b.id === comment.block_id);
  if (
    !block ||
    comment.end <= comment.start ||
    block.text.slice(comment.start, comment.end) !== comment.quote ||
    comment.end > block.text.length ||
    !comment.body.trim()
  )
    throw badRequest("the quote must match this source block");
  const saved = await engine.comments.create(
    who.tenant_id,
    who.id,
    view.space_id as string,
    view.document.title,
    comment,
  );
  await engine.settle();
  return (await engine.comments.list(who.tenant_id, view.version.id)).find((c) => c.id === saved.id) ?? saved;
}
