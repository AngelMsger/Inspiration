// The company's spaces in the admin area. The super admin creates them, names their space owners
// and renames them; who reads a space is for its space owners to set, in the space itself, and
// here the super admin may only take readers out (access.tsx). The engine keeps the spaces and
// holds to the same rules.

import type { SpaceEntry, SpaceList } from "@inspiration/contracts";
import type { CompanyMember } from "@inspiration/contracts/business";
import { type FormEvent, useRef, useState } from "react";
import { Audience } from "./access.tsx";
import { api, type Loaded } from "./api.ts";
import { ownersOf } from "./audience.ts";
import { Failure, useChange } from "./parts.tsx";
import { Link } from "./route.tsx";
import { useWords } from "./words.ts";

type Members = Loaded<{ members: CompanyMember[] }>;

/** A space as the form edits it. */
interface SpaceFields {
  name: string;
  description: string;
  owners: string[];
}

/** The names of the members `ids` names, in their order; an ID nobody has stays an ID. */
export const namesOf = (members: CompanyMember[], ids: string[]) =>
  ids.map((id) => members.find((m) => m.member_id === id)?.display_name ?? id);

export function AdminSpaces(props: {
  spaces: Loaded<SpaceList>;
  members: Members;
  company: string;
  onChanged: () => void;
}) {
  const { say } = useWords();
  const { failure, busy, run } = useChange(props.onChanged);
  const [making, setMaking] = useState(false);
  // One key per space the form makes, so sending it twice makes it once.
  const key = useRef(crypto.randomUUID());
  const last = useRef<SpaceEntry[]>(undefined);
  if (props.spaces.state === "done") last.current = props.spaces.value.spaces;
  const spaces = last.current;
  const members = props.members.state === "done" ? props.members.value.members : [];
  const create = (fields: SpaceFields) => {
    const owners = ownersOf(fields.owners);
    if (!owners) return;
    run(async () => {
      await api.createSpace(
        { name: fields.name, ...(fields.description && { description: fields.description }), owner_ids: owners },
        key.current,
      );
      key.current = crypto.randomUUID();
      setMaking(false);
    });
  };
  return (
    <>
      <div className="heading">
        <h1 className="title">{say("admin.spaces")}</h1>
        {spaces && <span className="quiet">{say("spaces.count", { count: spaces.length })}</span>}
      </div>
      <p className="lede">{say("spaces.lede")}</p>
      {making ? (
        <SpaceForm members={members} busy={busy} onSubmit={create} onCancel={() => setMaking(false)} />
      ) : (
        <div>
          <button type="button" className="primary" onClick={() => setMaking(true)}>
            {say("spaces.new")}
          </button>
        </div>
      )}
      {failure && <Failure error={failure} />}
      {props.spaces.state === "failed" && <Failure error={props.spaces.error} />}
      {spaces &&
        (spaces.length === 0 ? (
          <p className="quiet">{say("spaces.none")}</p>
        ) : (
          <table className="files admin-table">
            <thead>
              <tr>
                <th>{say("spaces.name")}</th>
                <th>{say("spaces.owners")}</th>
                <th>{say("spaces.grants")}</th>
              </tr>
            </thead>
            <tbody>
              {spaces.map((s) => (
                <tr key={s.id}>
                  <td>
                    <Link to={{ name: "admin", page: "space", space: s.id }}>{s.name}</Link>
                    {s.description && <div className="quiet">{s.description}</div>}
                  </td>
                  <td>{namesOf(members, s.owner_ids).join(say("list.mark"))}</td>
                  <td className="number">{s.grants ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
    </>
  );
}

/** One space: its name, description and space owners, and who reads it. */
export function AdminSpace(props: {
  id: string;
  spaces: Loaded<SpaceList>;
  members: Members;
  company: string;
  onChanged: () => void;
}) {
  const { say } = useWords();
  const { failure, busy, run } = useChange(props.onChanged);
  const last = useRef<SpaceEntry>(undefined);
  if (props.spaces.state === "done") last.current = props.spaces.value.spaces.find((s) => s.id === props.id);
  const space = last.current;
  const members = props.members.state === "done" ? props.members.value.members : [];
  if (props.spaces.state === "failed") return <Failure error={props.spaces.error} />;
  if (!space) return props.spaces.state === "done" ? <p className="quiet">{say("spaces.gone")}</p> : null;
  const save = (fields: SpaceFields) => {
    const owners = ownersOf(fields.owners);
    if (!owners) return;
    run(async () => {
      const renamed = fields.name !== space.name || fields.description !== (space.description ?? "");
      if (renamed) await api.patchSpace(space.id, { name: fields.name, description: fields.description });
      if (owners.join() !== space.owner_ids.join()) await api.setOwners(space.id, owners);
    });
  };
  return (
    <>
      <div className="heading">
        <h1 className="title">{space.name}</h1>
      </div>
      <SpaceForm key={space.id} space={space} members={members} busy={busy} onSubmit={save} />
      {failure && <Failure error={failure} />}
      <h2 className="section">{say("access.title")}</h2>
      <p className="lede">{say("access.lede_admin")}</p>
      <Audience space={space.id} company={props.company} members={props.members} canAdd={space.role === "owner"} />
    </>
  );
}

/** A new space, or one to change: a name, a description and at least one space owner. */
function SpaceForm(props: {
  space?: SpaceEntry;
  members: CompanyMember[];
  busy: boolean;
  onSubmit: (fields: SpaceFields) => void;
  onCancel?: () => void;
}) {
  const { say } = useWords();
  const [fields, setFields] = useState<SpaceFields>({
    name: props.space?.name ?? "",
    description: props.space?.description ?? "",
    owners: props.space?.owner_ids ?? [],
  });
  const [asked, setAsked] = useState(false);
  const noOwner = fields.owners.length === 0;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setAsked(true);
    if (!noOwner && fields.name.trim()) props.onSubmit({ ...fields, name: fields.name.trim() });
  };
  const pick = (member: string, on: boolean) =>
    setFields((f) => ({ ...f, owners: on ? [...f.owners, member] : f.owners.filter((o) => o !== member) }));
  return (
    <form className="space-form" onSubmit={submit}>
      <label>
        {say("spaces.name")}
        <input required value={fields.name} onChange={(e) => setFields({ ...fields, name: e.target.value })} />
      </label>
      <label>
        {say("spaces.description")}
        <input value={fields.description} onChange={(e) => setFields({ ...fields, description: e.target.value })} />
      </label>
      <fieldset>
        <legend>{say("spaces.owners")}</legend>
        <div className="owner-picks">
          {props.members.map((m) => (
            <label key={m.member_id} className="owner-pick">
              <input
                type="checkbox"
                checked={fields.owners.includes(m.member_id)}
                onChange={(e) => pick(m.member_id, e.target.checked)}
              />
              {m.display_name}
            </label>
          ))}
        </div>
        {asked && noOwner && <p className="failure">{say("spaces.pick_owner")}</p>}
      </fieldset>
      <div className="gate-actions">
        <button type="submit" className="primary" disabled={props.busy}>
          {props.space ? say("spaces.save") : say("spaces.create")}
        </button>
        {props.onCancel && (
          <button type="button" className="secondary" onClick={props.onCancel}>
            {say("action.cancel")}
          </button>
        )}
      </div>
    </form>
  );
}
