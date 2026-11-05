// The admin area, where a super admin runs the company: who its members are, their role, the
// invite links that bring new ones in, every member's access tokens (apps.tsx), and its spaces
// with their space owners (admin-spaces.tsx).
// It has a dark left column under "Admin" and the company's name, so it never passes for
// reading. Anyone else who opens it is told who can; the business backend and the engine refuse
// their calls too.

import type { SpaceList } from "@inspiration/contracts";
import type { CompanyMember, Invite, InviteLink, ProductRole, Session } from "@inspiration/contracts/business";
import { type ReactNode, useRef, useState } from "react";
import { AdminSpace, AdminSpaces } from "./admin-spaces.tsx";
import { type ApiFailure, api, type Loaded, useLoad } from "./api.ts";
import { AdminTokens } from "./apps.tsx";
import { CopyField, Crumbs, Failure, formatDate, TwoStep, useChange } from "./parts.tsx";
import { Link, type Route } from "./route.tsx";
import { useWords } from "./words.ts";

type AdminRoute = Extract<Route, { name: "admin" }>;
type Section = Exclude<AdminRoute["page"], "space">;

/** The admin column and the page the address names. */
export function AdminArea(props: { route: AdminRoute; session: Session }) {
  const { say } = useWords();
  const { route } = props;
  const current = props.session.current as NonNullable<Session["current"]>;
  const company = props.session.companies.find((c) => c.tenant_id === current.tenant_id)?.name ?? "";
  const admin = current.role === "super_admin";
  // A change reads the lists again; until then they stay as they were.
  const [version, setVersion] = useState(0);
  const changed = () => setVersion((v) => v + 1);
  const members = useLoad(`members:${version}`, api.members);
  const invites = useLoad(`invites:${version}:${admin}`, () =>
    admin ? api.invites() : Promise.resolve({ invites: [] }),
  );
  // Only a super admin reads the spaces; anyone else is told who can before they are needed.
  const spaces = useLoad(`spaces:${version}:${admin}`, () =>
    admin ? api.managedSpaces() : new Promise<SpaceList>(() => {}),
  );
  const section: Section = route.page === "space" ? "spaces" : route.page;
  const item = (page: Section, label: string, n: number | undefined) => (
    <Link to={{ name: "admin", page }} className="nav-item" current={section === page}>
      <span>{label}</span>
      {n !== undefined && <span className="count">{n}</span>}
    </Link>
  );
  const spaceName =
    route.page === "space" && spaces.state === "done"
      ? spaces.value.spaces.find((s) => s.id === route.space)?.name
      : "";
  const crumbs = (
    <Crumbs>
      {section === "spaces"
        ? [
            say("admin.title"),
            route.page === "space" ? (
              <Link key="spaces" to={{ name: "admin", page: "spaces" }}>
                {say("admin.spaces")}
              </Link>
            ) : (
              say("admin.spaces")
            ),
            route.page === "space" && spaceName,
          ]
        : [say("admin.title"), say("admin.people"), say(`admin.${section}`)]}
    </Crumbs>
  );
  return (
    <>
      <nav className="left left-admin" aria-label={say("admin.title")}>
        <div className="admin-head">
          <span className="admin-label">{say("admin.title")}</span>
          <b>{company}</b>
          <Link to={{ name: "home" }} className="admin-back">
            {say("admin.back")}
          </Link>
        </div>
        <div className="nav-heading">{say("admin.people")}</div>
        {item(
          "members",
          say("admin.members"),
          lengthOf(members, (v) => v.members),
        )}
        {admin &&
          item(
            "invites",
            say("admin.invites"),
            lengthOf(invites, (v) => v.invites),
          )}
        {admin && item("tokens", say("admin.tokens"), undefined)}
        {admin && (
          <>
            <div className="nav-heading">{say("admin.knowledge")}</div>
            {item(
              "spaces",
              say("admin.spaces"),
              lengthOf(spaces, (v) => v.spaces),
            )}
          </>
        )}
      </nav>
      <main className="centre admin-page">
        {crumbs}
        {!admin ? (
          <p className="quiet">{say("admin.only", { company })}</p>
        ) : route.page === "space" ? (
          <AdminSpace id={route.space} spaces={spaces} members={members} company={company} onChanged={changed} />
        ) : route.page === "spaces" ? (
          <AdminSpaces spaces={spaces} members={members} company={company} onChanged={changed} />
        ) : route.page === "tokens" ? (
          <AdminTokens company={company} spaces={spaces} />
        ) : route.page === "invites" ? (
          <Invites invites={invites} company={company} onChanged={changed} />
        ) : (
          <Members members={members} me={current.member_id} company={company} onChanged={changed} />
        )}
      </main>
    </>
  );
}

