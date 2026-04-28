/**
 * Live edge-attestation smoke test against a deployed BioPassportRegistry.
 *
 * Usage:
 *   BIOPASSPORT_CONTRACT_ADDRESS=0x... npx hardhat run scripts/smoke-edge-attestation.ts --network purechain
 */

import { ethers, network } from "hardhat";
import { Wallet } from "ethers";

async function main() {
  const address = process.env.BIOPASSPORT_CONTRACT_ADDRESS || process.env.CONTRACT_ADDRESS;
  if (!address) {
    throw new Error("Set BIOPASSPORT_CONTRACT_ADDRESS or CONTRACT_ADDRESS to the deployed registry address");
  }

  const [issuer] = await ethers.getSigners();
  const txOverrides = network.name === "purechain" ? { gasPrice: 0 } : {};
  const registry = await ethers.getContractAt("BioPassportRegistry", address);
  const chain = await ethers.provider.getNetwork();

  console.log("=".repeat(60));
  console.log("  BioPassport Edge Attestation Smoke Test");
  console.log("=".repeat(60));
  console.log("Network:", network.name, `(chainId: ${chain.chainId})`);
  console.log("Registry:", address);
  console.log("Issuer/deployer:", issuer.address);

  const device = Wallet.createRandom();
  const deviceId = ethers.keccak256(ethers.toUtf8Bytes(`device:smoke:${Date.now()}`));
  const metadataHash = ethers.keccak256(ethers.toUtf8Bytes(`edge-smoke-metadata-${Date.now()}`));
  const materialTx = await registry.registerMaterial("CELL_LINE", metadataHash, "EdgeSmokeOrg", txOverrides);
  const materialReceipt = await materialTx.wait();
  const materialEvent = materialReceipt?.logs
    .map((log: any) => {
      try {
        return registry.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed: any) => parsed?.name === "MaterialRegistered");
  if (!materialEvent) {
    throw new Error("MaterialRegistered event not found");
  }
  const materialId = `bio:cell_line:${await registry.materialCount()}`;

  console.log("Material registered:", materialId);

  const enrollTx = await registry.enrollDevice(deviceId, device.address, "MICROSCOPE", txOverrides);
  await enrollTx.wait();
  console.log("Device enrolled:", deviceId, device.address);

  const commitment = ethers.keccak256(ethers.toUtf8Bytes(`edge-smoke-credential-${Date.now()}`));
  const artifactHash = ethers.keccak256(ethers.toUtf8Bytes("edge-smoke-artifact"));
  const captureTs = Math.floor(Date.now() / 1000) - 30;
  const payload = ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "string", "uint8", "bytes32", "bytes32", "uint256"],
    [deviceId, materialId, 1, commitment, artifactHash, captureTs]
  );
  const digest = ethers.keccak256(payload);
  const signature = await device.signMessage(ethers.getBytes(digest));

  const issueTx = await registry.issueCredentialWithAttestation(
    materialId,
    1,
    commitment,
    0,
    "s3://edge-smoke/qc.txt",
    artifactHash,
    "EdgeSmokeOrg",
    deviceId,
    captureTs,
    signature,
    txOverrides
  );
  const issueReceipt = await issueTx.wait();
  const attestationEvent = issueReceipt?.logs
    .map((log: any) => {
      try {
        return registry.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed: any) => parsed?.name === "AttestationVerified");

  if (!attestationEvent) {
    throw new Error("AttestationVerified event not found");
  }

  const credentialId = `cred:${await registry.credentialCount()}`;
  console.log("Attestation verified:");
  console.log("  credentialId:", credentialId);
  console.log("  deviceId:", attestationEvent.args.deviceId);
  console.log("  attestationHash:", attestationEvent.args.attestationHash);
  console.log("  tx:", issueReceipt?.hash);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
