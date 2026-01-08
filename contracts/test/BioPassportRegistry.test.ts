import { expect } from "chai";
import { ethers } from "hardhat";
import { BioPassportRegistry } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("BioPassportRegistry", function () {
  let registry: BioPassportRegistry;
  let admin: SignerWithAddress;
  let repositoryIssuer: SignerWithAddress;
  let qcLabIssuer: SignerWithAddress;
  let labA: SignerWithAddress;
  let labB: SignerWithAddress;
  let unauthorized: SignerWithAddress;

  const CELL_LINE = "CELL_LINE";
  const PLASMID = "PLASMID";
  const ZERO_HASH = ethers.ZeroHash;

  beforeEach(async function () {
    [admin, repositoryIssuer, qcLabIssuer, labA, labB, unauthorized] = await ethers.getSigners();

    const BioPassportRegistry = await ethers.getContractFactory("BioPassportRegistry");
    registry = await BioPassportRegistry.deploy();
    await registry.waitForDeployment();

    // Authorize issuers
    // Repository can issue IDENTITY and USAGE_RIGHTS
    await registry.authorizeIssuer(repositoryIssuer.address, true, false, true);
    // QC Lab can issue QC_MYCO only
    await registry.authorizeIssuer(qcLabIssuer.address, false, true, false);
  });

  describe("Material Registration", function () {
    it("should register a CELL_LINE material", async function () {
      const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("HeLa cell line metadata"));
      
      const tx = await registry.registerMaterial(CELL_LINE, metadataHash, "LabA_MSP");
      const receipt = await tx.wait();
      
      // Check event
      const event = receipt?.logs.find(log => {
        try {
          return registry.interface.parseLog(log as any)?.name === "MaterialRegistered";
        } catch { return false; }
      });
      expect(event).to.not.be.undefined;
      
      // Check material exists
      const material = await registry.getMaterial("bio:cell_line:1");
      expect(material.materialType).to.equal(CELL_LINE);
      expect(material.metadataHash).to.equal(metadataHash);
      expect(material.ownerOrg).to.equal("LabA_MSP");
      expect(material.status).to.equal(0); // ACTIVE
    });

    it("should register a PLASMID material", async function () {
      const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("pUC19 plasmid metadata"));
      
      await registry.registerMaterial(PLASMID, metadataHash, "LabB_MSP");
      
      const material = await registry.getMaterial("bio:plasmid:1");
      expect(material.materialType).to.equal(PLASMID);
    });

    it("should reject invalid materialType", async function () {
      const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("invalid"));
      
      await expect(
        registry.registerMaterial("INVALID_TYPE", metadataHash, "LabA_MSP")
      ).to.be.revertedWithCustomError(registry, "InvalidMaterialType");
    });

    it("should reject zero metadataHash", async function () {
      await expect(
        registry.registerMaterial(CELL_LINE, ZERO_HASH, "LabA_MSP")
      ).to.be.revertedWithCustomError(registry, "InvalidCommitmentHash");
    });
  });

  describe("Issuer Authorization (RBAC)", function () {
    it("should allow admin to authorize issuers", async function () {
      const newIssuer = unauthorized;
      
      await registry.authorizeIssuer(newIssuer.address, true, true, true);
      
      const perm = await registry.issuerPermissions(newIssuer.address);
      expect(perm.isApproved).to.be.true;
      expect(perm.canIssueIdentity).to.be.true;
      expect(perm.canIssueQC).to.be.true;
    });

    it("should reject non-admin authorization attempts", async function () {
      await expect(
        registry.connect(unauthorized).authorizeIssuer(unauthorized.address, true, true, true)
      ).to.be.revertedWithCustomError(registry, "OnlyAdmin");
    });

    it("should track issuer revocation timestamp", async function () {
      await registry.revokeIssuer(repositoryIssuer.address);
      
      const revokedAt = await registry.issuerRevokedAt(repositoryIssuer.address);
      expect(revokedAt).to.be.gt(0);
    });

    it("should reject credential issuance from revoked issuer", async function () {
      // Register material first
      const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("test"));
      await registry.registerMaterial(CELL_LINE, metadataHash, "LabA_MSP");
      
      // Revoke the issuer
      await registry.revokeIssuer(repositoryIssuer.address);
      
      // Try to issue credential
      const commitmentHash = ethers.keccak256(ethers.toUtf8Bytes("credential"));
      const artifactHash = ethers.keccak256(ethers.toUtf8Bytes("artifact"));
      
      await expect(
        registry.connect(repositoryIssuer).issueCredential(
          "bio:cell_line:1",
          0, // IDENTITY
          commitmentHash,
          Math.floor(Date.now() / 1000) + 86400 * 90,
          "s3://bucket/file.pdf",
          artifactHash,
          "Repository_MSP"
        )
      ).to.be.revertedWithCustomError(registry, "IssuerRevoked");
    });
  });

  describe("Credential Issuance", function () {
    let materialId: string;

    beforeEach(async function () {
      const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("test material"));
      await registry.registerMaterial(CELL_LINE, metadataHash, "LabA_MSP");
      materialId = "bio:cell_line:1";
    });

    it("should issue IDENTITY credential from authorized issuer", async function () {
      const commitmentHash = ethers.keccak256(ethers.toUtf8Bytes("identity credential"));
      const artifactHash = ethers.keccak256(ethers.toUtf8Bytes("identity artifact"));
      const validUntil = Math.floor(Date.now() / 1000) + 86400 * 365;
      
      await registry.connect(repositoryIssuer).issueCredential(
        materialId,
        0, // IDENTITY
        commitmentHash,
        validUntil,
        "s3://biopassport/identity/test.pdf",
        artifactHash,
        "Repository_MSP"
      );
      
      const creds = await registry.getCredentials(materialId);
      expect(creds.length).to.equal(1);
      expect(creds[0].credType).to.equal(0); // IDENTITY
      expect(creds[0].commitmentHash).to.equal(commitmentHash);
    });

    it("should reject IDENTITY credential from QC-only issuer", async function () {
      const commitmentHash = ethers.keccak256(ethers.toUtf8Bytes("identity"));
      const artifactHash = ethers.keccak256(ethers.toUtf8Bytes("artifact"));
      
      await expect(
        registry.connect(qcLabIssuer).issueCredential(
          materialId,
          0, // IDENTITY
          commitmentHash,
          Math.floor(Date.now() / 1000) + 86400,
          "s3://test",
          artifactHash,
          "QCLab_MSP"
        )
      ).to.be.revertedWithCustomError(registry, "NotAuthorizedForCredentialType");
    });

    it("should issue QC_MYCO credential from QC issuer", async function () {
      const commitmentHash = ethers.keccak256(ethers.toUtf8Bytes("qc credential"));
      const artifactHash = ethers.keccak256(ethers.toUtf8Bytes("qc report"));
      const validUntil = Math.floor(Date.now() / 1000) + 86400 * 90;
      
      await registry.connect(qcLabIssuer).issueCredential(
        materialId,
        1, // QC_MYCO
        commitmentHash,
        validUntil,
        "s3://biopassport/qc/test.pdf",
        artifactHash,
        "QCLab_MSP"
      );
      
      const creds = await registry.getCredentials(materialId);
      expect(creds.length).to.equal(1);
      expect(creds[0].credType).to.equal(1); // QC_MYCO
    });

    it("should reject credential from unauthorized issuer", async function () {
      const commitmentHash = ethers.keccak256(ethers.toUtf8Bytes("fake"));
      const artifactHash = ethers.keccak256(ethers.toUtf8Bytes("fake"));
      
      await expect(
        registry.connect(unauthorized).issueCredential(
          materialId,
          0,
          commitmentHash,
          Math.floor(Date.now() / 1000) + 86400,
          "s3://fake",
          artifactHash,
          "Fake_MSP"
        )
      ).to.be.revertedWithCustomError(registry, "NotApprovedIssuer");
    });

    it("should reject zero commitment hash", async function () {
      const artifactHash = ethers.keccak256(ethers.toUtf8Bytes("artifact"));
      
      await expect(
        registry.connect(repositoryIssuer).issueCredential(
          materialId,
          0,
          ZERO_HASH,
          Math.floor(Date.now() / 1000) + 86400,
          "s3://test",
          artifactHash,
          "Repository_MSP"
        )
      ).to.be.revertedWithCustomError(registry, "InvalidCommitmentHash");
    });
  });

  describe("Material Verification", function () {
    let materialId: string;

    beforeEach(async function () {
      // Register material
      const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("test"));
      await registry.registerMaterial(CELL_LINE, metadataHash, "LabA_MSP");
      materialId = "bio:cell_line:1";
    });

    it("should FAIL verification without IDENTITY credential", async function () {
      const [pass, reasons] = await registry.verifyMaterial(materialId);
      
      expect(pass).to.be.false;
      expect(reasons).to.include("MISSING_IDENTITY");
    });

    it("should FAIL verification without QC credential", async function () {
      // Issue IDENTITY
      await registry.connect(repositoryIssuer).issueCredential(
        materialId,
        0,
        ethers.keccak256(ethers.toUtf8Bytes("identity")),
        Math.floor(Date.now() / 1000) + 86400 * 365,
        "s3://identity",
        ethers.keccak256(ethers.toUtf8Bytes("artifact")),
        "Repository_MSP"
      );
      
      const [pass, reasons] = await registry.verifyMaterial(materialId);
      
      expect(pass).to.be.false;
      expect(reasons).to.include("QC_MISSING");
    });

    it("should PASS verification with valid IDENTITY and QC", async function () {
      // Issue IDENTITY
      await registry.connect(repositoryIssuer).issueCredential(
        materialId,
        0,
        ethers.keccak256(ethers.toUtf8Bytes("identity")),
        Math.floor(Date.now() / 1000) + 86400 * 365,
        "s3://identity",
        ethers.keccak256(ethers.toUtf8Bytes("artifact1")),
        "Repository_MSP"
      );
      
      // Issue QC_MYCO
      await registry.connect(qcLabIssuer).issueCredential(
        materialId,
        1,
        ethers.keccak256(ethers.toUtf8Bytes("qc")),
        Math.floor(Date.now() / 1000) + 86400 * 90,
        "s3://qc",
        ethers.keccak256(ethers.toUtf8Bytes("artifact2")),
        "QCLab_MSP"
      );
      
      const [pass, reasons] = await registry.verifyMaterial(materialId);
      
      expect(pass).to.be.true;
      expect(reasons.length).to.equal(0);
    });

    it("should FAIL verification for REVOKED material", async function () {
      // Issue credentials
      await registry.connect(repositoryIssuer).issueCredential(
        materialId, 0, ethers.keccak256(ethers.toUtf8Bytes("id")),
        Math.floor(Date.now() / 1000) + 86400 * 365, "s3://id",
        ethers.keccak256(ethers.toUtf8Bytes("a1")), "Repo"
      );
      await registry.connect(qcLabIssuer).issueCredential(
        materialId, 1, ethers.keccak256(ethers.toUtf8Bytes("qc")),
        Math.floor(Date.now() / 1000) + 86400 * 90, "s3://qc",
        ethers.keccak256(ethers.toUtf8Bytes("a2")), "QC"
      );
      
      // Revoke via authority
      await registry.setStatusByAuthority(materialId, 2, ethers.keccak256(ethers.toUtf8Bytes("reason")));
      
      const [pass, reasons] = await registry.verifyMaterial(materialId);
      
      expect(pass).to.be.false;
      expect(reasons).to.include("MATERIAL_REVOKED");
    });

    it("should FAIL verification for QUARANTINED material", async function () {
      // Issue credentials
      await registry.connect(repositoryIssuer).issueCredential(
        materialId, 0, ethers.keccak256(ethers.toUtf8Bytes("id")),
        Math.floor(Date.now() / 1000) + 86400 * 365, "s3://id",
        ethers.keccak256(ethers.toUtf8Bytes("a1")), "Repo"
      );
      await registry.connect(qcLabIssuer).issueCredential(
        materialId, 1, ethers.keccak256(ethers.toUtf8Bytes("qc")),
        Math.floor(Date.now() / 1000) + 86400 * 90, "s3://qc",
        ethers.keccak256(ethers.toUtf8Bytes("a2")), "QC"
      );
      
      // Quarantine via owner
      await registry.setStatusByOwner(materialId, 1, ethers.keccak256(ethers.toUtf8Bytes("reason")));
      
      const [pass, reasons] = await registry.verifyMaterial(materialId);
      
      expect(pass).to.be.false;
      expect(reasons).to.include("MATERIAL_QUARANTINED");
    });
  });

  describe("Transfer Chain Continuity", function () {
    let materialId: string;

    beforeEach(async function () {
      const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("test"));
      await registry.registerMaterial(CELL_LINE, metadataHash, "LabA_MSP");
      materialId = "bio:cell_line:1";
      
      // Issue required credentials
      await registry.connect(repositoryIssuer).issueCredential(
        materialId, 0, ethers.keccak256(ethers.toUtf8Bytes("id")),
        Math.floor(Date.now() / 1000) + 86400 * 365, "s3://id",
        ethers.keccak256(ethers.toUtf8Bytes("a1")), "Repo"
      );
      await registry.connect(qcLabIssuer).issueCredential(
        materialId, 1, ethers.keccak256(ethers.toUtf8Bytes("qc")),
        Math.floor(Date.now() / 1000) + 86400 * 90, "s3://qc",
        ethers.keccak256(ethers.toUtf8Bytes("a2")), "QC"
      );
    });

    it("should initiate transfer from owner", async function () {
      const shipmentHash = ethers.keccak256(ethers.toUtf8Bytes("shipment"));
      
      await registry.initiateTransfer(materialId, labA.address, "LabA_MSP", shipmentHash);
      
      const transfers = await registry.getTransfers(materialId);
      expect(transfers.length).to.equal(1);
      expect(transfers[0].accepted).to.be.false;
    });

    it("should FAIL verification with pending transfer", async function () {
      const shipmentHash = ethers.keccak256(ethers.toUtf8Bytes("shipment"));
      await registry.initiateTransfer(materialId, labA.address, "LabA_MSP", shipmentHash);
      
      const [pass, reasons] = await registry.verifyMaterial(materialId);
      
      expect(pass).to.be.false;
      expect(reasons).to.include("TRANSFER_PENDING");
    });

    it("should PASS verification after transfer accepted", async function () {
      const shipmentHash = ethers.keccak256(ethers.toUtf8Bytes("shipment"));
      await registry.initiateTransfer(materialId, labA.address, "LabA_MSP", shipmentHash);
      
      // Accept transfer
      await registry.connect(labA).acceptTransfer(materialId);
      
      const [pass, reasons] = await registry.verifyMaterial(materialId);
      
      expect(pass).to.be.true;
      expect(reasons.length).to.equal(0);
    });

    it("should reject transfer from non-owner", async function () {
      const shipmentHash = ethers.keccak256(ethers.toUtf8Bytes("shipment"));
      
      await expect(
        registry.connect(unauthorized).initiateTransfer(materialId, labA.address, "LabA_MSP", shipmentHash)
      ).to.be.revertedWithCustomError(registry, "NotMaterialOwner");
    });

    it("should reject new transfer while one is pending", async function () {
      const shipmentHash = ethers.keccak256(ethers.toUtf8Bytes("shipment"));
      await registry.initiateTransfer(materialId, labA.address, "LabA_MSP", shipmentHash);
      
      await expect(
        registry.initiateTransfer(materialId, labB.address, "LabB_MSP", shipmentHash)
      ).to.be.revertedWithCustomError(registry, "PendingTransferExists");
    });
  });

  describe("Status Authority Control", function () {
    let materialId: string;

    beforeEach(async function () {
      const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("test"));
      await registry.registerMaterial(CELL_LINE, metadataHash, "LabA_MSP");
      materialId = "bio:cell_line:1";
    });

    it("should allow owner to quarantine (self-quarantine)", async function () {
      await registry.setStatusByOwner(materialId, 1, ethers.keccak256(ethers.toUtf8Bytes("reason")));
      
      const material = await registry.getMaterial(materialId);
      expect(material.status).to.equal(1); // QUARANTINED
    });

    it("should reject owner attempting to revoke", async function () {
      await expect(
        registry.setStatusByOwner(materialId, 2, ethers.keccak256(ethers.toUtf8Bytes("reason")))
      ).to.be.revertedWithCustomError(registry, "NotAuthorizedForStatus");
    });

    it("should allow admin to revoke", async function () {
      await registry.setStatusByAuthority(materialId, 2, ethers.keccak256(ethers.toUtf8Bytes("reason")));
      
      const material = await registry.getMaterial(materialId);
      expect(material.status).to.equal(2); // REVOKED
    });

    it("should allow QC issuer to quarantine", async function () {
      await registry.connect(qcLabIssuer).setStatusByAuthority(
        materialId, 1, ethers.keccak256(ethers.toUtf8Bytes("failed QC"))
      );
      
      const material = await registry.getMaterial(materialId);
      expect(material.status).to.equal(1); // QUARANTINED
    });
  });

  describe("Issuer Revocation Semantics", function () {
    let materialId: string;

    beforeEach(async function () {
      const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("test"));
      await registry.registerMaterial(CELL_LINE, metadataHash, "LabA_MSP");
      materialId = "bio:cell_line:1";
      
      // Issue IDENTITY before revocation
      await registry.connect(repositoryIssuer).issueCredential(
        materialId, 0, ethers.keccak256(ethers.toUtf8Bytes("id")),
        Math.floor(Date.now() / 1000) + 86400 * 365, "s3://id",
        ethers.keccak256(ethers.toUtf8Bytes("a1")), "Repo"
      );
    });

    it("should trust credentials issued BEFORE issuer revocation", async function () {
      // Issue QC before revocation
      await registry.connect(qcLabIssuer).issueCredential(
        materialId, 1, ethers.keccak256(ethers.toUtf8Bytes("qc")),
        Math.floor(Date.now() / 1000) + 86400 * 90, "s3://qc",
        ethers.keccak256(ethers.toUtf8Bytes("a2")), "QC"
      );
      
      // Revoke issuer
      await registry.revokeIssuer(qcLabIssuer.address);
      
      // Credential issued before revocation should still be valid
      const [pass, reasons] = await registry.verifyMaterial(materialId);
      expect(pass).to.be.true;
    });
  });

  describe("History Retrieval", function () {
    it("should track history events", async function () {
      const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("test"));
      await registry.registerMaterial(CELL_LINE, metadataHash, "LabA_MSP");
      const materialId = "bio:cell_line:1";
      
      const count = await registry.getHistoryCount(materialId);
      expect(count).to.equal(1); // REGISTERED event
      
      const historyHash = await registry.getHistoryAt(materialId, 0);
      expect(historyHash).to.not.equal(ZERO_HASH);
    });

    it("should support history pagination", async function () {
      const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("test"));
      await registry.registerMaterial(CELL_LINE, metadataHash, "LabA_MSP");
      const materialId = "bio:cell_line:1";
      
      // Add more history
      await registry.connect(repositoryIssuer).issueCredential(
        materialId, 0, ethers.keccak256(ethers.toUtf8Bytes("id")),
        Math.floor(Date.now() / 1000) + 86400 * 365, "s3://id",
        ethers.keccak256(ethers.toUtf8Bytes("a1")), "Repo"
      );
      
      const slice = await registry.getHistorySlice(materialId, 0, 10);
      expect(slice.length).to.equal(2); // REGISTERED + CREDENTIAL_ISSUED
    });
  });
});