/** How many a list has, once it is read. */
const lengthOf = <T,>(loaded: Loaded<T>, list: (value: T) => unknown[]) =>
  loaded.state === "done" ? list(loaded.value).length : undefined;

function Members(props: {
  members: Loaded<{ members: CompanyMember[] }>;
  me: string;
  company: string;
  onChanged: () => void;
}) {
  const { say } = useWords();
  const { failure, busy, run } = useChange(props.onChanged);
  // Shown as they were while a change reads them again.
  const last = useRef<CompanyMember[]>(undefined);
  if (props.members.state === "done") last.current = props.members.value.members;
  const members = last.current;
  return (
    <>
      <div className="heading">
        <h1 className="title">{say("admin.members")}</h1>
        {members && <span className="quiet">{say("members.count", { count: members.length })}</span>}
      </div>
      {failure && <ChangeFailure error={failure} />}
      {props.members.state === "failed" && <Failure error={props.members.error} />}
      {members && (
        <table className="files admin-table">
          <thead>
            <tr>
              <th>{say("members.name")}</th>
              <th>{say("members.email")}</th>
              <th>{say("members.role")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.member_id}>
                <td>
                  {m.display_name}
                  {m.member_id === props.me && <span className="quiet"> {say("members.you")}</span>}
                </td>
                <td className="quiet">{m.email}</td>
                <td>
                  <select
                    value={m.role}
                    disabled={busy}
                    aria-label={say("members.role_of", { name: m.display_name })}
                    onChange={(e) => run(() => api.setRole(m.member_id, e.target.value as ProductRole))}
                  >
                    <option value="member">{say("role.member")}</option>
                    <option value="super_admin">{say("role.super_admin")}</option>
                  </select>
                </td>
                <td className="admin-action">
                  {m.member_id !== props.me && (
                    <TwoStep
                      label={say("members.remove")}
                      confirm={say("members.confirm_remove", { name: m.display_name, company: props.company })}
                      disabled={busy}
                      onConfirm={() => run(() => api.removeMember(m.member_id))}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function Invites(props: { invites: Loaded<{ invites: Invite[] }>; company: string; onChanged: () => void }) {
  const { say, tag } = useWords();
  const { failure, busy, run } = useChange(props.onChanged);
  const [made, setMade] = useState<InviteLink>();
  const last = useRef<Invite[]>(undefined);
  if (props.invites.state === "done") last.current = props.invites.value.invites;
  const invites = last.current;
  const make = () =>
    run(async () => {
      setMade(await api.invite());
    });
  return (
    <>
      <div className="heading">
        <h1 className="title">{say("admin.invites")}</h1>
      </div>
      <p className="lede">{say("invites.lede", { company: props.company })}</p>
      <div>
        <button type="button" className="primary" disabled={busy} onClick={make}>
          {say("invites.new")}
        </button>
      </div>
      {/* Until it is revoked; once read again, a link that is not listed is no longer open. */}
      {made && invites?.some((i) => i.id === made.invite.id) !== false && <MadeLink link={made} />}
      {failure && <ChangeFailure error={failure} />}
      {props.invites.state === "failed" && <Failure error={props.invites.error} />}
      {invites &&
        (invites.length === 0 ? (
          <p className="quiet">{say("invites.none")}</p>
        ) : (
          <table className="files admin-table">
            <thead>
              <tr>
                <th>{say("invites.made_by")}</th>
                <th>{say("invites.made_at")}</th>
                <th>{say("invites.expires")}</th>
                <th>{say("invites.joined")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {invites.map((i) => (
                <tr key={i.id}>
                  <td>{i.created_by.display_name}</td>
                  <td className="quiet">{formatDate(tag, i.created_at, true)}</td>
                  <td className="quiet">{formatDate(tag, i.expires_at)}</td>
                  <td className="number">{i.joined}</td>
                  <td className="admin-action">
                    <TwoStep
                      label={say("invites.revoke")}
                      confirm={say("invites.confirm_revoke")}
                      disabled={busy}
                      onConfirm={() => run(() => api.revoke(i.id))}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
    </>
  );
}

/** A link just made: shown this once, with a way to copy it. */
function MadeLink(props: { link: InviteLink }) {
  const { say } = useWords();
  return (
    <div className="made-link" role="status">
      <b>{say("invites.made")}</b>
      <CopyField value={props.link.url} label={say("invites.made")} />
    </div>
  );
}

/** Why a change did not happen; a company keeps a super admin, which the backend holds to. */
function ChangeFailure(props: { error: ApiFailure }): ReactNode {
  const { say } = useWords();
  if (props.error.code === "conflict") return <p className="failure">{say("members.needs_admin")}</p>;
  return <Failure error={props.error} />;
}
