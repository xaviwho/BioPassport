-- BioPassport V2 Database Schema
-- PostgreSQL schema for indexer service

-- ==================== Extensions ====================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ==================== Enums ====================

CREATE TYPE exception_reason AS ENUM (
    'HASH_MISMATCH',
    'EVIDENCE_MISSING', 
    'CHAIN_BREAK',
    'EXPIRED_CREDENTIAL',
    'REVOKED_ISSUER',
    'TAMPERED_EVIDENCE',
    'OTHER'
);

CREATE TYPE verification_status AS ENUM (
    'PASS',
    'FAIL',
    'PENDING'
);

CREATE TYPE credential_type AS ENUM (
    'CHAIN_OF_CUSTODY',
    'COA',
    'INTAKE',
    'QC',
    'SHIPMENT',
    'IDENTITY',
    'USAGE_RIGHTS'
);

-- ==================== Tables ====================

-- Assets: registered biological materials
CREATE TABLE assets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    asset_id_hash BYTEA NOT NULL UNIQUE,  -- bytes32 from chain
    pointer TEXT NOT NULL,                 -- off-chain metadata location
    registrar TEXT NOT NULL,               -- wallet address
    created_at TIMESTAMPTZ NOT NULL,
    block_number BIGINT NOT NULL,
    tx_hash TEXT NOT NULL,
    
    -- Denormalized for queries
    asset_id TEXT,                         -- plaintext asset ID if known
    latest_credential_hash BYTEA,
    credential_count INT DEFAULT 0,
    has_open_exceptions BOOLEAN DEFAULT FALSE,
    
    created_at_db TIMESTAMPTZ DEFAULT NOW(),
    updated_at_db TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_assets_asset_id_hash ON assets(asset_id_hash);
CREATE INDEX idx_assets_registrar ON assets(registrar);
CREATE INDEX idx_assets_created_at ON assets(created_at);

