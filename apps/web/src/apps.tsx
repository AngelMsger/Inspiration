// Apps with access: the access tokens a member makes for an MCP client or a script, and in the
// admin area every member's, for a super admin. A token reads what its member may read, only in
// the spaces it names, and goes with its member. Its secret is shown once: the page keeps it in
// memory until the person is done with it, and never stores it.

import type { SpaceEntry, SpaceList } from "@inspiration/contracts";
import type { AccessToken, CreatedAccessToken, NewAccessToken } from "@inspiration/contracts/business";
import { type FormEvent, useRef, useState } from "react";
import { api, type Library, type Loaded, useLoad } from "./api.ts";
import { CopyField, Failure, formatDate, TwoStep, useChange } from "./parts.tsx";
import { useWords } from "./words.ts";

/** How long a token may last, in days; the business backend takes 1 to 90. */
const LASTS = [30, 60, 90] as const;

/** A member's own tokens, and making one; the sample company only reads, so it has none. */
export function AppsScreen(props: { library: Library; sampled: boolean }) {
  const { say } = useWords();
  const [version, setVersion] = useState(0);
  const tokens = useLoad(`tokens:${version}`, () => api.tokens());
  const { failure, busy, run } = useChange(() => setVersion((v) => v + 1));
  const [making, setMaking] = useState(false);
  const [made, setMade] = useState<CreatedAccessToken>();
  // Shown as they were while a change reads them again.
  const last = useRef<{ tokens: AccessToken[]; mcp_url: string }>(undefined);
  if (tokens.state === "done") last.current = tokens.value;
  const create = (asked: NewAccessToken) =>
    run(async () => {
      setMade(await api.createToken(asked));
      setMaking(false);
    });
  const named = (id: string) => props.library.spaces.find((s) => s.id === id)?.name;
  return (
    <main className="centre">
      <div className="heading">
        <h1 className="title">{say("apps.title")}</h1>
      </div>
      <p className="lede">{say("apps.lede")}</p>
      {made && last.current && (
        <MadeToken made={made} mcpUrl={last.current.mcp_url} onDone={() => setMade(undefined)} />
      )}
      {props.sampled ? (
        <p className="quiet">{say("apps.sample")}</p>
      ) : making ? (
        <TokenForm spaces={props.library.spaces} busy={busy} onCreate={create} onCancel={() => setMaking(false)} />
      ) : (
        !made && (
          <div>
            <button type="button" className="primary" onClick={() => setMaking(true)}>
              {say("apps.new")}
            </button>
          </div>
        )
      )}
      {failure && <Failure error={failure} />}
      {tokens.state === "failed" && <Failure error={tokens.error} />}
      {last.current && (
        <TokenTable
          tokens={last.current.tokens}
          named={named}
          busy={busy}
          onRevoke={(id) => run(() => api.revokeToken(id))}
        />
      )}
    </main>
  );
}

/** Every member's tokens in the company, for a super admin in the admin area; none of their secrets. */
export function AdminTokens(props: { company: string; spaces: Loaded<SpaceList> }) {
  const { say } = useWords();
  const [version, setVersion] = useState(0);
  const tokens = useLoad(`tokens:all:${version}`, () => api.tokens(true));
  const { failure, busy, run } = useChange(() => setVersion((v) => v + 1));
  const last = useRef<AccessToken[]>(undefined);
  if (tokens.state === "done") last.current = tokens.value.tokens;
  const spaces = props.spaces.state === "done" ? props.spaces.value.spaces : [];
  return (
    <>
      <div className="heading">
        <h1 className="title">{say("admin.tokens")}</h1>
      </div>
      <p className="lede">{say("tokens.lede", { company: props.company })}</p>
      {failure && <Failure error={failure} />}
      {tokens.state === "failed" && <Failure error={tokens.error} />}
      {last.current && (
        <TokenTable
          tokens={last.current}
          named={(id) => spaces.find((s) => s.id === id)?.name}
          busy={busy}
          onRevoke={(id) => run(() => api.revokeToken(id))}
        />
      )}
    </>
  );
}

