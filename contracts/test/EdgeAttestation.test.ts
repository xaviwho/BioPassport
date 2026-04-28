import { expect } from "chai";
import { ethers } from "hardhat";
import { Wallet } from "ethers";
import { BioPassportRegistry } from "../typechain-types";

describe("Edge Attestation (INV-9)", () => {
  let registry: BioPassportRegistry;
  let admin: any;
  let issuer: Wallet;
  let device: Wallet;
  let deviceId: string;

  const CRED_TYPE_QC = 1;

  beforeEach(async () => {
    [admin] = await ethers.getSigners();

    const Registry = await ethers.getContractFactory("BioPassportRegistry");
    registry = (await Registry.deploy()) as BioPassportRegistry;
    await registry.waitForDeployment();

    issuer = ethers.Wallet.createRandom().connect(ethers.provider);
    device = ethers.Wallet.createRandom().connect(ethers.provider);

    await admin.sendTransaction({
      to: issuer.address,
      value: ethers.parseEther("1.0"),
    });

    await registry.authorizeIssuer(issuer.address, false, true, false);

    deviceId = ethers.keccak256(ethers.toUtf8Bytes("device:olympus:SN-0001"));
    await registry.enrollDevice(deviceId, device.address, "MICROSCOPE");

    await registry.connect(admin).registerMaterial(
      "CELL_LINE",
      ethers.keccak256(ethers.toUtf8Bytes("metadata-v1")),
      "OrgA"
    );
  });

  async function signAttestation(
    signer: Wallet,
    materialId: string,
    credType: number,
    commitmentHash: string,
    artifactHash: string,
    captureTs: number
  ): Promise<string> {
    const payload = ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "string", "uint8", "bytes32", "bytes32", "uint256"],
      [deviceId, materialId, credType, commitmentHash, artifactHash, captureTs]
    );
    const digest = ethers.keccak256(payload);
    return signer.signMessage(ethers.getBytes(digest));
  }

  it("accepts a valid device-signed QC credential", async () => {
    const materialId = "bio:cell_line:1";
    const commitment = ethers.keccak256(ethers.toUtf8Bytes("cred-payload"));
    const artifactHash = ethers.keccak256(ethers.toUtf8Bytes("artifact-bytes"));
    const captureTs = Math.floor(Date.now() / 1000) - 60;

    const sig = await signAttestation(device, materialId, CRED_TYPE_QC, commitment, artifactHash, captureTs);

    await expect(
      registry.connect(issuer).issueCredentialWithAttestation(
        materialId,
        CRED_TYPE_QC,
        commitment,
        0,
        "s3://bucket/qc.pdf",
        artifactHash,
        "OrgQC",
        deviceId,
        captureTs,
        sig
      )
    ).to.emit(registry, "AttestationVerified");
  });

  it("rejects signature from wrong device", async () => {
    const wrongDevice = ethers.Wallet.createRandom();
    const materialId = "bio:cell_line:1";
    const commitment = ethers.keccak256(ethers.toUtf8Bytes("cred-payload"));
    const artifactHash = ethers.keccak256(ethers.toUtf8Bytes("artifact-bytes"));
    const captureTs = Math.floor(Date.now() / 1000) - 60;

    const sig = await signAttestation(wrongDevice as Wallet, materialId, CRED_TYPE_QC, commitment, artifactHash, captureTs);

    await expect(
      registry.connect(issuer).issueCredentialWithAttestation(
        materialId,
        CRED_TYPE_QC,
        commitment,
        0,
        "s3://bucket/qc.pdf",
        artifactHash,
        "OrgQC",
        deviceId,
        captureTs,
        sig
      )
    ).to.be.revertedWithCustomError(registry, "InvalidDeviceSignature");
  });

  it("rejects replay: captureTs must be strictly increasing", async () => {
    const materialId = "bio:cell_line:1";
    const commitment = ethers.keccak256(ethers.toUtf8Bytes("cred-payload"));
    const artifactHash = ethers.keccak256(ethers.toUtf8Bytes("artifact-bytes"));
    const ts1 = Math.floor(Date.now() / 1000) - 120;

    const sig1 = await signAttestation(device, materialId, CRED_TYPE_QC, commitment, artifactHash, ts1);
    await registry.connect(issuer).issueCredentialWithAttestation(
      materialId,
      CRED_TYPE_QC,
      commitment,
      0,
      "s3://bucket/qc.pdf",
      artifactHash,
      "OrgQC",
      deviceId,
      ts1,
      sig1
    );

    const sig2 = await signAttestation(device, materialId, CRED_TYPE_QC, commitment, artifactHash, ts1);
    await expect(
      registry.connect(issuer).issueCredentialWithAttestation(
        materialId,
        CRED_TYPE_QC,
        commitment,
        0,
        "s3://bucket/qc.pdf",
        artifactHash,
        "OrgQC",
        deviceId,
        ts1,
        sig2
      )
    ).to.be.revertedWithCustomError(registry, "AttestationReplay");
  });

  it("rejects attestation from revoked device", async () => {
    await registry.revokeDevice(deviceId);

    const materialId = "bio:cell_line:1";
    const commitment = ethers.keccak256(ethers.toUtf8Bytes("cred-payload"));
    const artifactHash = ethers.keccak256(ethers.toUtf8Bytes("artifact-bytes"));
    const captureTs = Math.floor(Date.now() / 1000) - 60;

    const sig = await signAttestation(device, materialId, CRED_TYPE_QC, commitment, artifactHash, captureTs);

    await expect(
      registry.connect(issuer).issueCredentialWithAttestation(
        materialId,
        CRED_TYPE_QC,
        commitment,
        0,
        "s3://bucket/qc.pdf",
        artifactHash,
        "OrgQC",
        deviceId,
        captureTs,
        sig
      )
    ).to.be.revertedWithCustomError(registry, "DeviceRevoked");
  });

  it("rejects future captureTs", async () => {
    const materialId = "bio:cell_line:1";
    const commitment = ethers.keccak256(ethers.toUtf8Bytes("cred-payload"));
    const artifactHash = ethers.keccak256(ethers.toUtf8Bytes("artifact-bytes"));
    const futureTs = Math.floor(Date.now() / 1000) + 3600;

    const sig = await signAttestation(device, materialId, CRED_TYPE_QC, commitment, artifactHash, futureTs);

    await expect(
      registry.connect(issuer).issueCredentialWithAttestation(
        materialId,
        CRED_TYPE_QC,
        commitment,
        0,
        "s3://bucket/qc.pdf",
        artifactHash,
        "OrgQC",
        deviceId,
        futureTs,
        sig
      )
    ).to.be.revertedWithCustomError(registry, "InvalidCaptureTs");
  });

  it("rejects issuance for unenrolled device", async () => {
    const unknownDevice = ethers.keccak256(ethers.toUtf8Bytes("device:unknown:SN-9999"));
    const materialId = "bio:cell_line:1";
    const commitment = ethers.keccak256(ethers.toUtf8Bytes("cred-payload"));
    const artifactHash = ethers.keccak256(ethers.toUtf8Bytes("artifact-bytes"));
    const captureTs = Math.floor(Date.now() / 1000) - 60;

    const sig = await signAttestation(device, materialId, CRED_TYPE_QC, commitment, artifactHash, captureTs);

    await expect(
      registry.connect(issuer).issueCredentialWithAttestation(
        materialId,
        CRED_TYPE_QC,
        commitment,
        0,
        "s3://bucket/qc.pdf",
        artifactHash,
        "OrgQC",
        unknownDevice,
        captureTs,
        sig
      )
    ).to.be.revertedWithCustomError(registry, "DeviceNotEnrolled");
  });
});
