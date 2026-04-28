import express from 'express';
import * as crypto from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { pool, closePool } from './db';
import { signCanonical } from './crypto';

type MaterialType = 'CELL_LINE' | 'PLASMID';
type CredentialType = 'IDENTITY' | 'QC_MYCO' | 'USAGE_RIGHTS';
type MaterialStatus = 'ACTIVE' | 'QUARANTINED' | 'REVOKED';

interface VerifyResponse {
  pass: boolean;
  reasons: string[];
}

const app = express();
app.use(express.json({ limit: '50mb' }));

function normalizeHex(hex: string): string {
  return hex.replace(/^0x/, '');
}

function hexToBuffer(hex: string): Buffer {
  const normalized = normalizeHex(hex);
  if (!/^[0-9a-fA-F]*$/.test(normalized)) {
    throw new Error('invalid hex payload');
  }
  return Buffer.from(normalized, 'hex');
}

function randomHashBuffer(): Buffer {
  return crypto.randomBytes(32);
}

function materialPrefix(materialType: MaterialType): string {
  return materialType.toLowerCase();
}

function parseValidUntil(raw: unknown): Date | null {
  if (raw === null || raw === undefined || raw === '' || raw === 0) {
    return null;
  }

  if (typeof raw === 'number') {
    if (raw <= 0) return null;
    return new Date(raw > 1_000_000_000_000 ? raw : raw * 1000);
  }

  const date = new Date(String(raw));
  if (Number.isNaN(date.getTime())) {
    throw new Error('invalid validUntil');
  }
  return date;
}

async function verifyMaterial(materialId: string): Promise<VerifyResponse> {
  const reasons: string[] = [];

  const materialResult = await pool.query<{
    material_id: string;
    status: MaterialStatus;
  }>('SELECT material_id, status FROM materials WHERE material_id = $1', [materialId]);

  if ((materialResult.rowCount ?? 0) === 0) {
    return { pass: false, reasons: ['MATERIAL_NOT_FOUND'] };
  }

  const material = materialResult.rows[0];
  if (material.status !== 'ACTIVE') {
    reasons.push(`MATERIAL_${material.status}`);
  }

  const identityResult = await pool.query(
    `SELECT credential_id
       FROM credentials
      WHERE material_id = $1
        AND cred_type = 'IDENTITY'
        AND revoked = FALSE
      ORDER BY issued_at DESC
      LIMIT 1`,
    [materialId]
  );
  if ((identityResult.rowCount ?? 0) === 0) {
    reasons.push('MISSING_IDENTITY');
  }

  const qcResult = await pool.query<{
    credential_id: string;
    valid_until: Date | null;
  }>(
    `SELECT credential_id, valid_until
       FROM credentials
      WHERE material_id = $1
        AND cred_type = 'QC_MYCO'
        AND revoked = FALSE
      ORDER BY issued_at DESC
      LIMIT 1`,
    [materialId]
  );
  if ((qcResult.rowCount ?? 0) === 0) {
    reasons.push('QC_MISSING');
  } else {
    const qc = qcResult.rows[0];
    if (qc.valid_until && qc.valid_until.getTime() < Date.now()) {
      reasons.push('QC_EXPIRED');
    }
  }

  const pendingResult = await pool.query(
    'SELECT transfer_id FROM transfers WHERE material_id = $1 AND accepted = FALSE LIMIT 1',
    [materialId]
  );
  if ((pendingResult.rowCount ?? 0) > 0) {
    reasons.push('TRANSFER_PENDING');
  }

  return {
    pass: reasons.length === 0,
    reasons,
  };
}

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/materials', async (req, res, next) => {
  try {
    const { materialType, metadataHashHex, ownerOrg } = req.body as {
      materialType: MaterialType;
      metadataHashHex: string;
      ownerOrg: string;
    };

    if (!materialType || !metadataHashHex || !ownerOrg) {
      return res.status(400).json({ error: 'materialType, metadataHashHex, and ownerOrg are required' });
    }

    const materialId = `bio:${materialPrefix(materialType)}:${randomUUID()}`;
    await pool.query(
      `INSERT INTO materials (material_id, material_type, metadata_hash, owner_org)
       VALUES ($1, $2, $3, $4)`,
      [materialId, materialType, hexToBuffer(metadataHashHex), ownerOrg]
    );

    res.json({ materialId });
  } catch (error) {
    next(error);
  }
});

