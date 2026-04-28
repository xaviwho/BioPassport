CREATE TABLE materials (
  material_id TEXT PRIMARY KEY,
  material_type TEXT NOT NULL CHECK (material_type IN ('CELL_LINE', 'PLASMID')),
  metadata_hash BYTEA NOT NULL,
  owner_org TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'QUARANTINED', 'REVOKED')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE credentials (
  credential_id TEXT PRIMARY KEY,
  material_id TEXT REFERENCES materials(material_id),
  cred_type TEXT NOT NULL CHECK (cred_type IN ('IDENTITY', 'QC_MYCO', 'USAGE_RIGHTS')),
  commitment_hash BYTEA NOT NULL,
  issuer_id TEXT NOT NULL,
  issuer_signature BYTEA NOT NULL,
  issued_at TIMESTAMPTZ DEFAULT NOW(),
  valid_until TIMESTAMPTZ,
  artifact_cid TEXT,
  artifact_hash BYTEA,
  revoked BOOLEAN DEFAULT FALSE
);

CREATE INDEX idx_creds_material ON credentials(material_id);
CREATE INDEX idx_creds_issued_at ON credentials(issued_at);

CREATE TABLE transfers (
  transfer_id TEXT PRIMARY KEY,
  material_id TEXT REFERENCES materials(material_id),
  from_org TEXT,
  to_org TEXT,
  shipment_hash BYTEA,
  accepted BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_transfers_material ON transfers(material_id);
