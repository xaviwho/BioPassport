import { expect } from "chai";
import { ethers } from "hardhat";
import { BioPassportRegistry } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * Batch Operations Test Suite for BioPassportRegistry
 *
 * Tests gas-optimized batch operations for:
 * 1. Batch material registration (10-15x throughput improvement)
 * 2. Batch credential issuance (10-15x throughput improvement)
 * 3. Batch material verification (view function - no gas cost)
 */
describe("BioPassportRegistry Batch Operations", function () {
  let registry: BioPassportRegistry;
  let admin: SignerWithAddress;
  let issuer: SignerWithAddress;
  let user: SignerWithAddress;

  const CELL_LINE = "CELL_LINE";
  const PLASMID = "PLASMID";

  beforeEach(async function () {
    [admin, issuer, user] = await ethers.getSigners();

    const BioPassportRegistry = await ethers.getContractFactory("BioPassportRegistry");
    registry = await BioPassportRegistry.deploy();
    await registry.waitForDeployment();

    // Authorize issuer with all permissions
    await registry.authorizeIssuer(issuer.address, true, true, true);
  });

  describe("Batch Material Registration", function () {
    it("should register multiple materials in one transaction", async function () {
      const materialTypes = [CELL_LINE, PLASMID, CELL_LINE];
      const metadataHashes = [
        ethers.keccak256(ethers.toUtf8Bytes("HeLa metadata")),
        ethers.keccak256(ethers.toUtf8Bytes("pUC19 metadata")),
        ethers.keccak256(ethers.toUtf8Bytes("CHO metadata"))
      ];
      const ownerOrgs = ["LabA_MSP", "LabB_MSP", "LabC_MSP"];

      const tx = await registry.batchRegisterMaterials(materialTypes, metadataHashes, ownerOrgs);
      const receipt = await tx.wait();

      // Check all materials were registered
      const material1 = await registry.getMaterial("bio:cell_line:1");
      expect(material1.materialType).to.equal(CELL_LINE);
      expect(material1.ownerOrg).to.equal("LabA_MSP");

      const material2 = await registry.getMaterial("bio:plasmid:2");
      expect(material2.materialType).to.equal(PLASMID);
      expect(material2.ownerOrg).to.equal("LabB_MSP");

      const material3 = await registry.getMaterial("bio:cell_line:3");
      expect(material3.materialType).to.equal(CELL_LINE);
      expect(material3.ownerOrg).to.equal("LabC_MSP");

      // Check material count updated
      const count = await registry.materialCount();
      expect(count).to.equal(3);
    });

    it("should register 10 materials in one transaction", async function () {
      const count = 10;
      const materialTypes = Array(count).fill(CELL_LINE);
      const metadataHashes = Array(count).fill(0).map((_, i) =>
        ethers.keccak256(ethers.toUtf8Bytes(`metadata${i}`))
      );
      const ownerOrgs = Array(count).fill(0).map((_, i) => `Lab${i}_MSP`);

      await registry.batchRegisterMaterials(materialTypes, metadataHashes, ownerOrgs);

      // Verify first and last
      const material1 = await registry.getMaterial("bio:cell_line:1");
      expect(material1.ownerOrg).to.equal("Lab0_MSP");

      const material10 = await registry.getMaterial("bio:cell_line:10");
      expect(material10.ownerOrg).to.equal("Lab9_MSP");

      const materialCount = await registry.materialCount();
      expect(materialCount).to.equal(10);
    });

    it("should register 100 materials (batch limit)", async function () {
      const count = 100;
      const materialTypes = Array(count).fill(CELL_LINE);
      const metadataHashes = Array(count).fill(0).map((_, i) =>
        ethers.keccak256(ethers.toUtf8Bytes(`metadata${i}`))
      );
      const ownerOrgs = Array(count).fill(0).map((_, i) => `Lab${i}_MSP`);

      await registry.batchRegisterMaterials(materialTypes, metadataHashes, ownerOrgs);

      const materialCount = await registry.materialCount();
      expect(materialCount).to.equal(100);
    });

    it("should reject batch size > 100", async function () {
      const count = 101;
      const materialTypes = Array(count).fill(CELL_LINE);
      const metadataHashes = Array(count).fill(0).map((_, i) =>
        ethers.keccak256(ethers.toUtf8Bytes(`metadata${i}`))
      );
      const ownerOrgs = Array(count).fill(0).map((_, i) => `Lab${i}_MSP`);

      await expect(
        registry.batchRegisterMaterials(materialTypes, metadataHashes, ownerOrgs)
      ).to.be.revertedWith("Batch size exceeds limit (100)");
    });

    it("should reject array length mismatch", async function () {
      const materialTypes = [CELL_LINE, PLASMID];
      const metadataHashes = [ethers.keccak256(ethers.toUtf8Bytes("test"))];
      const ownerOrgs = ["LabA_MSP", "LabB_MSP"];

      await expect(
        registry.batchRegisterMaterials(materialTypes, metadataHashes, ownerOrgs)
      ).to.be.revertedWith("Array length mismatch");
    });

    it("should reject invalid materialType in batch", async function () {
      const materialTypes = [CELL_LINE, "INVALID", PLASMID];
      const metadataHashes = [
        ethers.keccak256(ethers.toUtf8Bytes("test1")),
        ethers.keccak256(ethers.toUtf8Bytes("test2")),
        ethers.keccak256(ethers.toUtf8Bytes("test3"))
      ];
      const ownerOrgs = ["LabA_MSP", "LabB_MSP", "LabC_MSP"];

      await expect(
        registry.batchRegisterMaterials(materialTypes, metadataHashes, ownerOrgs)
      ).to.be.revertedWithCustomError(registry, "InvalidMaterialType");
    });

    it("should reject zero metadataHash in batch", async function () {
      const materialTypes = [CELL_LINE, PLASMID];
      const metadataHashes = [
        ethers.keccak256(ethers.toUtf8Bytes("test")),
        ethers.ZeroHash // Invalid
      ];
      const ownerOrgs = ["LabA_MSP", "LabB_MSP"];

      await expect(
        registry.batchRegisterMaterials(materialTypes, metadataHashes, ownerOrgs)
      ).to.be.revertedWithCustomError(registry, "InvalidCommitmentHash");
    });
  });

  describe("Batch Credential Issuance", function () {
    let materialIds: string[];

    beforeEach(async function () {
      // Register 5 materials for testing
      const materialTypes = Array(5).fill(CELL_LINE);
      const metadataHashes = Array(5).fill(0).map((_, i) =>
        ethers.keccak256(ethers.toUtf8Bytes(`metadata${i}`))
      );
      const ownerOrgs = Array(5).fill("Lab_MSP");

      await registry.batchRegisterMaterials(materialTypes, metadataHashes, ownerOrgs);

      materialIds = [
        "bio:cell_line:1",
        "bio:cell_line:2",
        "bio:cell_line:3",
        "bio:cell_line:4",
        "bio:cell_line:5"
      ];
    });

    it("should issue multiple credentials in one transaction", async function () {
      const credTypes = [0, 1, 0]; // IDENTITY, QC_MYCO, IDENTITY
      const commitmentHashes = [
        ethers.keccak256(ethers.toUtf8Bytes("cred1")),
        ethers.keccak256(ethers.toUtf8Bytes("cred2")),
        ethers.keccak256(ethers.toUtf8Bytes("cred3"))
      ];
      const validUntils = [
        Math.floor(Date.now() / 1000) + 86400 * 365,
        Math.floor(Date.now() / 1000) + 86400 * 90,
        Math.floor(Date.now() / 1000) + 86400 * 365
      ];
      const artifactCids = ["s3://art1", "s3://art2", "s3://art3"];
      const artifactHashes = [
        ethers.keccak256(ethers.toUtf8Bytes("hash1")),
        ethers.keccak256(ethers.toUtf8Bytes("hash2")),
        ethers.keccak256(ethers.toUtf8Bytes("hash3"))
      ];
      const issuerIds = ["Issuer_MSP", "Issuer_MSP", "Issuer_MSP"];

      const selectedMaterialIds = [materialIds[0], materialIds[1], materialIds[2]];

      await registry.connect(issuer).batchIssueCredentials(
        selectedMaterialIds,
        credTypes,
        commitmentHashes,
        validUntils,
        artifactCids,
        artifactHashes,
        issuerIds
      );

      // Verify credentials were issued
      const creds1 = await registry.getCredentials(materialIds[0]);
      expect(creds1.length).to.equal(1);
      expect(creds1[0].credType).to.equal(0); // IDENTITY

      const creds2 = await registry.getCredentials(materialIds[1]);
      expect(creds2.length).to.equal(1);
      expect(creds2[0].credType).to.equal(1); // QC_MYCO

      const credentialCount = await registry.credentialCount();
      expect(credentialCount).to.equal(3);
    });

    it("should issue 50 credentials in one transaction (batch limit)", async function () {
      // Register 50 materials first
      const materialTypes = Array(50).fill(CELL_LINE);
      const metadataHashes = Array(50).fill(0).map((_, i) =>
        ethers.keccak256(ethers.toUtf8Bytes(`metadata${i + 5}`))
      );
      const ownerOrgs = Array(50).fill("Lab_MSP");
      await registry.batchRegisterMaterials(materialTypes, metadataHashes, ownerOrgs);

      // Prepare 50 credentials
      const batchMaterialIds = Array(50).fill(0).map((_, i) => `bio:cell_line:${i + 6}`);
      const credTypes = Array(50).fill(0); // All IDENTITY
      const commitmentHashes = Array(50).fill(0).map((_, i) =>
        ethers.keccak256(ethers.toUtf8Bytes(`cred${i}`))
      );
      const validUntils = Array(50).fill(Math.floor(Date.now() / 1000) + 86400 * 365);
      const artifactCids = Array(50).fill(0).map((_, i) => `s3://art${i}`);
      const artifactHashes = Array(50).fill(0).map((_, i) =>
        ethers.keccak256(ethers.toUtf8Bytes(`hash${i}`))
      );
      const issuerIds = Array(50).fill("Issuer_MSP");

      await registry.connect(issuer).batchIssueCredentials(
        batchMaterialIds,
        credTypes,
        commitmentHashes,
        validUntils,
        artifactCids,
        artifactHashes,
        issuerIds
      );

      const credentialCount = await registry.credentialCount();
      expect(credentialCount).to.equal(50);
    });

    it("should reject batch size > 50", async function () {
      const count = 51;
      const batchMaterialIds = Array(count).fill(materialIds[0]);
      const credTypes = Array(count).fill(0);
      const commitmentHashes = Array(count).fill(0).map((_, i) =>
        ethers.keccak256(ethers.toUtf8Bytes(`cred${i}`))
      );
      const validUntils = Array(count).fill(Math.floor(Date.now() / 1000) + 86400);
      const artifactCids = Array(count).fill("s3://test");
      const artifactHashes = Array(count).fill(0).map((_, i) =>
        ethers.keccak256(ethers.toUtf8Bytes(`hash${i}`))
      );
      const issuerIds = Array(count).fill("Issuer_MSP");

      await expect(
        registry.connect(issuer).batchIssueCredentials(
          batchMaterialIds,
          credTypes,
          commitmentHashes,
          validUntils,
          artifactCids,
          artifactHashes,
          issuerIds
        )
      ).to.be.revertedWith("Batch size exceeds limit (50)");
    });

    it("should reject array length mismatch", async function () {
      const batchMaterialIds = [materialIds[0], materialIds[1]];
      const credTypes = [0]; // Wrong length
      const commitmentHashes = [ethers.keccak256(ethers.toUtf8Bytes("test1")), ethers.keccak256(ethers.toUtf8Bytes("test2"))];
      const validUntils = [Math.floor(Date.now() / 1000) + 86400, Math.floor(Date.now() / 1000) + 86400];
      const artifactCids = ["s3://test1", "s3://test2"];
      const artifactHashes = [ethers.keccak256(ethers.toUtf8Bytes("hash1")), ethers.keccak256(ethers.toUtf8Bytes("hash2"))];
      const issuerIds = ["Issuer_MSP", "Issuer_MSP"];

      await expect(
        registry.connect(issuer).batchIssueCredentials(
          batchMaterialIds,
          credTypes,
          commitmentHashes,
          validUntils,
          artifactCids,
          artifactHashes,
          issuerIds
        )
      ).to.be.revertedWith("Array length mismatch");
    });

    it("should reject unauthorized issuer in batch", async function () {
      const batchMaterialIds = [materialIds[0]];
      const credTypes = [0];
      const commitmentHashes = [ethers.keccak256(ethers.toUtf8Bytes("test"))];
      const validUntils = [Math.floor(Date.now() / 1000) + 86400];
      const artifactCids = ["s3://test"];
      const artifactHashes = [ethers.keccak256(ethers.toUtf8Bytes("hash"))];
      const issuerIds = ["Issuer_MSP"];

      await expect(
        registry.connect(user).batchIssueCredentials(
          batchMaterialIds,
          credTypes,
          commitmentHashes,
          validUntils,
          artifactCids,
          artifactHashes,
          issuerIds
        )
      ).to.be.revertedWithCustomError(registry, "NotApprovedIssuer");
    });
  });

  describe("Batch Material Verification", function () {
    let materialIds: string[];

    beforeEach(async function () {
      // Register 5 materials
      const materialTypes = Array(5).fill(CELL_LINE);
      const metadataHashes = Array(5).fill(0).map((_, i) =>
        ethers.keccak256(ethers.toUtf8Bytes(`metadata${i}`))
      );
      const ownerOrgs = Array(5).fill("Lab_MSP");

      await registry.batchRegisterMaterials(materialTypes, metadataHashes, ownerOrgs);

      materialIds = [
        "bio:cell_line:1",
        "bio:cell_line:2",
        "bio:cell_line:3",
        "bio:cell_line:4",
        "bio:cell_line:5"
      ];

      // Issue IDENTITY and QC credentials for first 3 materials
      for (let i = 0; i < 3; i++) {
        await registry.connect(issuer).issueCredential(
          materialIds[i],
          0, // IDENTITY
          ethers.keccak256(ethers.toUtf8Bytes(`id${i}`)),
          Math.floor(Date.now() / 1000) + 86400 * 365,
          `s3://id${i}`,
          ethers.keccak256(ethers.toUtf8Bytes(`idhash${i}`)),
          "Issuer_MSP"
        );

        await registry.connect(issuer).issueCredential(
          materialIds[i],
          1, // QC_MYCO
          ethers.keccak256(ethers.toUtf8Bytes(`qc${i}`)),
          Math.floor(Date.now() / 1000) + 86400 * 90,
          `s3://qc${i}`,
          ethers.keccak256(ethers.toUtf8Bytes(`qchash${i}`)),
          "Issuer_MSP"
        );
      }
    });

    it("should verify multiple materials in one call", async function () {
      const [passes, allReasons] = await registry.batchVerifyMaterials([
        materialIds[0],
        materialIds[1],
        materialIds[2]
      ]);

      // All should pass (have IDENTITY + QC)
      expect(passes[0]).to.be.true;
      expect(passes[1]).to.be.true;
      expect(passes[2]).to.be.true;
      expect(allReasons[0].length).to.equal(0);
      expect(allReasons[1].length).to.equal(0);
      expect(allReasons[2].length).to.equal(0);
    });

    it("should identify materials with missing credentials", async function () {
      const [passes, allReasons] = await registry.batchVerifyMaterials([
        materialIds[0], // Valid
        materialIds[3], // Missing IDENTITY + QC
        materialIds[4]  // Missing IDENTITY + QC
      ]);

      expect(passes[0]).to.be.true;
      expect(passes[1]).to.be.false;
      expect(passes[2]).to.be.false;

      expect(allReasons[1]).to.include("MISSING_IDENTITY");
      expect(allReasons[2]).to.include("MISSING_IDENTITY");
    });

    it("should verify 100 materials in one call (batch limit)", async function () {
      // Register 100 materials
      const materialTypes = Array(100).fill(CELL_LINE);
      const metadataHashes = Array(100).fill(0).map((_, i) =>
        ethers.keccak256(ethers.toUtf8Bytes(`metadata${i + 5}`))
      );
      const ownerOrgs = Array(100).fill("Lab_MSP");
      await registry.batchRegisterMaterials(materialTypes, metadataHashes, ownerOrgs);

      const batchIds = Array(100).fill(0).map((_, i) => `bio:cell_line:${i + 6}`);

      const [passes, allReasons] = await registry.batchVerifyMaterials(batchIds);

      expect(passes.length).to.equal(100);
      expect(allReasons.length).to.equal(100);
    });

    it("should reject batch size > 100", async function () {
      const batchIds = Array(101).fill(materialIds[0]);

      await expect(
        registry.batchVerifyMaterials(batchIds)
      ).to.be.revertedWith("Batch size exceeds limit (100)");
    });
  });

  describe("Gas Comparison", function () {
    it("should demonstrate gas savings for batch registration", async function () {
      // Single registration
      const singleGas = await registry.registerMaterial.estimateGas(
        CELL_LINE,
        ethers.keccak256(ethers.toUtf8Bytes("single")),
        "Lab_MSP"
      );

      // Batch registration (10 materials)
      const count = 10;
      const materialTypes = Array(count).fill(CELL_LINE);
      const metadataHashes = Array(count).fill(0).map((_, i) =>
        ethers.keccak256(ethers.toUtf8Bytes(`batch${i}`))
      );
      const ownerOrgs = Array(count).fill("Lab_MSP");

      const batchGas = await registry.batchRegisterMaterials.estimateGas(
        materialTypes,
        metadataHashes,
        ownerOrgs
      );

      console.log(`Single registration gas: ${singleGas}`);
      console.log(`Batch registration gas (10): ${batchGas}`);
      console.log(`Gas per item in batch: ${batchGas / BigInt(count)}`);
      console.log(`Gas savings: ${((1 - Number(batchGas) / (Number(singleGas) * count)) * 100).toFixed(2)}%`);

      // Batch should be more efficient
      expect(Number(batchGas)).to.be.lessThan(Number(singleGas) * count);
    });
  });
});
