-- Accounts: users, the identities they sign in with, their sessions and sign-ins in flight.
-- User IDs (usr_) stay in the business layer: the engine never sees them.
CREATE SCHEMA IF NOT EXISTS accounts;

CREATE TABLE accounts.users (
    user_id    text        PRIMARY KEY,
    name       text        NOT NULL,
    email      text        NOT NULL,
    locale     text        NOT NULL,
    created_at timestamptz NOT NULL
);

-- One row per identity at a provider; subject is the provider's own ID for the person.
CREATE TABLE accounts.identities (
    provider       text    NOT NULL,
    subject        text    NOT NULL,
    user_id        text    NOT NULL REFERENCES accounts.users,
    email          text    NOT NULL,
    email_verified boolean NOT NULL,
    PRIMARY KEY (provider, subject)
);

-- Only a hash of the session cookie is kept. tenant_id is the company the person works in now.
CREATE TABLE accounts.sessions (
    token_hash text        PRIMARY KEY,
    user_id    text        NOT NULL REFERENCES accounts.users,
    tenant_id  text,
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL
);

CREATE INDEX sessions_user ON accounts.sessions (user_id);

-- A sign-in between the redirect to the provider and its callback; used once.
CREATE TABLE accounts.sign_ins (
    state      text        PRIMARY KEY,
    nonce      text        NOT NULL,
    verifier   text        NOT NULL,
    return_to  text        NOT NULL,
    created_at timestamptz NOT NULL
);
