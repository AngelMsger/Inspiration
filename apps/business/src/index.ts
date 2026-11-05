/**
 * The business backend, the browser's only server: it signs people in, keeps their companies,
 * members and invite links (accounts and tenancy), and passes the page's calls on to the
 * engine as the member, with a principal token it signs. It serves on one origin, so the
 * session cookie never leaves the site (serve.ts runs it).
 *
 *     GET    /api/auth/sign-in?return_to&screen    302 to Logto, its registration screen for sign_up
 *     GET    /api/auth/callback                    the cookie, then 302 to return_to (failures: /?sign_in=failed)
 *     POST   /api/auth/sign-out                    SignOut, the provider's own sign-out URL
 *     GET    /api/session                          Session, 401 when signed out
 *     POST   /api/session     SwitchCompany        Session working in that company, or in the sample company
 *     PATCH  /api/account     AccountChange        Session
 *     POST   /api/companies   NewCompany           201 Session; the account is its super admin
 *     GET    /api/members                          MemberList
 *     PUT    /api/members/:member/role  RoleChange CompanyMember, by a super admin
 *     DELETE /api/members/:member                  204, by a super admin
 *     POST   /api/invites                          201 InviteLink, the one time the link is shown
 *     GET    /api/invites                          InviteList
 *     DELETE /api/invites/:invite                  204
 *     GET    /api/tokens      ?all=true            AccessTokenList, every member's for a super admin
 *     POST   /api/tokens      NewAccessToken       201 CreatedAccessToken, the one time the secret is shown
 *     DELETE /api/tokens/:token                    204, the member's own or, by a super admin, anyone's
 *     GET    /api/join/:code                       JoinPreview, for anyone holding the link
 *     POST   /api/join/:code                       Session, joined as a member
 *     PUT    /api/v0/spaces/:space/files/:path     a file's bytes, streamed on to the engine
 *     *      /api/v0/...                           the engine's /v0/..., as the current member
 *     *      /mcp                                  an MCP client's call, with a token's secret, on to the engine's /v0/mcp
 *     GET    /.well-known/jwks.json                the keys the engine checks principal tokens with
 *
 * - The session is an HttpOnly, SameSite=Lax cookie (Secure when the public URL is https);
 *   accounts keeps only its hash. POST, PUT and PATCH need an application/json body, which a
 *   form on another site cannot send. A file upload may have any type instead, but must name
 *   the page's company (x-inspiration-company), which such a form cannot send either, and
 *   give its length, at most 50 MiB.
 * - With a sample company (serve --sample), Session.sample names it, and switching to it
 *   joins the account as a member. Its tokens carry knowledge.read alone, so the engine
 *   refuses every change there; its members are not listed.
 * - An MCP client calls /mcp with a personal access token's secret (access grants). The
 *   backend checks the token and its member on every call, and passes the call on with a
 *   five-minute agent token: the member as obo, the token as grant, its spaces and scopes.
 *   The secret never reaches the engine, and an unknown, expired or revoked token, or one
 *   whose member left, is answered 401. Removing a member revokes their tokens.
 * - A session works in one company at a time, its first by name until it switches. A call
 *   that acts in a company and names the one the page shows (x-inspiration-company) is
 *   answered 409 when the session works in another, as after a switch in a second tab.
 * - Every call to the engine carries a principal token (tokens.ts): EdDSA, five minutes, the
 *   member's ID, company, scopes and language; the account's user ID never leaves this
 *   backend. Tenancy provisions companies and members as the tenancy service, and the
 *   backend sends the newest consistency token of a company's writes with its next calls,
 *   so a fresh grant shows at once. /api/v0/tenants/... is never passed on.
 * - Errors are ApiError bodies: 400 for a body that is not valid, 401 signed out, 403 for a
 *   change the member may not make, 404 for anything unknown, 409 for one that would leave a
 *   company with no super admin, 413 for a file over 50 MiB, 502 when the engine did not take a change (the change is
 *   kept, and sent again when the backend next starts).
 * - With a web directory it serves the built app: files under /assets/ for a year, and
 *   index.html for any other path outside /api/ and /.well-known/.
 *
 * Planned are OAuth for MCP clients, per-company sign-in policy, and audit of admin changes.
 */

export * from "./engine.ts";
export * from "./routes.ts";
export * from "./tokens.ts";
