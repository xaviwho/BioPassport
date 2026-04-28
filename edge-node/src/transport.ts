import fetch from 'node-fetch';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { SignedAttestation } from './types.js';

export interface TransportConfig {
  issuerUrl: string;
  clientCertPath?: string;
  clientKeyPath?: string;
  caCertPath?: string;
}

export async function submitAttestation(
  cfg: TransportConfig,
  attestation: SignedAttestation,
  artifactPath: string
): Promise<{ credentialId: string }> {
  const form = new FormData();
  form.append('attestation', JSON.stringify(attestation));
  form.append('artifact', new Blob([fs.readFileSync(artifactPath)]), path.basename(artifactPath));

  const agent = cfg.clientCertPath && cfg.clientKeyPath
    ? new https.Agent({
        cert: fs.readFileSync(cfg.clientCertPath),
        key: fs.readFileSync(cfg.clientKeyPath),
        ca: cfg.caCertPath ? fs.readFileSync(cfg.caCertPath) : undefined,
      })
    : undefined;

  const res = await fetch(`${cfg.issuerUrl}/v1/attested-credential`, {
    method: 'POST',
    body: form as any,
    agent: agent as any,
  } as any);

  if (!res.ok) throw new Error(`Issuer rejected attestation: ${res.status} ${await res.text()}`);
  return (await res.json()) as { credentialId: string };
}
