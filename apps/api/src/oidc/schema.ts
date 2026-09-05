export const OIDC_SCHEMA_STATEMENTS = [
  `CREATE TABLE oidc_identities (
    issuer TEXT NOT NULL,
    subject TEXT NOT NULL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (issuer, subject),
    UNIQUE (user_id, issuer),
    CHECK (issuer <> '' AND subject <> '')
  )`,
  `CREATE TABLE oidc_transactions (
    state_digest CHAR(64) PRIMARY KEY,
    browser_digest CHAR(64) NOT NULL,
    purpose TEXT NOT NULL CHECK (purpose IN ('signin', 'link', 'invite')),
    nonce TEXT NOT NULL,
    verifier TEXT NOT NULL,
    session_digest CHAR(64),
    invitation_digest CHAR(64),
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > created_at),
    consumed_at TIMESTAMPTZ,
    CHECK ((purpose = 'link' AND session_digest IS NOT NULL) OR purpose <> 'link'),
    CHECK ((purpose = 'invite' AND invitation_digest IS NOT NULL) OR purpose <> 'invite')
  )`,
  'CREATE INDEX oidc_transactions_expiry_idx ON oidc_transactions(expires_at)',
] as const;
