// The screens before the frame: signing in, which the identity provider's page does once the
// page sends the person there, and making a first company for an account that has none.

import type { Session, UiLocale } from "@inspiration/contracts/business";
import { type FormEvent, type ReactNode, useState } from "react";
import { signInAt } from "./api.ts";
import { LOCALES, tagLocale } from "./people.ts";
import { TAGS, type Tag, tagOf, useWords, wordsOf } from "./words.ts";

/** Signed out: one account for every company, signed in or made on the identity provider's page. */
export function SignedOut(props: { onLanguage: (tag: Tag) => void }) {
  const { say } = useWords();
  // The business backend sends a sign-in that did not work, or was cancelled, back with sign_in=failed.
  const query = new URLSearchParams(location.search);
  const failed = query.get("sign_in") === "failed";
  query.delete("sign_in");
  // Back to the page asked for, once signed in.
  const back = `${location.pathname}${query.size ? `?${query}` : ""}`;
  return (
    <div className="gate">
      <GateTop onLanguage={props.onLanguage} />
      <main className="gate-card">
        <h1 className="title">{say("signin.title")}</h1>
        {failed && (
          <p className="gate-alert" role="alert">
            {say("signin.failed")}
          </p>
        )}
        <p>{say("signin.lede")}</p>
        <div className="gate-actions">
          <a className="primary" href={signInAt("sign_in", back)}>
            {say("signin.sign_in")}
          </a>
          <a className="secondary" href={signInAt("sign_up", back)}>
            {say("signin.sign_up")}
          </a>
        </div>
      </main>
    </div>
  );
}

/** Signed in to no company yet: make one, or open the invite link a colleague sent. */
export function NoCompany(props: {
  session: Session;
  onCreate: (name: string, locale: UiLocale) => Promise<void>;
  onSignOut: () => void;
}) {
  const { say, tag } = useWords();
  const [name, setName] = useState("");
  const [locale, setLocale] = useState(tagLocale(tag));
  const [busy, setBusy] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    props.onCreate(name.trim(), locale).finally(() => setBusy(false));
  };
  return (
    <div className="gate">
      <GateTop>
        <button type="button" className="link-button" onClick={props.onSignOut}>
          {say("account.sign_out")}
        </button>
      </GateTop>
      <main className="gate-card">
        <h1 className="title">{say("company.welcome", { name: props.session.account.name })}</h1>
        <p>{say("company.lede")}</p>
        <form className="gate-form" onSubmit={submit}>
          <label>
            <span>{say("company.name")}</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required />
          </label>
          <label>
            <span>{say("company.language")}</span>
            <select value={locale} onChange={(e) => setLocale(e.target.value as UiLocale)}>
              {LOCALES.map((l) => (
                <option key={l} value={l}>
                  {wordsOf(tagOf(l) ?? "en")("language.name")}
                </option>
              ))}
            </select>
          </label>
          <p className="quiet">{say("company.super_admin")}</p>
          <div className="gate-actions">
            <button type="submit" className="primary" disabled={busy || !name.trim()}>
              {say("company.create")}
            </button>
          </div>
        </form>
      </main>
    </div>
  );
}

/** The wordmark, and what the top right offers before the frame: the language, or signing out. */
function GateTop(props: { onLanguage?: (tag: Tag) => void; children?: ReactNode }) {
  const { tag } = useWords();
  return (
    <header className="gate-top">
      <span className="wordmark">Inspiration</span>
      <span className="grow" />
      {props.onLanguage &&
        TAGS.map((t) => (
          <button
            key={t}
            type="button"
            className="link-button"
            aria-current={t === tag}
            onClick={() => props.onLanguage?.(t)}
          >
            {wordsOf(t)("language.name")}
          </button>
        ))}
      {props.children}
    </header>
  );
}
