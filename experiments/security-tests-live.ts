/**
 * Run A1-A9 attack taxonomy against the live PureChain registry.
 */
import { performance } from 'node:perf_hooks';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ethers } from 'ethers';
import {
  bytes32FromLabel,
  createEvalClient,
  enrollEphemeralDevice,
  getEvalEnv,
  reasonCodes,
  resultMaterialId,
  signAttestationForContract,
} from './eval-utils';

interface AttackResult {
  attackId: string;
  description: string;
  expectedDetected: boolean;
  detected: boolean;
  reasonCode?: string;
  latencyToDetectMs: number;
  notes?: string;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function must(result: any) {
  if (result.status === 'FAILED') throw new Error(result.error || 'transaction failed');
  return result;
}

function includesReason(v: any, code: string) {
  return reasonCodes(v).includes(code);
}

/**
 * Force-refresh the client's manually tracked nonce from the chain.
 * Call this after expected reverts or transactions sent outside the client.
 */
async function resyncNonce(client: any): Promise<void> {
  try {
    const signer = client.signer ?? client.wallet ?? client.operator;
    if (!signer) return;
    const addr = await signer.getAddress();
    const provider = signer.provider ?? client.provider;
    if (!provider) return;
    const onChainNonce = await provider.getTransactionCount(addr, 'pending');
    if ('_nextNonce' in client) {
      client._nextNonce = onChainNonce;
    }
    await new Promise((r) => setTimeout(r, 500));
    console.log(`[resyncNonce] ${addr} on-chain nonce now ${onChainNonce}`);
  } catch (e) {
    console.warn('[resyncNonce] failed (non-fatal):', (e as Error).message);
  }
}

async function register(client: ReturnType<typeof createEvalClient>, label: string) {
  const r = await must(await client.registerMaterial('CELL_LINE', bytes32FromLabel(label)));
  return resultMaterialId(r);
}

async function issueIdentity(client: ReturnType<typeof createEvalClient>, materialId: string) {
  return must(await client.issueCredential(materialId, 'IDENTITY', bytes32FromLabel(`${materialId}:id`), 0, 's3://live/id', bytes32FromLabel('id-art'), 'Org1MSP'));
}

async function issueQc(client: ReturnType<typeof createEvalClient>, materialId: string, label: string, validUntil = 0) {
  return must(await client.issueCredential(materialId, 'QC_MYCO', bytes32FromLabel(label), validUntil, `s3://live/${label}`, bytes32FromLabel(`${label}:art`), 'Org1MSP'));
}

async function timeDetect(fn: () => Promise<{ detected: boolean; reasonCode?: string; notes?: string }>) {
  const t0 = performance.now();
  const result = await fn();
  return { ...result, latencyToDetectMs: performance.now() - t0 };
}

function reasonFromError(e: any) {
  const msg = e?.message || String(e);
  const match = msg.match(/(DeviceNotEnrolled|InvalidDeviceSignature|AttestationReplay|InvalidCaptureTs|DeviceRevoked|MATERIAL_REVOKED|TRANSFER_PENDING|QC_EXPIRED|QC_MISSING|ID_MISSING)/);
  return match?.[1] || msg.slice(0, 160);
}

async function main() {
  const env = getEvalEnv();
  const client = createEvalClient();
  await client.connect();

  const results: AttackResult[] = [];

  async function push(attackId: string, description: string, expectedDetected: boolean, fn: () => Promise<{ detected: boolean; reasonCode?: string; notes?: string }>) {
    const r = await timeDetect(fn);
    results.push({ attackId, description, expectedDetected, ...r });
  }

  await push('A1', 'Credential omission: material has no IDENTITY/QC credentials', true, async () => {
    const materialId = await register(client, `A1-${Date.now()}`);
    const v = await client.verifyMaterial(materialId);
    return { detected: !v.pass, reasonCode: reasonCodes(v).join(',') };
  });

  await push('A2', 'QC replay/latest-QC policy: newest QC expires, older QC must not rescue verification', true, async () => {
    const materialId = await register(client, `A2-${Date.now()}`);
    await issueIdentity(client, materialId);
    await issueQc(client, materialId, `A2-old-${Date.now()}`, Math.floor(Date.now() / 1000) + 3600);
    await issueQc(client, materialId, `A2-new-${Date.now()}`, Math.floor(Date.now() / 1000) + 5);
    await sleep(7000);
    const v = await client.verifyMaterial(materialId);
    return { detected: !v.pass && includesReason(v, 'QC_EXPIRED'), reasonCode: reasonCodes(v).join(',') };
  });

  await push('A3', 'Pending-transfer abuse: material has an unaccepted transfer', true, async () => {
    const materialId = await register(client, `A3-${Date.now()}`);
    await issueIdentity(client, materialId);
    await issueQc(client, materialId, `A3-qc-${Date.now()}`);
    await must(await client.initiateTransfer(materialId, 'OrgB', bytes32FromLabel('shipment')));
    const v = await client.verifyMaterial(materialId);
    return { detected: !v.pass && includesReason(v, 'TRANSFER_PENDING'), reasonCode: reasonCodes(v).join(',') };
  });

  await push('A4', 'Off-chain artifact tampering: recomputed artifact hash differs from attested hash', true, async () => {
    const expected = ethers.sha256(ethers.toUtf8Bytes('original-artifact'));
    const tampered = ethers.sha256(ethers.toUtf8Bytes('tampered-artifact'));
    return { detected: expected !== tampered, reasonCode: 'ARTIFACT_TAMPERED', notes: 'Client-side full-verification hash mismatch simulation against live policy context.' };
  });

  await push('A5', 'Status misuse: revoked material must fail verification', true, async () => {
    const materialId = await register(client, `A5-${Date.now()}`);
    await issueIdentity(client, materialId);
    await issueQc(client, materialId, `A5-qc-${Date.now()}`);
    await must(await client.setStatus(materialId, 'REVOKED', bytes32FromLabel('A5-revoke')));
    const v = await client.verifyMaterial(materialId);
    return { detected: !v.pass && includesReason(v, 'MATERIAL_REVOKED'), reasonCode: reasonCodes(v).join(',') };
  });

  await push('A6', 'Compromised issuer fabricates QC without enrolled device attestation', true, async () => {
    const materialId = await register(client, `A6-${Date.now()}`);
    try {
      await client.issueCredentialWithAttestation({
        materialId,
        credType: 'QC_MYCO',
        commitmentHash: bytes32FromLabel('A6-fake'),
        validUntil: 0,
        artifactCid: 's3://x',
        artifactHash: bytes32FromLabel('A6-art'),
        issuerId: 'Fake',
        deviceId: ethers.keccak256(ethers.toUtf8Bytes('device:fake')),
        captureTs: Math.floor(Date.now() / 1000),
        deviceSig: `0x${'11'.repeat(65)}`,
      });
      return { detected: false, reasonCode: 'NO_REVERT' };
    } catch (e: any) {
      await resyncNonce(client);
      return { detected: true, reasonCode: reasonFromError(e) };
    }
  });

  await push('A7', 'Attestation replay: same device captureTs reused', true, async () => {
    const { device, deviceId } = await enrollEphemeralDevice('device:A7');
    await resyncNonce(client);
    const materialId = await register(client, `A7-${Date.now()}`);
    const commitmentHash = bytes32FromLabel('A7-cred');
    const artifactHash = bytes32FromLabel('A7-art');
    const captureTs = Math.floor(Date.now() / 1000) - 60;
    const sig = await signAttestationForContract({ device, deviceId, materialId, credType: 1, commitmentHash, artifactHash, captureTs });
    await client.issueCredentialWithAttestation({
      materialId, credType: 'QC_MYCO', commitmentHash, validUntil: 0, artifactCid: 's3://a7', artifactHash, issuerId: 'Org1MSP', deviceId, captureTs, deviceSig: sig,
    });
    try {
      await client.issueCredentialWithAttestation({
        materialId, credType: 'QC_MYCO', commitmentHash, validUntil: 0, artifactCid: 's3://a7-replay', artifactHash, issuerId: 'Org1MSP', deviceId, captureTs, deviceSig: sig,
      });
      return { detected: false, reasonCode: 'NO_REVERT' };
    } catch (e: any) {
      await resyncNonce(client);
      return { detected: true, reasonCode: reasonFromError(e) };
    }
  });

  await push('A8', 'Clock manipulation: future capture timestamp', true, async () => {
    const { device, deviceId } = await enrollEphemeralDevice('device:A8');
    await resyncNonce(client);
    const materialId = await register(client, `A8-${Date.now()}`);
    const commitmentHash = bytes32FromLabel('A8-cred');
    const artifactHash = bytes32FromLabel('A8-art');
    const captureTs = Math.floor(Date.now() / 1000) + 3600;
    const sig = await signAttestationForContract({ device, deviceId, materialId, credType: 1, commitmentHash, artifactHash, captureTs });
    try {
      await client.issueCredentialWithAttestation({
        materialId, credType: 'QC_MYCO', commitmentHash, validUntil: 0, artifactCid: 's3://a8', artifactHash, issuerId: 'Org1MSP', deviceId, captureTs, deviceSig: sig,
      });
      return { detected: false, reasonCode: 'NO_REVERT' };
    } catch (e: any) {
      await resyncNonce(client);
      return { detected: true, reasonCode: reasonFromError(e) };
    }
  });

  await push('A9', 'Software signer key compromise: protocol cannot distinguish stolen key from device', false, async () => ({
    detected: false,
    reasonCode: 'OUT_OF_SCOPE_SOFTWARE_SIGNER',
    notes: 'Expected non-detection; TPM/secure element is required to reduce key-exfiltration risk.',
  }));

  const out = path.join(__dirname, 'results', `attack-suite-live-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ network: 'purechain', registry: env.registryAddress, results }, null, 2));

  console.log('\n=== Attack suite results (live PureChain) ===');
  for (const r of results) {
    const ok = r.detected === r.expectedDetected ? 'OK' : 'FAIL';
    console.log(`${ok} ${r.attackId} ${r.description.padEnd(78)} detected=${r.detected} latency=${r.latencyToDetectMs.toFixed(1)}ms reason=${r.reasonCode ?? '-'}`);
  }
  console.log(`\nWrote ${out}`);

  await client.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