app.post('/credentials', async (req, res, next) => {
  try {
    const {
      materialId,
      credType,
      payload,
      validUntil,
      artifactCid,
      artifactHashHex,
      issuerId,
    } = req.body as {
      materialId: string;
      credType: CredentialType;
      payload: unknown;
      validUntil?: string | number | null;
      artifactCid?: string | null;
      artifactHashHex?: string | null;
      issuerId: string;
    };

    if (!materialId || !credType || payload === undefined || !issuerId) {
      return res.status(400).json({ error: 'materialId, credType, payload, and issuerId are required' });
    }

    const materialResult = await pool.query('SELECT material_id FROM materials WHERE material_id = $1', [materialId]);
    if ((materialResult.rowCount ?? 0) === 0) {
      return res.status(404).json({ error: 'material not found' });
    }

    const credentialId = `cred:${randomUUID()}`;
    const { commitment, signature } = signCanonical(payload);
    const artifactHash = artifactHashHex ? hexToBuffer(artifactHashHex) : null;

    await pool.query(
      `INSERT INTO credentials
         (credential_id, material_id, cred_type, commitment_hash, issuer_id, issuer_signature, valid_until, artifact_cid, artifact_hash)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [credentialId, materialId, credType, commitment, issuerId, signature, parseValidUntil(validUntil), artifactCid ?? null, artifactHash]
    );

    res.json({ credentialId });
  } catch (error) {
    next(error);
  }
});

app.post('/transfers', async (req, res, next) => {
  try {
    const { materialId, toOrg, shipmentHashHex } = req.body as {
      materialId: string;
      toOrg: string;
      shipmentHashHex: string;
    };

    if (!materialId || !toOrg || !shipmentHashHex) {
      return res.status(400).json({ error: 'materialId, toOrg, and shipmentHashHex are required' });
    }

    const materialResult = await pool.query<{ owner_org: string }>(
      'SELECT owner_org FROM materials WHERE material_id = $1',
      [materialId]
    );
    if ((materialResult.rowCount ?? 0) === 0) {
      return res.status(404).json({ error: 'material not found' });
    }

    const transferId = `transfer:${randomUUID()}`;
    await pool.query(
      `INSERT INTO transfers (transfer_id, material_id, from_org, to_org, shipment_hash)
       VALUES ($1, $2, $3, $4, $5)`,
      [transferId, materialId, materialResult.rows[0].owner_org, toOrg, hexToBuffer(shipmentHashHex)]
    );

    res.json({ transferId });
  } catch (error) {
    next(error);
  }
});

app.post('/transfers/:id/accept', async (req, res, next) => {
  try {
    const transferId = req.params.id;
    const transferResult = await pool.query<{ material_id: string; to_org: string }>(
      `UPDATE transfers
          SET accepted = TRUE
        WHERE transfer_id = $1
        RETURNING material_id, to_org`,
      [transferId]
    );

    if ((transferResult.rowCount ?? 0) === 0) {
      return res.status(404).json({ error: 'transfer not found' });
    }

    const transfer = transferResult.rows[0];
    await pool.query(
      `UPDATE materials
          SET owner_org = $2,
              updated_at = NOW()
        WHERE material_id = $1`,
      [transfer.material_id, transfer.to_org]
    );

    res.json({ accepted: true });
  } catch (error) {
    next(error);
  }
});

app.post('/materials/:id/status', async (req, res, next) => {
  try {
    const materialId = req.params.id;
    const { status } = req.body as { status: MaterialStatus; reasonHash?: string };

    if (!status) {
      return res.status(400).json({ error: 'status is required' });
    }

    const result = await pool.query(
      `UPDATE materials
          SET status = $2,
              updated_at = NOW()
        WHERE material_id = $1`,
      [materialId, status]
    );

    if ((result.rowCount ?? 0) === 0) {
      return res.status(404).json({ error: 'material not found' });
    }

    res.json({ materialId, status });
  } catch (error) {
    next(error);
  }
});

app.get('/verify/:materialId', async (req, res, next) => {
  try {
    res.json(await verifyMaterial(req.params.materialId));
  } catch (error) {
    next(error);
  }
});

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(500).json({ error: err.message });
});

const port = Number(process.env.PORT ?? 3100);
const server = app.listen(port, () => {
  console.log(`postgres-baseline listening on :${port}`);
});

async function shutdown() {
  server.close(async () => {
    await closePool();
    process.exit(0);
  });
}

process.on('SIGINT', () => {
  void shutdown();
});

process.on('SIGTERM', () => {
  void shutdown();
});
