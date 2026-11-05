// Who may read a space: its audience, as its space owners set it and the super admin trims it.
// The space owners always read it and are named in the admin area, so here they are listed but
// not changed. Everyone else is a viewer grant, for one member or for everyone in the company;
// the MVP offers no other role. A space owner adds and takes out readers; the super admin may
// only take them out, which the engine holds to as well.

import type { SpaceAudience, SpaceGrant } from "@inspiration/contracts";
import type { CompanyMember } from "@inspiration/contracts/business";
import { useRef, useState } from "react";
import { api, type Loaded, useLoad } from "./api.ts";
import { EVERYONE, readersOf, withReader } from "./audience.ts";
import { Failure, useChange } from "./parts.tsx";
import { useWords } from "./words.ts";

export function Audience(props: {
  space: string;
  company: string;
  members: Loaded<{ members: CompanyMember[] }>;
  /** A space owner adds readers; the super admin may only take them out. */
  canAdd: boolean;
}) {
  const { say } = useWords();
  const [version, setVersion] = useState(0);
  const loaded = useLoad(`audience:${props.space}:${version}`, () => api.audience(props.space));
  const { failure, busy, run } = useChange(() => setVersion((v) => v + 1));
  // Shown as it was while a change reads it again.
  const last = useRef<SpaceAudience>(undefined);
  if (loaded.state === "done") last.current = loaded.value;
  const audience = last.current?.space_id === props.space ? last.current : undefined;
  const members = props.members.state === "done" ? props.members.value.members : [];
  const nameOf = (principal: string) =>
    principal === EVERYONE
      ? say("access.everyone", { company: props.company })
      : (members.find((m) => m.member_id === principal)?.display_name ?? principal);
  if (!audience) return loaded.state === "failed" ? <Failure error={loaded.error} /> : null;
  const readers = readersOf(audience);
  const put = (grants: SpaceGrant[]) => run(() => api.setAudience(props.space, { grants }));
  const listed = new Set(audience.grants.map((g) => g.principal_id));
  const addable = [
    ...(listed.has(EVERYONE) ? [] : [EVERYONE]),
    ...members.filter((m) => !listed.has(m.member_id)).map((m) => m.member_id),
  ];
  return (
    <>
      {failure &&
        (failure.status === 403 ? <p className="failure">{say("access.forbidden")}</p> : <Failure error={failure} />)}
      <ul className="audience">
        {audience.grants.map((g) => (
          <li key={`${g.principal_id}:${g.role}`}>
            <span>{nameOf(g.principal_id)}</span>
            {g.role === "owner" ? (
              <span className="quiet">{say("access.owner")}</span>
            ) : (
              <button
                type="button"
                className="link-button"
                disabled={busy}
                onClick={() => put(withReader(readers, g.principal_id, false))}
              >
                {say("access.remove")}
              </button>
            )}
          </li>
        ))}
        {readers.length === 0 && <li className="quiet">{say("access.owners_only")}</li>}
      </ul>
      {props.canAdd && addable.length > 0 && (
        <label className="audience-add">
          <span>{say("access.add")}</span>
          <select
            value=""
            disabled={busy}
            onChange={(e) => e.target.value && put(withReader(readers, e.target.value, true))}
          >
            <option value="">{say("access.pick")}</option>
            {addable.map((id) => (
              <option key={id} value={id}>
                {nameOf(id)}
              </option>
            ))}
          </select>
        </label>
      )}
    </>
  );
}

/** Who can read a space, as its space owners see it in the space. */
export function SpaceAccess(props: { space: string; company: string }) {
  const { say } = useWords();
  const members = useLoad("members", api.members);
  return (
    <>
      <p className="lede">{say("access.lede", { company: props.company })}</p>
      <Audience space={props.space} company={props.company} members={members} canAdd />
    </>
  );
}