-- Credentials: signed claims about assets
CREATE TABLE credentials (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    credential_hash BYTEA NOT NULL UNIQUE,  -- bytes32 from chain
    asset_id_hash BYTEA NOT NULL REFERENCES assets(asset_id_hash),
    prev_hash BYTEA,                         -- chain linkage
    evidence_root BYTEA NOT NULL,
    pointer TEXT NOT NULL,                   -- off-chain credential JSON
    issuer TEXT NOT NULL,                    -- wallet address
    issued_at TIMESTAMPTZ NOT NULL,
    block_number BIGINT NOT NULL,
    tx_hash TEXT NOT NULL,
    
    -- Denormalized from credential JSON (populated by indexer)
    credential_type credential_type,
    issuer_org TEXT,
    subject JSONB,
    evidence_count INT DEFAULT 0,
    
    -- Verification cache
    last_verified_at TIMESTAMPTZ,
    last_verification_status verification_status,
    
    created_at_db TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_credentials_credential_hash ON credentials(credential_hash);
CREATE INDEX idx_credentials_asset_id_hash ON credentials(asset_id_hash);
CREATE INDEX idx_credentials_issuer ON credentials(issuer);
CREATE INDEX idx_credentials_issued_at ON credentials(issued_at);
CREATE INDEX idx_credentials_type ON credentials(credential_type);

-- Evidence files: individual files linked to credentials
CREATE TABLE evidence_files (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    credential_hash BYTEA NOT NULL REFERENCES credentials(credential_hash),
    uri TEXT NOT NULL,
    sha256_hash BYTEA NOT NULL,
    filename TEXT,
    content_type TEXT,
    size_bytes BIGINT,
    
    -- Verification
    last_verified_at TIMESTAMPTZ,
    verification_passed BOOLEAN,
    
    created_at_db TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_evidence_credential_hash ON evidence_files(credential_hash);
CREATE INDEX idx_evidence_sha256 ON evidence_files(sha256_hash);

-- Exceptions: compliance issues
CREATE TABLE exceptions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    exception_id BIGINT NOT NULL UNIQUE,    -- on-chain ID
    asset_id_hash BYTEA NOT NULL REFERENCES assets(asset_id_hash),
    related_credential_hash BYTEA,
    reason_code INT NOT NULL,
    reason exception_reason,
    details_pointer TEXT,
    opened_by TEXT NOT NULL,
    opened_at TIMESTAMPTZ NOT NULL,
    closed BOOLEAN DEFAULT FALSE,
    closed_by TEXT,
    closed_at TIMESTAMPTZ,
    resolution_pointer TEXT,
    block_number_opened BIGINT NOT NULL,
    tx_hash_opened TEXT NOT NULL,
    block_number_closed BIGINT,
    tx_hash_closed TEXT,
    
    created_at_db TIMESTAMPTZ DEFAULT NOW(),
    updated_at_db TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_exceptions_exception_id ON exceptions(exception_id);
CREATE INDEX idx_exceptions_asset_id_hash ON exceptions(asset_id_hash);
CREATE INDEX idx_exceptions_closed ON exceptions(closed);
CREATE INDEX idx_exceptions_opened_at ON exceptions(opened_at);

-- Verifications: audit log of verification attempts
CREATE TABLE verifications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    credential_hash BYTEA REFERENCES credentials(credential_hash),
    asset_id_hash BYTEA REFERENCES assets(asset_id_hash),
    status verification_status NOT NULL,
    checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    checked_by TEXT,                         -- user/system that ran check
    
    -- Detailed results
    credential_hash_valid BOOLEAN,
    evidence_root_valid BOOLEAN,
    chain_linkage_valid BOOLEAN,
    evidence_files_valid BOOLEAN,
    
    details JSONB,                           -- full verification report
    
    -- If failed, was exception auto-opened?
    exception_id BIGINT REFERENCES exceptions(exception_id)
);

CREATE INDEX idx_verifications_credential_hash ON verifications(credential_hash);
CREATE INDEX idx_verifications_asset_id_hash ON verifications(asset_id_hash);
CREATE INDEX idx_verifications_status ON verifications(status);
CREATE INDEX idx_verifications_checked_at ON verifications(checked_at);

-- Issuers: registered issuer organizations
CREATE TABLE issuers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    wallet_address TEXT NOT NULL UNIQUE,
    org_name TEXT,
    org_type TEXT,                           -- 'REPOSITORY', 'QC_LAB', 'SHIPPER', etc.
    is_active BOOLEAN DEFAULT TRUE,
    granted_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    
    created_at_db TIMESTAMPTZ DEFAULT NOW(),
    updated_at_db TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_issuers_wallet ON issuers(wallet_address);

-- Audit packs: generated audit packages
CREATE TABLE audit_packs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    asset_id_hash BYTEA NOT NULL REFERENCES assets(asset_id_hash),
    generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    generated_by TEXT,
    
    json_pointer TEXT,                       -- s3:// location of JSON
    pdf_pointer TEXT,                        -- s3:// location of PDF
    
    credential_count INT,
    exception_count INT,
    verification_summary JSONB,
    
    created_at_db TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_audit_packs_asset ON audit_packs(asset_id_hash);
CREATE INDEX idx_audit_packs_generated_at ON audit_packs(generated_at);

-- Sync state: track indexer progress
CREATE TABLE sync_state (
    id INT PRIMARY KEY DEFAULT 1,
    last_block_number BIGINT NOT NULL DEFAULT 0,
    last_synced_at TIMESTAMPTZ,
    
    CONSTRAINT single_row CHECK (id = 1)
);

INSERT INTO sync_state (last_block_number) VALUES (0) ON CONFLICT DO NOTHING;

-- ==================== Functions ====================

-- Update asset exception flag
CREATE OR REPLACE FUNCTION update_asset_exception_flag()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE assets 
    SET has_open_exceptions = EXISTS (
        SELECT 1 FROM exceptions 
        WHERE asset_id_hash = NEW.asset_id_hash AND closed = FALSE
    ),
    updated_at_db = NOW()
    WHERE asset_id_hash = NEW.asset_id_hash;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_exception_update_asset
AFTER INSERT OR UPDATE ON exceptions
FOR EACH ROW EXECUTE FUNCTION update_asset_exception_flag();

-- Update asset credential count
CREATE OR REPLACE FUNCTION update_asset_credential_count()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE assets 
    SET credential_count = (
        SELECT COUNT(*) FROM credentials WHERE asset_id_hash = NEW.asset_id_hash
    ),
    latest_credential_hash = NEW.credential_hash,
    updated_at_db = NOW()
    WHERE asset_id_hash = NEW.asset_id_hash;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_credential_update_asset
AFTER INSERT ON credentials
FOR EACH ROW EXECUTE FUNCTION update_asset_credential_count();

-- ==================== Views ====================

-- Asset summary view
CREATE VIEW v_asset_summary AS
SELECT 
    a.asset_id_hash,
    a.asset_id,
    a.pointer,
    a.registrar,
    a.created_at,
    a.credential_count,
    a.has_open_exceptions,
    (SELECT COUNT(*) FROM exceptions e WHERE e.asset_id_hash = a.asset_id_hash) as total_exceptions,
    (SELECT MAX(c.issued_at) FROM credentials c WHERE c.asset_id_hash = a.asset_id_hash) as last_credential_at
FROM assets a;

-- Credential chain view
CREATE VIEW v_credential_chain AS
SELECT 
    c.credential_hash,
    c.asset_id_hash,
    c.prev_hash,
    c.credential_type,
    c.issuer_org,
    c.issued_at,
    c.evidence_count,
    c.last_verification_status,
    ROW_NUMBER() OVER (PARTITION BY c.asset_id_hash ORDER BY c.issued_at) as chain_position
FROM credentials c;

-- Open exceptions view
CREATE VIEW v_open_exceptions AS
SELECT 
    e.*,
    a.asset_id,
    a.pointer as asset_pointer
FROM exceptions e
JOIN assets a ON e.asset_id_hash = a.asset_id_hash
WHERE e.closed = FALSE
ORDER BY e.opened_at DESC;
