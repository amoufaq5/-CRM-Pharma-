-- 0014_service_credential.sql
--
-- The CRM mints its own Ed25519 service JWTs to call the ERP (ADR-0001 item 10,
-- Q8). Two tables: the published key set, and the per-tenant ERP service role.
--
-- WHY THE CRM MINTS ITS OWN. The ERP's verifier accepts EdDSA ONLY
-- (packages/api-gateway-runtime/src/auth.ts: `unsupported alg ${alg}; only EdDSA
-- is accepted`) and its JWKS parser keeps only OKP/Ed25519 keys. No third-party
-- OIDC provider has to support Ed25519 for us to satisfy that — we sign the
-- ERP-facing token ourselves and forward no human's token to the ERP.

-- ---------------------------------------------------------------------------
-- The published key set.
--
-- DELIBERATELY NOT TENANT-SCOPED, and holding no tenant data. The ERP is pointed
-- at ONE JWKS url with ONE issuer and audience, so keys are a deployment
-- concern; what scopes a token to a tenant is its `tenant_id` claim, not which
-- key signed it. No tenant_id column, so no RLS policy is required or wanted.
--
-- PRIVATE KEYS ARE NEVER STORED HERE. This table holds the public half only, so
-- the API can publish a JWKS without ever being able to sign. The private key
-- lives in the scheduler's memory, loaded from a secret at boot.
CREATE TABLE crm.service_key (
  -- The RFC 7638 JWK thumbprint of the public key, so the kid cannot disagree
  -- with the key it names — it is derived from it, not chosen.
  kid           text PRIMARY KEY,

  -- base64url of the raw 32-byte Ed25519 public key: the JWK `x` member,
  -- verbatim, which is what the ERP's parser reads.
  public_jwk_x  text NOT NULL,

  --   published — in the JWKS, not signing. Where every key starts and ends up
  --               again after demotion.
  --   active    — in the JWKS and signing. At most one, enforced below.
  --   retired   — NOT in the JWKS. Terminal. Tokens signed with it stop
  --               verifying, so a key may only reach this state once every token
  --               it signed has expired (enforced in the registry).
  status        text NOT NULL DEFAULT 'published'
                  CHECK (status IN ('published', 'active', 'retired')),

  published_at  timestamptz NOT NULL DEFAULT now(),
  activated_at  timestamptz,
  -- When it stopped being active. The retirement rule is computed from this.
  demoted_at    timestamptz,
  retired_at    timestamptz,
  note          text,

  CONSTRAINT service_key_active_has_timestamp
    CHECK (status <> 'active' OR activated_at IS NOT NULL),
  CONSTRAINT service_key_retired_has_timestamp
    CHECK (status <> 'retired' OR retired_at IS NOT NULL)
);

-- At most one signing key. Two active keys would make "which key is current"
-- a race between whichever row a query happened to return first.
CREATE UNIQUE INDEX uq_service_key_one_active
  ON crm.service_key (status) WHERE status = 'active';

-- The JWKS reads this: published + active, never retired.
CREATE INDEX idx_service_key_verifiable
  ON crm.service_key (status) WHERE status <> 'retired';

-- ---------------------------------------------------------------------------
-- The ERP role each tenant's service principal holds.
--
-- WHY PER TENANT AND NOT ONE ENVIRONMENT VARIABLE. `--per-tenant-manifests` is on
-- (ADR-0001 Q11), so each tenant's manifest declares its own roles; a role name
-- that exists for one tenant need not exist for another. A single deployment-wide
-- role would be a guess for every tenant but the first.
--
-- NO DEFAULT, AND THAT IS THE POINT. A tenant with no row here cannot get a
-- token. Defaulting to a privileged role — `controller`, which is what the GL
-- posting in ADR-0001 item 11 needs — for a tenant nobody configured is the
-- worst available failure mode: it would work.
CREATE TABLE crm.erp_service_principal (
  tenant_id   uuid PRIMARY KEY,

  -- EXACTLY ONE ROLE, and the regex is load-bearing.
  --
  -- The ERP splits the `scope` claim on spaces and then reads only the FIRST
  -- entry as the principal's role (apps/operate-server/src/principals.ts:
  -- `primaryRole: p?.grantedScopes[0] ?? "anonymous"`). So a value of
  -- 'sales_rep controller' would grant sales_rep and silently discard the rest —
  -- a convincing-looking least-privilege configuration that does something else.
  -- A space cannot get in here.
  erp_role    text NOT NULL CHECK (erp_role ~ '^[a-z][a-z0-9_]{0,62}$'),

  -- Overrides the default JWT `sub`. The ERP hashes `sub` into a principal id
  -- (uuid v5-shaped), which is what lands in its audit rows, so this is how CRM
  -- traffic is told apart from a human's in an ERP forensic dump.
  subject     text CHECK (subject IS NULL OR length(subject) BETWEEN 1 AND 255),

  -- Revocation without deletion: the CRM stops minting immediately and the
  -- reason stays on the record.
  enabled     boolean NOT NULL DEFAULT true,
  note        text,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

SELECT crm.apply_tenant_isolation('crm.erp_service_principal');
