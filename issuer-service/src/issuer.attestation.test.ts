import { ethers } from 'ethers';
import { ec as EC } from 'elliptic';
import { CredentialIssuer } from './issuer';
import { sha256, canonicalizeJson } from './crypto';
import { SignedAttestation } from './types';

describe('CredentialIssuer.issueFromAttestation', () => {
  const ec = new EC('secp256k1');

  function buildIssuer(storage: any, purechain: any): CredentialIssuer {
    return new CredentialIssuer(
      {
        orgId: 'OrgQC',
        privateKeyPath: '',
        purechainEndpoint: '',
        storageEndpoint: '',
        storageBucket: 'biopassport',
      },
      ec.genKeyPair(),
      storage,
      purechain
    );
  }

  async function buildAttestation(artifactBytes: Buffer) {
    const deviceWallet = ethers.Wallet.createRandom();
    const rawArtifactHash = '0x' + sha256(artifactBytes);
    const payload = {
      deviceId: ethers.keccak256(ethers.toUtf8Bytes('device:test:SN-0001')),
      instrumentId: 'microscope-01',
      materialId: 'bio:cell_line:1',
      materialType: 'CELL_LINE' as const,
      credentialType: 'QC_MYCO' as const,
      rawArtifactHash,
      captureTs: 1_700_000_000,
    };
    const attestationHash = ethers.keccak256(ethers.toUtf8Bytes('attestation-digest'));
    const signature = await deviceWallet.signMessage(ethers.getBytes(attestationHash));

    const attestation: SignedAttestation = {
      payload,
      payloadCanonical: canonicalizeJson(payload),
      attestationHash,
      signature,
      signerAddress: deviceWallet.address,
    };

    return { attestation, deviceWallet };
  }

  it('verifies and submits an edge-signed attestation', async () => {
    const artifactBytes = Buffer.from('raw instrument output');
    const { attestation, deviceWallet } = await buildAttestation(artifactBytes);
    const upload = {
      cid: 's3://biopassport/bio:cell_line:1/QC_MYCO/artifact.txt',
      hash: attestation.payload.rawArtifactHash.slice(2),
      filename: 'artifact.txt',
      contentType: 'text/plain',
      size: artifactBytes.length,
    };
    const storage = {
      uploadArtifactBuffer: jest.fn().mockResolvedValue(upload),
    };
    const purechain = {
      issueCredentialWithAttestation: jest.fn().mockResolvedValue({
        credentialId: 'cred:1',
        txHash: '0xtx',
        latencyMs: 12,
      }),
    };

    const issuer = buildIssuer(storage, purechain);
    const result = await issuer.issueFromAttestation(
      attestation,
      artifactBytes,
      'artifact.txt',
      deviceWallet.address
    );

    const expectedCommitmentHash = '0x' + sha256(canonicalizeJson(attestation.payload));
    expect(storage.uploadArtifactBuffer).toHaveBeenCalledWith(
      artifactBytes,
      'artifact.txt',
      'bio:cell_line:1',
      'QC_MYCO'
    );
    expect(purechain.issueCredentialWithAttestation).toHaveBeenCalledWith({
      materialId: 'bio:cell_line:1',
      credType: 'QC_MYCO',
      commitmentHash: expectedCommitmentHash,
      validUntil: 0,
      artifactCid: upload.cid,
      artifactHash: attestation.payload.rawArtifactHash,
      issuerId: 'OrgQC',
      deviceId: attestation.payload.deviceId,
      captureTs: attestation.payload.captureTs,
      deviceSig: attestation.signature,
    });
    expect(result.credentialId).toBe('cred:1');
    expect(result.commitmentHash).toBe(expectedCommitmentHash);
  });

  it('rejects signatures that do not recover to the expected device address', async () => {
    const artifactBytes = Buffer.from('raw instrument output');
    const { attestation } = await buildAttestation(artifactBytes);
    const issuer = buildIssuer({ uploadArtifactBuffer: jest.fn() }, { issueCredentialWithAttestation: jest.fn() });

    await expect(
      issuer.issueFromAttestation(attestation, artifactBytes, 'artifact.txt', ethers.Wallet.createRandom().address)
    ).rejects.toThrow('Device signature did not recover to expected address');
  });

  it('rejects artifacts whose bytes do not match the attested hash', async () => {
    const { attestation, deviceWallet } = await buildAttestation(Buffer.from('original output'));
    const issuer = buildIssuer({ uploadArtifactBuffer: jest.fn() }, { issueCredentialWithAttestation: jest.fn() });

    await expect(
      issuer.issueFromAttestation(attestation, Buffer.from('tampered output'), 'artifact.txt', deviceWallet.address)
    ).rejects.toThrow('Artifact hash mismatch');
  });
});
