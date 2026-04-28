/**
 * BioPassport Issuer Service
 * 
 * Express API for credential issuance
 */

import express, { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { createIssuer, CredentialIssuer } from './issuer';
import { MaterialMetadata, CredentialPayload } from './types';

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
app.use(express.json());

let issuer: CredentialIssuer;

// Initialize issuer on startup
async function initializeIssuer(): Promise<void> {
  issuer = createIssuer();
  await issuer.init();
  console.log('Issuer service initialized');
}

// Health check
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'biopassport-issuer' });
});

// Register material
app.post('/materials', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { materialType, metadata } = req.body as {
      materialType: string;
      metadata: MaterialMetadata;
    };

    if (!materialType || !metadata) {
      res.status(400).json({ error: 'materialType and metadata are required' });
      return;
    }

    const result = await issuer.registerMaterial(materialType, metadata);
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

// Issue credential
app.post('/credentials', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { materialId, credentialType, payload, validityDays } = req.body as {
      materialId: string;
      credentialType: string;
      payload: CredentialPayload;
      validityDays?: number;
    };

    if (!materialId || !credentialType || !payload) {
      res.status(400).json({ error: 'materialId, credentialType, and payload are required' });
      return;
    }

    const result = await issuer.issueCredential(
      materialId,
      credentialType,
      payload,
      [],
      validityDays || 90
    );
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

// Issue mycoplasma QC credential
app.post('/credentials/qc-myco', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { materialId, result: testResult, testMethod, testDate, laboratory, options } = req.body;

    if (!materialId || !testResult || !testMethod || !testDate || !laboratory) {
      res.status(400).json({ 
        error: 'materialId, result, testMethod, testDate, and laboratory are required' 
      });
      return;
    }

    const result = await issuer.issueMycoCredential(
      materialId,
      testResult,
      testMethod,
      testDate,
      laboratory,
      options || {}
    );
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

app.post('/v1/attested-credential', upload.single('artifact'), async (req: Request, res: Response) => {
  try {
    if (!req.body.attestation || !req.file) {
      res.status(400).json({ error: 'attestation and artifact are required' });
      return;
    }

    const attestation = JSON.parse(req.body.attestation);
    const device = await issuer.getDevice(attestation.payload.deviceId);
    if (!device || device.revokedAt !== 0n) {
      res.status(400).json({ error: 'device not enrolled or revoked' });
      return;
    }

    const result = await issuer.issueFromAttestation(
      attestation,
      req.file.buffer,
      req.file.originalname,
      device.deviceAddress
    );
    res.status(201).json(result);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Transfer material
app.post('/transfers', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { materialId, toOrg } = req.body as {
      materialId: string;
      toOrg: string;
    };

    if (!materialId || !toOrg) {
      res.status(400).json({ error: 'materialId and toOrg are required' });
      return;
    }

    const result = await issuer.transferMaterial(materialId, toOrg);
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

// Set material status
app.patch('/materials/:materialId/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { materialId } = req.params;
    const { status, reason } = req.body as {
      status: 'ACTIVE' | 'QUARANTINED' | 'REVOKED';
      reason: string;
    };

    if (!status || !reason) {
      res.status(400).json({ error: 'status and reason are required' });
      return;
    }

    const result = await issuer.setMaterialStatus(materialId, status, reason);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// Revoke credential
app.delete('/credentials/:credentialId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { credentialId } = req.params;
    const { reason } = req.body as { reason: string };

    if (!reason) {
      res.status(400).json({ error: 'reason is required' });
      return;
    }

    const result = await issuer.revokeCredential(credentialId, reason);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// Error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Error:', err.message);
  res.status(500).json({ error: err.message });
});

// Start server
const PORT = process.env.PORT || 3001;

initializeIssuer()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Issuer service listening on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error('Failed to initialize issuer:', error);
    process.exit(1);
  });

export default app;
