import { pino } from 'pino';
import { commitmentHashForPayload, sha256File, signAttestation } from './attestation.js';
import { watchDirectory } from './instrument-adapters/file-watch.js';
import { SoftwareSigner } from './signer.js';
import { submitAttestation } from './transport.js';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });

async function main() {
  const watchDir = process.env.WATCH_DIR ?? './watch';
  const instrumentId = process.env.INSTRUMENT_ID ?? 'microscope-01';
  const deviceIdRaw = process.env.DEVICE_ID ?? 'device:dev:SN-0001';
  const issuerUrl = process.env.ISSUER_URL ?? 'http://localhost:8080';
  const keyPath = process.env.DEVICE_KEY_PATH ?? './keys/device.key';

  const signer = SoftwareSigner.fromFile(keyPath, deviceIdRaw);
  log.info({ deviceAddress: await signer.getDeviceAddress(), deviceId: await signer.getDeviceId() }, 'IEN starting');

  const stop = watchDirectory(watchDir, instrumentId, async (evt) => {
    try {
      log.info({ file: evt.filePath }, 'new instrument output detected');
      const rawHash = await sha256File(evt.filePath);
      const rawHashBytes32 = '0x' + rawHash.replace(/^0x/, '').padStart(64, '0');

      const payload = {
        deviceId: await signer.getDeviceId(),
        instrumentId,
        materialId: process.env.MATERIAL_ID ?? 'bio:cell_line:dev',
        materialType: 'CELL_LINE' as const,
        credentialType: 'QC_MYCO' as const,
        rawArtifactHash: rawHashBytes32,
        captureTs: Math.floor(evt.detectedAt / 1000),
      };
      const commitmentHash = commitmentHashForPayload(payload);

      const att = await signAttestation(signer, payload, rawHashBytes32, commitmentHash);
      log.info({ attestationHash: att.attestationHash }, 'attestation signed');

      const result = await submitAttestation({ issuerUrl }, att, evt.filePath);
      log.info({ credentialId: result.credentialId }, 'credential anchored on-chain');
    } catch (err) {
      log.error({ err }, 'attestation pipeline failed');
    }
  });

  process.on('SIGINT', async () => {
    await stop();
    process.exit(0);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
