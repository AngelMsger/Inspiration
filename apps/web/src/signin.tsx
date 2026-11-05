// The screens before the frame: signing in, which the identity provider's page does once the
// page sends the person there, making a first company for an account that has none, and an
// invite link, which joins its company.

import type { Session, UiLocale } from "@inspiration/contracts/business";
import { type FormEvent, type ReactNode, useState } from "react";
import { api, signInAt, useLoad } from "./api.ts";
import { Failure, formatDate } from "./parts.tsx";
import { LOCALES, tagLocale } from "./people.ts";
import { href, Link } from "./route.tsx";
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

/**
 * Signed in to no company yet: make one, or open the invite link a colleague sent, or look around
 * the sample company first when the site has one. From the sample, `onCancel` goes back to it.
 */
export function NoCompany(props: {
  session: Session;
  onCreate: (name: string, locale: UiLocale) => Promise<void>;
  onOpen: (tenant: string) => Promise<void>;
  onCancel?: () => void;
  onSignOut: () => void;
}) {
  const { say, tag } = useWords();
  const [name, setName] = useState("");
  const [locale, setLocale] = useState(tagLocale(tag));
  const [busy, setBusy] = useState(false);
  const { sample } = props.session;
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
        <h1 className="title">
          {props.onCancel ? say("company.new") : say("company.welcome", { name: props.session.account.name })}
        </h1>
        {!props.onCancel && <p>{say("company.lede")}</p>}
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
            {props.onCancel && (
              <button type="button" className="secondary" onClick={props.onCancel}>
                {say("action.cancel")}
              </button>
            )}
          </div>
        </form>
        {sample && !props.onCancel && (
          <div className="gate-sample">
            <p className="quiet">{say("sample.offer", { name: sample.name })}</p>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                props.onOpen(sample.tenant_id).finally(() => setBusy(false));
              }}
            >
              {say("sample.open")}
            </button>
          </div>
        )}
      </main>
    </div>
  );
}

/**
 * An invite link: who sent it and the company it joins. Signed in, one button joins; signed out,
 * signing in or creating an account comes back here. A link that expired or was revoked says so.
 */
export function Join(props: {
  code: string;
  session: Session | undefined;
  signedOut: boolean;
  onJoin: () => Promise<void>;
  onLanguage: (tag: Tag) => void;
  onSignOut: () => void;
}) {
  const { say, tag } = useWords();
  const preview = useLoad(`join:${props.code}`, () => api.joinPreview(props.code));
  const [busy, setBusy] = useState(false);
  const back = href({ name: "join", code: props.code });
  const join = () => {
    setBusy(true);
    props.onJoin().finally(() => setBusy(false));
  };
  const company = preview.state === "done" ? preview.value.company.name : "";
  return (
    <div className="gate">
      {props.session ? (
        <GateTop>
          <button type="button" className="link-button" onClick={props.onSignOut}>
            {say("account.sign_out")}
          </button>
        </GateTop>
      ) : (
        <GateTop onLanguage={props.onLanguage} />
      )}
      <main className="gate-card">
        {preview.state === "loading" && <p className="quiet">{say("join.loading")}</p>}
        {preview.state === "failed" &&
          (preview.error.status === 404 ? (
            <>
              <h1 className="title">{say("join.gone")}</h1>
              <p>{say("join.gone_lede")}</p>
              {props.session && (
                <div className="gate-actions">
                  <Link to={{ name: "home" }} className="secondary">
                    {say("join.home")}
                  </Link>
                </div>
              )}
            </>
          ) : (
            <Failure error={preview.error} />
          ))}
        {preview.state === "done" && (
          <>
            <h1 className="title">{say("join.title", { name: preview.value.invited_by.display_name, company })}</h1>
            <p>{say("join.lede", { date: formatDate(tag, preview.value.expires_at) })}</p>
            {props.session && (
              <>
                <p className="quiet">
                  {say("join.as", { name: props.session.account.name, email: props.session.account.email })}
                </p>
                <div className="gate-actions">
                  <button type="button" className="primary" disabled={busy} onClick={join}>
                    {say("join.join", { company })}
                  </button>
                </div>
              </>
            )}
            {props.signedOut && (
              <>
                <p>{say("join.signed_out")}</p>
                <div className="gate-actions">
                  <a className="primary" href={signInAt("sign_in", back)}>
                    {say("signin.sign_in")}
                  </a>
                  <a className="secondary" href={signInAt("sign_up", back)}>
                    {say("signin.sign_up")}
                  </a>
                </div>
              </>
            )}
          </>
        )}
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