/** Tokens in a table, with their member's name when `tokens` holds every member's. */
export function TokenTable(props: {
  tokens: AccessToken[];
  /** A space's name, if the reader knows it. */
  named: (space: string) => string | undefined;
  busy: boolean;
  onRevoke: (token: string) => void;
}) {
  const { say, tag } = useWords();
  if (props.tokens.length === 0) return <p className="quiet">{say("apps.none")}</p>;
  const members = props.tokens.some((t) => t.member);
  const where = (t: AccessToken) =>
    t.spaces === "all"
      ? say("apps.all")
      : t.spaces.map((s) => props.named(s) ?? say("apps.space_gone")).join(say("list.mark"));
  return (
    <table className="files admin-table">
      <thead>
        <tr>
          {members && <th>{say("apps.col.member")}</th>}
          <th>{say("apps.col.name")}</th>
          <th>{say("apps.col.where")}</th>
          <th>{say("apps.col.expires")}</th>
          <th>{say("apps.col.used")}</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {props.tokens.map((t) => (
          <tr key={t.id}>
            {members && <td>{t.member?.display_name}</td>}
            <td>{t.name}</td>
            <td className="quiet">{where(t)}</td>
            <td className="quiet">{formatDate(tag, t.expires_at)}</td>
            <td className="quiet">{t.last_used_at ? formatDate(tag, t.last_used_at, true) : say("apps.never")}</td>
            <td className="admin-action">
              <TwoStep
                label={say("apps.revoke")}
                confirm={say("apps.confirm_revoke")}
                disabled={props.busy}
                onConfirm={() => props.onRevoke(t.id)}
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A new token's name, where it may read, and how long it lasts. */
function TokenForm(props: {
  spaces: SpaceEntry[];
  busy: boolean;
  onCreate: (asked: NewAccessToken) => void;
  onCancel: () => void;
}) {
  const { say } = useWords();
  const [name, setName] = useState("");
  const [all, setAll] = useState(true);
  const [picked, setPicked] = useState<string[]>([]);
  const [days, setDays] = useState<number>(LASTS[0]);
  const [first, ...rest] = picked;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    if (all) props.onCreate({ name: name.trim(), spaces: "all", days });
    else if (first) props.onCreate({ name: name.trim(), spaces: [first, ...rest], days });
  };
  const pick = (space: string, on: boolean) => setPicked((p) => (on ? [...p, space] : p.filter((s) => s !== space)));
  return (
    <form className="space-form" onSubmit={submit}>
      <label>
        {say("apps.name")}
        <input
          required
          maxLength={100}
          placeholder={say("apps.name_hint")}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <fieldset>
        <legend>{say("apps.where")}</legend>
        <div className="owner-picks">
          <label className="owner-pick">
            <input type="radio" name="where" checked={all} onChange={() => setAll(true)} />
            {say("apps.all")}
          </label>
          <label className="owner-pick">
            <input type="radio" name="where" checked={!all} onChange={() => setAll(false)} />
            {say("apps.some")}
          </label>
        </div>
        {!all && (
          <div className="owner-picks token-spaces">
            {props.spaces.map((s) => (
              <label key={s.id} className="owner-pick">
                <input type="checkbox" checked={picked.includes(s.id)} onChange={(e) => pick(s.id, e.target.checked)} />
                {s.name}
              </label>
            ))}
          </div>
        )}
      </fieldset>
      <label>
        {say("apps.days")}
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {LASTS.map((n) => (
            <option key={n} value={n}>
              {say("apps.days_n", { count: n })}
            </option>
          ))}
        </select>
      </label>
      <p className="quiet">{say("apps.reads_only")}</p>
      <div className="gate-actions">
        <button type="submit" className="primary" disabled={props.busy || (!all && !first)}>
          {say("apps.create")}
        </button>
        <button type="button" className="secondary" onClick={props.onCancel}>
          {say("action.cancel")}
        </button>
      </div>
    </form>
  );
}

/** A token just made: its secret this once, and how to give it to an MCP client. */
function MadeToken(props: { made: CreatedAccessToken; mcpUrl: string; onDone: () => void }) {
  const { say } = useWords();
  const { secret } = props.made;
  const command = `claude mcp add --transport http inspiration ${props.mcpUrl} --header "Authorization: Bearer ${secret}"`;
  return (
    <div className="made-link" role="status">
      <b>{say("apps.made", { name: props.made.token.name })}</b>
      <CopyField value={secret} label={say("apps.title")} />
      <span>{say("apps.claude_code")}</span>
      <CopyField value={command} label={say("apps.claude_code")} lines={3} />
      <span className="quiet">{say("apps.other", { url: props.mcpUrl })}</span>
      <div>
        <button type="button" className="secondary" onClick={props.onDone}>
          {say("apps.done")}
        </button>
      </div>
    </div>
  );
}
