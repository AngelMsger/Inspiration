// Relationships answer reading questions in context: what supports this, and where does a
// different value appear? Edges come only from authorized citations and governance results.
import type { Citation, DocumentView, SearchHit } from "@inspiration/contracts";
import { citedAt } from "./home.tsx";
import { type Mark, passages } from "./marks.ts";
import { Standing } from "./parts.tsx";
import { Link } from "./route.tsx";
import { useWords } from "./words.ts";

export function EvidenceSources(props: { statements: SearchHit[] }) {
  const { say } = useWords();
  const sources = [
    ...new Map(props.statements.flatMap((s) => s.citations).map((c) => [c.source_version_id, c])).values(),
  ];
  if (!sources.length) return null;
  return (
    <div className="fact-evidence">
      <span>{say("context.based_on")}</span>
      {sources.map((c) => (
        <Link key={c.source_version_id} to={citedAt(c)}>
          {c.source_title}
        </Link>
      ))}
    </div>
  );
}

export function ReadingContext(props: {
  view: DocumentView;
  marks: Map<string, Mark[]>;
  annotated: boolean;
  onSelect: (block: string) => void;
}) {
  const { say } = useWords();
  const sections = passages(props.view.blocks).filter((p) => p.block.kind === "heading");
  const issues = [...props.marks.entries()].flatMap(([block, marks]) =>
    marks
      .filter((m) => m.statement.standing === "outdated" || m.statement.standing === "disputed")
      .map((mark) => ({ block, mark })),
  );
  const otherSources = new Map<string, Citation>();
  for (const statement of props.view.annotations.statements)
    for (const c of statement.citations) {
      if (c.source_version_id !== props.view.version.id) otherSources.set(c.source_version_id, c);
    }
  return (
    <aside className="panel reading-context" aria-label={say("context.title")}>
      <div className="panel-title">{say("context.title")}</div>
      {props.annotated && issues.length > 0 && (
        <section className="context-issues">
          <h3>{say("context.check")}</h3>
          <p className="quiet">{say("context.check_hint")}</p>
          {issues.map(({ block, mark }) => (
            <div key={`${block}:${mark.statement.unit_id}`} className="context-item">
              <Standing value={mark.statement.standing} />
              <button
                type="button"
                className="link-button context-quote"
                onClick={() => {
                  props.onSelect(block);
                  document.getElementById(block)?.scrollIntoView({ block: "center" });
                }}
              >
                {mark.statement.snippet}
              </button>
              {mark.held && (
                <>
                  <p className="quiet">
                    {say(mark.statement.standing === "disputed" ? "context.different" : "context.current")}
                  </p>
                  <p>{mark.held.snippet}</p>
                  <EvidenceSources statements={[mark.held]} />
                </>
              )}
            </div>
          ))}
        </section>
      )}
      {props.annotated && otherSources.size > 0 && (
        <section>
          <h3>{say("context.also_in")}</h3>
          <p className="quiet">{say("context.also_hint")}</p>
          {[...otherSources.values()].map((c) => (
            <p key={c.source_version_id}>
              <Link to={citedAt(c)}>{c.source_title}</Link>
              <span className="context-source-quote">{c.quote}</span>
            </p>
          ))}
        </section>
      )}
      {sections.length > 0 && (
        <nav aria-label={say("context.outline")}>
          <h3>{say("context.outline")}</h3>
          <ul className="toc">
            {sections.map(({ block }) => (
              <li key={block.id}>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => document.getElementById(block.id)?.scrollIntoView({ block: "start" })}
                >
                  {block.text}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </aside>
  );
}
