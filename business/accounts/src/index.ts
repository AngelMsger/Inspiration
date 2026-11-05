/**
 * Accounts: the user (the account, one per person), the identities they sign in with, their
 * sessions and their language. User IDs (usr_) never leave the business layer; in a company
 * a person is a member, which tenancy keeps.
 *
 *     const accounts = new Accounts(new PostgresAccounts(pool), new OidcProvider({ issuer, clientId, ... }));
 *     const { url, state } = await accounts.startSignIn({ returnTo: "/ask?q=…", screen: "sign_up" });
 *     const { token, returnTo } = await accounts.finishSignIn({ state, code, locale });  // the callback
 *     const signedIn = await accounts.session(token);                                    // each request
 *
 * - Sign-in is OpenID Connect's authorization code flow with PKCE, for a confidential client,
 *   against Logto (email and password in the MVP). The ID token is checked before it is
 *   believed: its signature against the provider's published keys, its issuer, audience,
 *   times, and the nonce of the sign-in it ends. A sign-in is used once and lasts
 *   SIGN_IN_MINUTES; returnTo is kept on the server and can only be a path on this site. The
 *   caller ties a sign-in's state to the browser that began it and checks it on the callback.
 * - A person signing in for the first time gets an account, named as the provider names them
 *   and in the language given (localeOf reads the browser's). One needs an email address.
 *   Identities are never linked to an existing account by email.
 * - Sessions last SESSION_DAYS; only a hash of the cookie's token is kept. A session remembers
 *   the company the person works in now (workIn), which the caller checks they belong to.
 * - Signing out ends the session and answers the provider's sign-out URL, so the provider's
 *   own session ends too.
 *
 * Planned are linking identities, sign-in policy per company (SSO, MFA), and deleting an
 * account.
 */

export * from "./accounts.ts";
export * from "./migrations.ts";
export * from "./oidc.ts";
export * from "./postgres.ts";
export * from "./store.ts";
