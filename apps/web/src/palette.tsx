// The command palette (⌘K): every place and action by name, and asking whatever is typed.

import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { Library } from "./api.ts";
import type { Person } from "./backend.ts";
import { documentsOf } from "./documents.tsx";
import { navigate } from "./route.tsx";
import { TAGS, type Tag, useWords, wordsOf } from "./words.ts";

interface Entry {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

const SHOWN = 12;

export function Palette(props: {
  library: Library;
  people: Person[];
  onActAs: (member: string) => void;
  onLanguage: (tag: Tag) => void;
  onClose: () => void;
}) {
  const { say } = useWords();
  const [text, setText] = useState("");
  const [at, setAt] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  const typed = text.trim();
  const all: Entry[] = [
    { id: "home", label: say("nav.home"), run: () => navigate({ name: "home" }) },
    ...props.library.spaces.map((s) => ({
      id: `space-${s.id}`,
      label: `${s.name} › ${say("nav.documents")}`,
      run: () => navigate({ name: "documents", space: s.id, folders: [] }),
    })),
    ...documentsOf(props.library).map((d) => ({
      id: `doc-${d.entry.source_id}-${d.entry.external_id}`,
      label: d.entry.title,
      hint: d.where.join(" · "),
      run: () => navigate({ name: "document", source: d.entry.source_id, item: d.entry.external_id, view: "original" }),
    })),
    ...props.people.map((p) => ({
      id: `person-${p.member}`,
      label: say("palette.act_as", { name: p.name }),
      hint: p.about,
      run: () => props.onActAs(p.member),
    })),
    ...TAGS.map((t) => ({
      id: `language-${t}`,
      label: say("palette.language", { name: wordsOf(t)("language.name") }),
      run: () => props.onLanguage(t),
    })),
  ];
  const needle = typed.toLowerCase();
  const matching = all.filter((e) => `${e.label} ${e.hint ?? ""}`.toLowerCase().includes(needle));
  const entries = [
    ...(typed
      ? [{ id: "ask", label: say("palette.ask", { text: typed }), run: () => navigate({ name: "ask", q: typed }) }]
      : []),
    ...matching,
  ].slice(0, SHOWN);
  const current = Math.min(at, Math.max(entries.length - 1, 0));

  const choose = (e: Entry | undefined) => {
    if (!e) return;
    props.onClose();
    e.run();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setAt((current + step + entries.length) % Math.max(entries.length, 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(entries[current]);
    }
  };

  return (
    <dialog ref={dialog} className="palette" aria-label={say("palette.label")} onClose={props.onClose}>
      <input
        autoFocus
        value={text}
        placeholder={say("palette.label")}
        aria-label={say("palette.label")}
        onChange={(e) => {
          setText(e.target.value);
          setAt(0);
        }}
        onKeyDown={onKeyDown}
      />
      {entries.length === 0 ? (
        <p className="quiet">{say("palette.none")}</p>
      ) : (
        <ul>
          {entries.map((e, i) => (
            <li key={e.id}>
              <button
                type="button"
                className={i === current ? "current" : undefined}
                onMouseEnter={() => setAt(i)}
                onClick={() => choose(e)}
              >
                <span>{e.label}</span>
                {e.hint && <span className="quiet">{e.hint}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </dialog>
  );
}
