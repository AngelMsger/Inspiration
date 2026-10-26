/**
 * SpiceDB backend for the relationship graph.
 *
 * Reads after this process's own writes use at_least_as_fresh with the last ZedToken it
 * received, so a check right after a mirror sees the new ACL; other reads use SpiceDB's
 * default cache-friendly consistency.
 */

import { v1 } from "@authzed/authzed-node";
import {
  type Graph,
  GraphError,
  type ObjectRef,
  type Relationship,
  type SubjectRef,
  schemaText,
  sortRelationships,
} from "./graph.ts";

export type SpiceDBClient = v1.ZedPromiseClientInterface;

/** SpiceDB's limit on items in one CheckBulkPermissions call is configurable; 500 stays under the default. */
export const BULK_CHUNK = 500;

/** A promise client. insecure: plaintext without TLS, for the compose stack and tests. */
export function connect(endpoint: string, key: string, options: { insecure?: boolean } = {}): SpiceDBClient {
  const security = options.insecure ? v1.ClientSecurity.INSECURE_PLAINTEXT_CREDENTIALS : v1.ClientSecurity.SECURE;
  return v1.NewClient(key, endpoint, security).promises;
}

/**
 * Close the client's channels. Call this rather than client.close(): the promise client
 * wraps close in a promise that never settles, so awaiting it hangs.
 */
export function closeClient(client: SpiceDBClient): void {
  client.close();
}

export async function writeSchema(client: SpiceDBClient, schema: string = schemaText()): Promise<string> {
  const resp = await client.writeSchema(v1.WriteSchemaRequest.create({ schema }));
  return resp.writtenAt?.token ?? "";
}

const objectRef = (o: ObjectRef) => v1.ObjectReference.create({ objectType: o.type, objectId: o.id });

const subjectRef = (s: SubjectRef) =>
  v1.SubjectReference.create({ object: objectRef(s), optionalRelation: s.relation ?? "" });

const toProto = (r: Relationship) =>
  v1.Relationship.create({ resource: objectRef(r.resource), relation: r.relation, subject: subjectRef(r.subject) });

function fromProto(r: v1.Relationship): Relationship {
  const s = r.subject;
  return {
    resource: { type: r.resource?.objectType ?? "", id: r.resource?.objectId ?? "" },
    relation: r.relation,
    subject: {
      type: s?.object?.objectType ?? "",
      id: s?.object?.objectId ?? "",
      ...(s?.optionalRelation && { relation: s.optionalRelation }),
    },
  };
}

/** gRPC codes SpiceDB answers with when a write breaks the schema: INVALID_ARGUMENT, FAILED_PRECONDITION. */
const SCHEMA_CODES = new Set([3, 9]);

export class SpiceDBGraph implements Graph {
  readonly client: SpiceDBClient;
  token: string | undefined;

  constructor(client: SpiceDBClient) {
    this.client = client;
  }

  #consistency(): v1.Consistency {
    return v1.Consistency.create({
      requirement: this.token
        ? { oneofKind: "atLeastAsFresh", atLeastAsFresh: v1.ZedToken.create({ token: this.token }) }
        : { oneofKind: "minimizeLatency", minimizeLatency: true },
    });
  }

  async write(updates: {
    touch?: readonly Relationship[];
    delete?: readonly Relationship[];
  }): Promise<string | undefined> {
    const ops = [
      ...(updates.delete ?? []).map((r) =>
        v1.RelationshipUpdate.create({ operation: v1.RelationshipUpdate_Operation.DELETE, relationship: toProto(r) }),
      ),
      ...(updates.touch ?? []).map((r) =>
        v1.RelationshipUpdate.create({ operation: v1.RelationshipUpdate_Operation.TOUCH, relationship: toProto(r) }),
      ),
    ];
    if (!ops.length) return this.token;
    try {
      const resp = await this.client.writeRelationships(v1.WriteRelationshipsRequest.create({ updates: ops }));
      this.token = resp.writtenAt?.token ?? this.token;
    } catch (e) {
      const code = (e as { code?: number }).code;
      if (code !== undefined && SCHEMA_CODES.has(code)) throw new GraphError((e as Error).message, { cause: e });
      throw e;
    }
    return this.token;
  }

  async read(resourceType: string, resourceId?: string, relation?: string): Promise<Relationship[]> {
    const rows = await this.client.readRelationships(
      v1.ReadRelationshipsRequest.create({
        consistency: this.#consistency(),
        relationshipFilter: v1.RelationshipFilter.create({
          resourceType,
          optionalResourceId: resourceId ?? "",
          optionalRelation: relation ?? "",
        }),
      }),
    );
    return sortRelationships(rows.flatMap((r) => (r.relationship ? [fromProto(r.relationship)] : [])));
  }

  async check(resource: ObjectRef, permission: string, s: SubjectRef): Promise<boolean> {
    const resp = await this.client.checkPermission(
      v1.CheckPermissionRequest.create({
        consistency: this.#consistency(),
        resource: objectRef(resource),
        permission,
        subject: subjectRef(s),
      }),
    );
    return resp.permissionship === v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION;
  }

  async checkMany(items: readonly (readonly [ObjectRef, string])[], s: SubjectRef): Promise<boolean[]> {
    const out: boolean[] = [];
    for (let start = 0; start < items.length; start += BULK_CHUNK) {
      const resp = await this.client.checkBulkPermissions(
        v1.CheckBulkPermissionsRequest.create({
          consistency: this.#consistency(),
          items: items
            .slice(start, start + BULK_CHUNK)
            .map(([o, permission]) =>
              v1.CheckBulkPermissionsRequestItem.create({ resource: objectRef(o), permission, subject: subjectRef(s) }),
            ),
        }),
      );
      for (const pair of resp.pairs) {
        if (pair.response.oneofKind !== "item") {
          const message = pair.response.oneofKind === "error" ? pair.response.error.message : "no response";
          throw new Error(`SpiceDB bulk check failed: ${message}`);
        }
        out.push(pair.response.item.permissionship === v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION);
      }
    }
    return out;
  }

  async lookup(resourceType: string, permission: string, s: SubjectRef): Promise<string[]> {
    const rows = await this.client.lookupResources(
      v1.LookupResourcesRequest.create({
        consistency: this.#consistency(),
        resourceObjectType: resourceType,
        permission,
        subject: subjectRef(s),
      }),
    );
    const ids = rows
      .filter((r) => r.permissionship === v1.LookupPermissionship.HAS_PERMISSION)
      .map((r) => r.resourceObjectId);
    return [...new Set(ids)].sort();
  }
}
