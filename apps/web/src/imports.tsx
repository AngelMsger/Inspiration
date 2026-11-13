// Import is discoverable to every reader. Controls explain missing access before any request;
// the engine remains the authority for writes and never accepts credentials from the browser.

import type { CreateConnection } from "@inspiration/contracts";
import { useState } from "react";
import type { Library } from "./api.ts";
import { Crumbs } from "./parts.tsx";
import { Link } from "./route.tsx";
import { Sources } from "./sources.tsx";
import { Uploader } from "./upload.tsx";
import { mayUpload } from "./uploads.ts";
import { useWords } from "./words.ts";

type Method = "upload" | CreateConnection["type"];

export function ImportScreen(props: {
  space: string;
  library: Library;
  sampled: boolean;
  onSourcesChanged: () => void;
}) {
  const { say } = useWords();
  const [method, setMethod] = useState<Method>("upload");
  const space = props.library.spaces.find((s) => s.id === props.space);
  const sources = props.library.trees.get(props.space)?.sources ?? [];
  if (!space) {
    return (
      <main className="centre">
        <p className="failure">{say("folder.not_found")}</p>
      </main>
    );
  }
  const methods: { method: Method; title: string; hint: string }[] = [
    { method: "upload", title: say("import.files"), hint: say("import.files_hint") },
    { method: "confluence", title: say("source.confluence"), hint: say("import.confluence_hint") },
    { method: "feishu.docx", title: say("source.feishu.docx"), hint: say("import.feishu_hint") },
  ];
  const recorded = typeof document !== "undefined" && document.documentElement.dataset.routes === "hash";
  const blocked = props.sampled
    ? say("sample.banner")
    : recorded
      ? say("import.recorded")
      : method === "upload"
        ? !mayUpload(space) && say("import.upload_required")
        : space.role !== "owner" && say("import.owner_required");
  const documents = { name: "documents" as const, space: space.id, folders: [] };
  return (
    <main className="centre import-screen">
      <Crumbs>
        {[
          space.name,
          <Link key="documents" to={documents}>
            {say("nav.documents")}
          </Link>,
          say("import.title"),
        ]}
      </Crumbs>
      <h1 className="title">{say("import.title")}</h1>
      <p className="import-destination">
        <b>{say("import.destination", { space: space.name })}</b>
      </p>
      <p className="quiet">{say("connections.access")}</p>
      <fieldset className="import-methods">
        <legend>{say("import.choose")}</legend>
        {methods.map((m) => (
          <button
            key={m.method}
            type="button"
            className="import-method"
            aria-pressed={method === m.method}
            onClick={() => setMethod(m.method)}
          >
            <b>{m.title}</b>
            <span className="quiet">{m.hint}</span>
          </button>
        ))}
      </fieldset>
      {blocked ? (
        <p className="gate-alert" role="status">
          {blocked}
        </p>
      ) : method === "upload" ? (
        <Uploader key={space.id} space={space} sources={sources} folder={[]} onSent={props.onSourcesChanged}>
          <p className="quiet">{say("import.files_hint")}</p>
        </Uploader>
      ) : (
        <Sources key={`${space.id}:${method}`} space={space.id} kind={method} onChanged={props.onSourcesChanged} />
      )}
      <p>
        <Link to={documents}>{say("import.back")}</Link>
      </p>
    </main>
  );
}
