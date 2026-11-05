// The routes of the HTTP API the business layer's tenancy service calls, with the
// provision.directory scope: its tenants and their members, in the engine's copy of the
// directory (access control's Directory). A service provisions only the tenant its token
// names; any other answers 403. Versions decide between commands: a stale one answers 409.

import {
  type DirectoryMemberList,
  type MemberWritten,
  type Principal,
  type PutMember,
  type PutTenant,
  parseAs,
  type TenantWritten,
} from "@inspiration/contracts";
import type { Engine } from "./engine.ts";
import { forbidden, notFound, validated } from "./http-errors.ts";

/** Create or update the tenant, and register the calling service as its service. */
export function putTenant(engine: Engine, who: Principal, tenantId: string, body: unknown): Promise<TenantWritten> {
  provisions(who, tenantId);
  return validated(() => engine.directory.putTenant(tenantId, parseAs<PutTenant>("PutTenant", body), who.id));
}

export async function putMember(
  engine: Engine,
  who: Principal,
  tenantId: string,
  memberId: string,
  body: unknown,
): Promise<MemberWritten> {
  provisions(who, tenantId);
  const put = parseAs<PutMember>("PutMember", body);
  if (!(await engine.directory.tenant(tenantId))) throw notFound("tenant");
  return validated(() => engine.directory.putMember(tenantId, memberId, put));
}

/** The engine's copy of the tenant's members, for checking drift. */
export async function members(engine: Engine, who: Principal, tenantId: string): Promise<DirectoryMemberList> {
  provisions(who, tenantId);
  if (!(await engine.directory.tenant(tenantId))) throw notFound("tenant");
  return engine.directory.members(tenantId);
}

function provisions(who: Principal, tenantId: string): void {
  if (who.kind !== "service") throw forbidden("only the tenancy service provisions the directory");
  if (who.tenant_id !== tenantId) throw forbidden(`the token is for tenant ${who.tenant_id}, not ${tenantId}`);
}
