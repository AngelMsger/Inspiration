# Business layer and engine contract

Status: adopted design, 2026-10-24. This document lists the contract the engine offers the business layer and the schema changes that contract needs. It implements the protocol in [Business layer: functional design](business-layer.md). The JSON Schema in `packages/contracts/schema` stays the source of truth: when a change here lands, the schema is what reviewers check. Already on main: the member IDs (pull request #7). Chinese copy: [docs/zh/design/business-engine-contract.md](../zh/design/business-engine-contract.md).

## Rules

1. **Calls go down, events come up.** The business layer calls engine commands and queries; the engine publishes events. The engine never calls the business layer.
2. **Three IDs.** Tenant ID `ten_`, user ID `usr_` (the account), member ID `mem_` (a user inside one tenant). Users, login identities and sessions never reach the engine; the member ID is the engine's only person ID.
   - A member ID is unique only within its tenant: the full key is (tenant_id, member_id). Every place that stores a member ID outside a tenant-scoped row stores the tenant ID with it (SpiceDB object ID `<ten_…>|<mem_…>`, caches, audit, exports).
   - The business layer's tenancy component assigns member IDs with one rule. Phase 1 reuses the user ID's body under the `mem_` prefix (`usr_01H…` becomes `mem_01H…`). Later the rule can mint a fresh ID per tenant, for new members only; IDs never change.
   - Nothing may derive one ID from the other or parse an ID's body; the user is found only through the member record.
   - On main (pull request #7): `PrincipalKind` is `member`, SpiceDB has `definition member`, and every principal stored outside a tenant's rows is keyed by tenant. Members, groups, departments and services are SpiceDB objects `<ten_…>|<id>`, and principal and ACL tokens use the same form. The engine assumes nothing about whether a directory ID is unique across tenants, so the minting rule does not matter to it. `AclPrincipalKind` keeps `user`, meaning a person in the source system (for example a Feishu open_id), which the directory maps to a member. Access-control directory writes take the tenant explicitly, space grants key the member by the space's tenant, a parent space must be in the same tenant, and a tenant can be granted only on its own spaces. An agent's `on_behalf_of` must be a `mem_`.
3. **Authority is split by subject.** The business layer is the authority on people, tenants and policy values; the engine keeps a copy of what it enforces and makes every permission decision itself.
4. **Commands are idempotent.** Each takes an `Idempotency-Key`, directory objects carry a `version`, and commands return the SpiceDB ZedToken as `consistency_token`.
5. **Business-only schema** (users, invitations, approvals) lives in its own folder that engine packages never import.
6. **Two knowledge domains, top-down visibility.**
   - **Member domain** = one member's personal space (`Space.kind = personal`, one per member per tenant; in a personal tenant, everything). Readable by that member only. No admin, steward or group grant reaches into it, and there is no break-glass read. The only exception is one the member starts: submitting a publish request lets the request's approvers read the items in that request, and nothing else, until it is decided or withdrawn.
   - **Tenant domain** = every other space. Visibility = space roles (reader, commenter, editor, steward; inherited down the space tree) granted top down by admins and stewards to members, groups and departments, then filtered by sensitivity: a unit is readable only if its label ≤ min(member clearance, token `max_sens`). The publisher gets a grant on each unit they published (`publisher`: read and edit under the space's rules), which an admin may remove.
   - **Merge scope = domain.** Entity resolution, statement deduplication, fact slots and conflict detection run per domain key: `member:<space id>` for a personal space, `tenant` for the tenant domain (across all tenant spaces). Nothing is merged or compared across two keys. A personal page may link to tenant-domain items its owner can read; tenant-domain knowledge never cites member-domain items. Topics stay per space, because a topic spanning spaces would mix readable and unreadable statements.
   - **Visibility comes from the space and from proofs, not from source ACLs.** A claim, page or SOP is visible if its own space is readable, and a claim also needs at least one complete proof the reader can read. A proof is an evidence span whose space is in the reader's readable-space set (one LookupResources per request, memoized), or a `ClaimDerivation`: the inputs of a `merge` are alternatives, so any one readable input is a proof, while `aggregate`, `infer` and `translate` need every input readable, checked the same way. A claim with no readable proof is hidden, and so is everything built from it for that reader: a slot's proposed value, a conflict variant, a page sentence, an answer. Other citations and evidence spans outside the readable set show as restricted. Agent tokens with `spaces` narrow the set further.
   - **Crossing audiences takes an approval.** A derivation whose inputs sit in spaces with different audiences is visible only to readers who can read every input (Sales readers without Finance access do not see a margin computed from a Finance cost). To show the result to its own space's audience, the derived unit goes through a publish request to that space, approved by the steward of every input space that audience cannot read; the recorded approval becomes the unit's proof. It covers the derivation, so a recomputed value stays published while the inputs stay the same, and a new input needs a new approval. If an input's space later narrows its audience, those stewards get a `publish_review` todo to keep or withdraw the approval, and the `source_restricted` policy decides what readers see meanwhile (`notify` keeps it, `quarantine` hides it).
   - **Shared caches follow the same boundary.** Answer caches are keyed by the readable-space set and clearance, and an entry is dropped when a unit it used changes label, proof or grant. An answer that used a unit readable only through the reader's own grant (as publisher or approver) is cached for that reader alone.
   - **Source ACLs are advisory.** Source sync keeps `kb.acl_snapshots` and the identity links, but they feed only (a) the audience-gap check at publish time and (b) a `source_restricted` todo when a published document's ACL narrows (an `acl_hash` change that removes principals). Workspace policy picks `notify` (default) or `quarantine` (hide the affected units until the steward decides).
   - **Publishing moves, it does not copy.** The selected sources (or a folder subtree, which becomes its own source), pages and SOPs move from the personal space to the target tenant space. Human-authored content (uploads, edits, overrides, comments) moves with them. Derived knowledge for the moved sources is closed in the member domain and rebuilt and merged in the tenant domain.
   - **Credentials decide freshness only.** Per published source: `workspace_connection` (switch to a tenant connection after a coverage check), `member_connection` (keep the publisher's connection; needs a `ConnectionConsent`, and the credential broker serves a member connection to a tenant-domain source only while that consent is active), or `snapshot` (no connection, frozen, review date required). On offboarding or revocation, sources on that member's connection pause and the freshness owner gets a `reauthorize` todo (switch connection or freeze).
   - **New documents in a published subtree** pass the sensitivity and personal-data scan; flagged ones become a `publish_review` todo for the steward, and the rest arrive (policy `new_documents: scan | approve_each`).
   - **Tenant and member are linked commercially.** The tenant sets per-member limits (model budget, storage); usage is metered per tenant and member.
7. **The engine never writes sentences for people.** The principal token carries `locale`, so the engine can pick the language of anything it generates (for example a compiled summary) without seeing the account. Todos and event payloads carry a message key and parameters, never display text; the business layer renders them from its message catalogs in English, Chinese and Japanese.

### How the engine implements rule 6

- **Access control.** A personal space gets its own SpiceDB definition (owner plus a direct service relation for engine workers), because `space.admin` includes `tenant->administer` and viewers include `tenant#member`. Units get `publisher` and `approver` relations. `canReadDerived` keeps its walk over derivations but checks spaces instead of source documents and applies the proof rule above; today it allows a unit when any supporting source version is readable, which is right for `merge` and too loose for `aggregate` and `infer` (no built component writes those yet). `mirror` keeps ACL snapshots but writes no read tuples. Retrieval is not built yet, so its filter is written for the new rule from the start.
- **Acceptance fixture.** The permission tests cover four cases, on the in-memory graph and on SpiceDB: independent alternative proofs (readable through either), jointly required inputs (hidden unless all are readable), an approved cross-space publication (readable to the target audience), and a later narrowing of an input space (todo, then `notify` or `quarantine`). The same cases run through search, slot reads and the answer cache.
- **Merge scope.** Fact slots and conflicts are keyed by domain: `slotOf` and the governance tables take the domain key instead of the tenant alone.
- **Move = explicit rebuild.** Normalization skips unchanged versions, so a move emits an engine-internal `source.moved` event and every block is re-read in the target space. Claims are never deleted; "dropped" means closed.
- **Re-pointing personal pages.** Citations are span-based, and a span ID comes from its block ID and text. A whole source that moves keeps its span IDs, so a personal page still resolves to the passage, now readable through the publisher grant. An exact match (same spans, same statement) supersedes the member-domain claim with the rebuilt one; otherwise the old claim is retracted as "moved" and shows the marker. A subtree that becomes its own source gets new IDs, so the move writes an old-to-new document map, and spans re-match by document, anchor and text hash. Pages stay immutable: they resolve on read, and the next compile writes the new IDs.

## Principal token

One verification path for web, CLI and MCP. A JWT signed by the business layer (EdDSA); the engine verifies it with the published JWKS. Lifetime at most 5 minutes for web-minted tokens, 10 to 15 minutes for OAuth access tokens.

```
iss, aud = engine canonical URI (RFC 8707 resource), exp, iat, jti
sub        PrincipalId (mem_ | agt_ | svc_)   # never a usr_ user ID
tid        TenantId
kind       PrincipalKind
obo        PrincipalId          # agents: the member they act for
scope      "knowledge.read knowledge.propose comments.write" | "provision.directory" ...
spaces     SpaceId[]            # optional agent space scope
max_sens   SensitivityLabel     # optional
locale     Locale               # the account's UI language: en, zh-CN or ja
auth       { method, mfa: bool, at: Instant }   # how the session signed in
grant      string               # agent grant ID, for revocation
```

The token maps onto the existing `Principal` (`authz.yaml`), which gains an optional `auth_context` and an optional `locale` (the existing `common.yaml#/$defs/Locale`). `auth_context` feeds policy only (for example MFA required for admin commands), never identity. `max_sens` can only narrow: effective clearance = min(token `max_sens`, SpiceDB clearance). An agent acting for a member reaches that member's personal space only if `spaces` is absent or lists it.

## New file `tenancy.yaml`

- `TenantKind` personal | team | enterprise; `TenantStatus` active | suspended | deleting. `Tenant` gains kind, status, region and `default_locale`.
- `MemberStatus` invited | active | suspended | left.
  `Member { id: mem_, tenant_id, status, display_name, email?, roles: [owner|admin|security_admin|auditor|member|guest], clearance?: SensitivityLabel, guest_spaces?: SpaceId[], guest_expires_at?, version }`
- `MemberLimits { member_id, model_budget?, storage_bytes? }` (set by the business layer from the plan)
- `Group { id: grp_, tenant_id, name, member_ids, group_ids, version }`, `Department { id: dep_, parent_id?, name, member_ids, version }`
- `ExternalIdentityLink { provider: PluginName, external_tenant?, external_id, principal_id }` (for example a Feishu union_id mapped to a `mem_`; used for audience-gap checks only)
- `AgentRegistration { id: agt_, tenant_id, owner_id: mem_, kind: client | workspace_agent, scopes, space_scope?, max_sensitivity?, status }`
- `DirectorySnapshot { tenant_id, version, members, groups, departments, links, agents }` and `DirectoryDrift` (counts per section)
- `WorkspacePolicy { version, publish: { member_connection_freshness: allowed | off, new_documents: scan | approve_each, source_restricted: notify | quarantine }, dispute: { serve: last_verified | both | withhold }, models: { max_external_sensitivity }, retention: { departed_personal_space: Duration } }`. `departed_personal_space`: the personal space is locked, readable by nobody, then erased after this period (default 30 days).
- `ApprovalPolicy { mode: single | any | all | quorum, quorum?, deadline: Duration, arbiter_ids }`
- `OwnershipScope` space | taxonomy_node | page | sop | knowledge_model | claim;
  `OwnershipAssignment { scope_kind, scope_id, owner_ids, backup_ids, approval_policy }`. The engine resolves todo assignees by nearest assigned scope, then space steward, then tenant admin. Stored in the governance component's own schema (not the knowledge store's `kb` schema); owners and backups are `mem_` or `grp_` IDs only. Tenant domain only.

## Changes to existing files

- **`authz.yaml`, `packages/access-control/schema.zed`:** `Principal.auth_context` and `Principal.locale` (both optional). `ResourceType` adds `connection` and `agent`. `tenant`: relations `security_admin`, `auditor`. `space`: relation `arbiter`; a personal space has only `owner` and no relation inherited from the tenant. Units (page, SOP, source): relation `publisher`. `publish_request`: relation `approver`, which grants read on the request's items only. Claim, page and SOP read = read on their space (no lineage walk).
- **`collab.yaml`:**
  - New `SourceFreshness` workspace_connection | member_connection | snapshot.
  - `PublishRequest`: one `unit_id` becomes `items[]` (pages, SOPs, sources, folder subtrees); `to_space_id` is the target; new `source_actions[] { source_id, subtree?, freshness, connection_id?, consent_id?, review_at? }` and `checks { coverage: CoverageDiff[], audience_gap: AudienceGap, sensitivity { suggested_label, findings[] }, conflicts: ConflictPreview[] }` beside the existing `gates`.
  - New `ConnectionConsent { id, connection_id, source_id, member_id, granted_at, revoked_at? }`.
  - New `Decision { scope: ResourceRef, resolution_key | proposal_id, decided_by: PrincipalId[], approval_id?, rule?: PrecedenceRule }`, accepted by "decide todo" and "decide publish request". The engine re-checks that each approver has `verify` on the scope. A publish decision may change `to_space_id` and the sensitivity label.
  - New `ResolutionRecord { id, conflict_id?, todo_id, options, votes[] { principal_id, option_key, at, note? }, outcome, rule_id?, decided_at }`.
  - New `PrecedenceRule { id: rul_, scope, match { entity_type?, predicate?, source_ids? }, prefer: source | authority | newest_effective | human, status: active | retired, created_from }`.
  - `TodoKind` adds handover, reauthorize, source_restricted (publish_review exists).
  - `Todo.title` is replaced by `message { key, params }`; the business layer renders it in the reader's language.
- **`knowledge.yaml`:** a domain key on entities, claims, slots and conflict cases (`member:<space id>` | `tenant`; derivable from the space, stored for indexing). `ConflictCase` adds `scope_ids` and `participant_ids`.
- **`retrieval.yaml`:** `IndexFilter` = readable `space_ids` + `max_sensitivity` (+ publisher grants). Results gain `dispute? { conflict_id, since, serve }`; citations outside the reader's readable spaces come back as `restricted`.
- **`source.yaml`:** `Source.connection_id` (from the connectors design), `Source.freshness`, `CoverageDiff { reachable, unreachable[] { external_id, reason }, added }`, `AudienceGap { audience_size, cannot_open, documents[] { document_id, cannot_open } }` (computed only where the ACL is read exactly; otherwise `unknown`).
- **`events.yaml`:** `todo.updated`, `publish_request.updated`, `decision.applied`, `member.offboarded`, `usage.recorded` (hourly, per tenant, member and budget key), and the engine-internal `source.moved` (triggers the rebuild on publish). `connection.changed` comes from the connectors design. No event payload carries display text.
- **`common.yaml`:** `RuleId` (`rul_`) and `MessageKey`. Component names are kebab-case (`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`), so business names such as `tenancy` pass. Only the engine publishes; business components appear as consumer groups under a new "external consumers" section in `components.yaml`.
- **Transport:** in the prototype, business consumers read the engine's Valkey streams with their own groups; the product adds a feed endpoint. Access-control writes already return the ZedToken, and decisions carry it as `consistency_token`, so provisioning commands pass it through for read-after-write. `usage.recorded` is produced by the model gateway through the outbox.

## Commands and queries

REST on the internal network, generated from the schema.

| Group | Operations | Principal |
| --- | --- | --- |
| Tenants | provision (kind, name, region, default locale, default policy), suspend, resume, export, delete (grace, then crypto-shred) | service `provision.tenant` |
| Directory | upsert member, group or department; batch identity links; snapshot reconcile; section digest; offboard member (handover target) | service `provision.directory` |
| Agents | upsert agent registration, revoke grant | service `provision.agents` |
| Policy, ownership | put workspace policy; put ownership assignment | admin or steward member |
| Spaces | create, move, set audience (grant or revoke a role), remove a publisher grant | admin or steward member |
| Publishing | run checks (coverage, audience gap, sensitivity, conflicts), create publish request, withdraw | member |
| Decisions | decide todo, decide publish request | service `decide`, approvers listed |
| Connections | credential broker begin, complete, activate, discard, revoke; grant or revoke a connection consent | member or admin |
| Usage | set tenant and member limits, read usage per tenant and member | service `usage` |

Offboarding a member: remove their tuples; revoke their member connections, consents and agent grants; pause tenant sources kept fresh by those connections (reauthorize todos); hand published units and ownership to the steward (handover todos); lock the personal space (no reader at all) and erase it after `retention.departed_personal_space`; emit `member.offboarded`.

## Engine work

About 4.5 person-weeks net.

- **Phase 1 (3.5):** token verification and service principals 0.5; provisioning, reconcile and offboarding 1; policy and ownership 1; publishing into the tenant domain 1.5 (move with rebuild via `source.moved` about 0.5, freshness choice, consent, coverage, audience gap, new-document scan); two knowledge domains and visibility by space 0.5 (domains +1, dropping lineage-derived read −0.5); multi-approver decisions 0.5; SSO and directory sync moved out of access control −1.5.
- **Phase 2 (1):** offboarding details 0.5; precedence rules and dispute marker 0.5.
- **Languages:** the `locale` claim and message keys on todos fit inside the phase 1 items above.

## Test seams

Engine test kit: a development token issuer (same claims) and a `seed` command (tenant, members, groups, spaces). Business side: an engine fake from the REST schema plus the in-memory event feed. Both sides validate recorded fixtures against the JSON Schema in CI. Domain isolation gets its own fixture: two members publish overlapping sources; nothing merges before publishing, and both land in one merged slot after.
