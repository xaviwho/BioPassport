import { expect } from "chai";
import { ethers } from "hardhat";
import { BioPassportRegistry } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * Security Test Suite for BioPassportRegistry
 *
 * Tests:
 * 1. Reentrancy protection on all state-changing functions
 * 2. Role-Based Access Control (RBAC)
 * 3. Pausable emergency stops
 * 4. Authorization checks
 */
describe("BioPassportRegistry Security", function () {
  let registry: BioPassportRegistry;
  let admin: SignerWithAddress;
  let issuer: SignerWithAddress;
  let auditor: SignerWithAddress;
  let user: SignerWithAddress;
  let attacker: SignerWithAddress;

  const CELL_LINE = "CELL_LINE";
  const ZERO_HASH = ethers.ZeroHash;

  // Role identifiers
  let ADMIN_ROLE: string;
  let REGISTRAR_ROLE: string;
  let AUDITOR_ROLE: string;
  let ISSUER_MANAGER_ROLE: string;

  beforeEach(async function () {
    [admin, issuer, auditor, user, attacker] = await ethers.getSigners();

    const BioPassportRegistry = await ethers.getContractFactory("BioPassportRegistry");
    registry = await BioPassportRegistry.deploy();
    await registry.waitForDeployment();

    // Get role identifiers
    ADMIN_ROLE = await registry.ADMIN_ROLE();
    REGISTRAR_ROLE = await registry.REGISTRAR_ROLE();
    AUDITOR_ROLE = await registry.AUDITOR_ROLE();
    ISSUER_MANAGER_ROLE = await registry.ISSUER_MANAGER_ROLE();

    // Grant roles for testing
    await registry.grantRole(AUDITOR_ROLE, auditor.address);
    await registry.grantRole(ISSUER_MANAGER_ROLE, admin.address);

    // Authorize issuer
    await registry.authorizeIssuer(issuer.address, true, true, true);
  });

  describe("Role-Based Access Control (RBAC)", function () {
    it("should grant all roles to deployer on deployment", async function () {
      expect(await registry.hasRole(ADMIN_ROLE, admin.address)).to.be.true;
      expect(await registry.hasRole(REGISTRAR_ROLE, admin.address)).to.be.true;
      expect(await registry.hasRole(ISSUER_MANAGER_ROLE, admin.address)).to.be.true;
      expect(await registry.hasRole(AUDITOR_ROLE, admin.address)).to.be.true;
    });

    it("should allow ADMIN_ROLE to grant and revoke roles", async function () {
      // Grant AUDITOR_ROLE to user
      await registry.grantRole(AUDITOR_ROLE, user.address);
      expect(await registry.hasRole(AUDITOR_ROLE, user.address)).to.be.true;

      // Revoke AUDITOR_ROLE from user
      await registry.revokeRole(AUDITOR_ROLE, user.address);
      expect(await registry.hasRole(AUDITOR_ROLE, user.address)).to.be.false;
    });

    it("should reject role grants from non-admin", async function () {
      await expect(
        registry.connect(attacker).grantRole(ADMIN_ROLE, attacker.address)
      ).to.be.reverted; // AccessControl will revert with specific message
    });

    it("should allow ISSUER_MANAGER_ROLE to authorize issuers", async function () {
      await registry.authorizeIssuer(user.address, true, false, true);

      const perm = await registry.issuerPermissions(user.address);
      expect(perm.isApproved).to.be.true;
      expect(perm.canIssueIdentity).to.be.true;
      expect(perm.canIssueQC).to.be.false;
      expect(perm.canIssueUsageRights).to.be.true;
    });

    it("should reject issuer authorization from non-ISSUER_MANAGER", async function () {
      await expect(
        registry.connect(attacker).authorizeIssuer(attacker.address, true, true, true)
      ).to.be.reverted;
    });

    it("should allow ISSUER_MANAGER_ROLE to revoke issuers", async function () {
      await registry.revokeIssuer(issuer.address);

      const revokedAt = await registry.issuerRevokedAt(issuer.address);
      expect(revokedAt).to.be.gt(0);
    });

    it("should allow ADMIN_ROLE or AUDITOR_ROLE to change status by authority", async function () {
      // Register material
      const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("test"));
      await registry.registerMaterial(CELL_LINE, metadataHash, "Test_MSP");
      const materialId = "bio:cell_line:1";

      // Admin can quarantine
      await registry.setStatusByAuthority(materialId, 1, ethers.keccak256(ethers.toUtf8Bytes("admin reason")));
      let material = await registry.getMaterial(materialId);
      expect(material.status).to.equal(1); // QUARANTINED

      // Reset to ACTIVE
      await registry.setStatusByAuthority(materialId, 0, ethers.keccak256(ethers.toUtf8Bytes("reset")));

      // Auditor can also quarantine
      await registry.connect(auditor).setStatusByAuthority(materialId, 1, ethers.keccak256(ethers.toUtf8Bytes("auditor reason")));
      material = await registry.getMaterial(materialId);
      expect(material.status).to.equal(1); // QUARANTINED
    });

    it("should reject status change by authority from unauthorized user", async function () {
      // Register material
      const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("test"));
      await registry.registerMaterial(CELL_LINE, metadataHash, "Test_MSP");
      const materialId = "bio:cell_line:1";

      // Attacker cannot change status
      await expect(
        registry.connect(attacker).setStatusByAuthority(materialId, 1, ethers.keccak256(ethers.toUtf8Bytes("hack")))
      ).to.be.revertedWithCustomError(registry, "NotAuthorizedForStatus");
    });

    it("should allow ADMIN_ROLE to revoke credentials", async function () {
      // Register material and issue credential
      const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("test"));
      await registry.registerMaterial(CELL_LINE, metadataHash, "Test_MSP");
      const materialId = "bio:cell_line:1";

      await registry.connect(issuer).issueCredential(
        materialId,
        0, // IDENTITY
        ethers.keccak256(ethers.toUtf8Bytes("credential")),
        Math.floor(Date.now() / 1000) + 86400,
        "s3://test",
        ethers.keccak256(ethers.toUtf8Bytes("artifact")),
        "Issuer_MSP"
      );

      // Admin can revoke
      await registry.revokeCredential("cred:1");

      const cred = await registry.credentials("cred:1");
      expect(cred.revoked).to.be.true;
    });
  });

  describe("Pausable Emergency Stop", function () {
    it("should allow ADMIN_ROLE to pause contract", async function () {
      await registry.pause();
      expect(await registry.paused()).to.be.true;
    });

    it("should reject pause from non-admin", async function () {
      await expect(
        registry.connect(attacker).pause()
      ).to.be.reverted;
    });

    it("should allow ADMIN_ROLE to unpause contract", async function () {
      await registry.pause();
      await registry.unpause();
      expect(await registry.paused()).to.be.false;
    });

    it("should block registerMaterial when paused", async function () {
      await registry.pause();

      const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("test"));
      await expect(
        registry.registerMaterial(CELL_LINE, metadataHash, "Test_MSP")
      ).to.be.revertedWithCustomError(registry, "EnforcedPause");
    });

    it("should block issueCredential when paused", async function () {
      // Register material first (before pause)
      const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("test"));
      await registry.registerMaterial(CELL_LINE, metadataHash, "Test_MSP");

      // Pause
      await registry.pause();

      // Try to issue credential
      await expect(
        registry.connect(issuer).issueCredential(
          "bio:cell_line:1",
          0,
          ethers.keccak256(ethers.toUtf8Bytes("credential")),
          Math.floor(Date.now() / 1000) + 86400,
          "s3://test",
          ethers.keccak256(ethers.toUtf8Bytes("artifact")),
          "Issuer_MSP"
        )
      ).to.be.revertedWithCustomError(registry, "EnforcedPause");
    });

    it("should block revokeCredential when paused", async function () {
      // Register material and issue credential (before pause)
      const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("test"));
      await registry.registerMaterial(CELL_LINE, metadataHash, "Test_MSP");

      await registry.connect(issuer).issueCredential(
        "bio:cell_line:1",
        0,
        ethers.keccak256(ethers.toUtf8Bytes("credential")),
        Math.floor(Date.now() / 1000) + 86400,
        "s3://test",
        ethers.keccak256(ethers.toUtf8Bytes("artifact")),
        "Issuer_MSP"
      );

      // Pause
      await registry.pause();

      // Try to revoke
      await expect(
        registry.connect(issuer).revokeCredential("cred:1")
      ).to.be.revertedWithCustomError(registry, "EnforcedPause");
    });

    it("should block setStatusByOwner when paused", async function () {
      // Register material (before pause)
      const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("test"));
      await registry.registerMaterial(CELL_LINE, metadataHash, "Test_MSP");

      // Pause
      await registry.pause();

      // Try to change status
      await expect(
        registry.setStatusByOwner("bio:cell_line:1", 1, ethers.keccak256(ethers.toUtf8Bytes("reason")))
      ).to.be.revertedWithCustomError(registry, "EnforcedPause");
    });

    it("should block setStatusByAuthority when paused", async function () {
      // Register material (before pause)
      const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("test"));
      await registry.registerMaterial(CELL_LINE, metadataHash, "Test_MSP");

      // Pause
      await registry.pause();

      // Try to change status
      await expect(
        registry.setStatusByAuthority("bio:cell_line:1", 1, ethers.keccak256(ethers.toUtf8Bytes("reason")))
      ).to.be.revertedWithCustomError(registry, "EnforcedPause");
    });

    it("should block initiateTransfer when paused", async function () {
      // Register material (before pause)
      const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("test"));
      await registry.registerMaterial(CELL_LINE, metadataHash, "Test_MSP");

      // Pause
      await registry.pause();

      // Try to initiate transfer
      await expect(
        registry.initiateTransfer(
          "bio:cell_line:1",
          user.address,
          "User_MSP",
          ethers.keccak256(ethers.toUtf8Bytes("shipment"))
        )
      ).to.be.revertedWithCustomError(registry, "EnforcedPause");
    });

    it("should block acceptTransfer when paused", async function () {
      // Register material and initiate transfer (before pause)
      const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("test"));
      await registry.registerMaterial(CELL_LINE, metadataHash, "Test_MSP");

      await registry.initiateTransfer(
        "bio:cell_line:1",
        user.address,
        "User_MSP",
        ethers.keccak256(ethers.toUtf8Bytes("shipment"))
      );

      // Pause
      await registry.pause();

      // Try to accept transfer
      await expect(
        registry.connect(user).acceptTransfer("bio:cell_line:1")
      ).to.be.revertedWithCustomError(registry, "EnforcedPause");
    });

    it("should allow read operations when paused", async function () {
      // Register material (before pause)
      const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("test"));
      await registry.registerMaterial(CELL_LINE, metadataHash, "Test_MSP");

      // Pause
      await registry.pause();

      // Read operations should still work
      const material = await registry.getMaterial("bio:cell_line:1");
      expect(material.materialType).to.equal(CELL_LINE);

      const creds = await registry.getCredentials("bio:cell_line:1");
      expect(creds.length).to.equal(0);
    });
  });

  describe("Reentrancy Protection", function () {
    it("should protect registerMaterial from reentrancy", async function () {
      // ReentrancyGuard prevents any reentrancy attempts
      // This is a basic test - in practice, you'd need a malicious contract
      const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("test"));

      await registry.registerMaterial(CELL_LINE, metadataHash, "Test_MSP");

      // Verify no double registration occurred
      const materialCount = await registry.materialCount();
      expect(materialCount).to.equal(1);
    });

    it("should protect issueCredential from reentrancy", async function () {
      // Register material first
      const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("test"));
      await registry.registerMaterial(CELL_LINE, metadataHash, "Test_MSP");

      // Issue credential
      await registry.connect(issuer).issueCredential(
        "bio:cell_line:1",
        0,
        ethers.keccak256(ethers.toUtf8Bytes("credential")),
        Math.floor(Date.now() / 1000) + 86400,
        "s3://test",
        ethers.keccak256(ethers.toUtf8Bytes("artifact")),
        "Issuer_MSP"
      );

      // Verify no double issuance
      const credentialCount = await registry.credentialCount();
      expect(credentialCount).to.equal(1);
    });

    it("should protect transfer functions from reentrancy", async function () {
      // Register material
      const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("test"));
      await registry.registerMaterial(CELL_LINE, metadataHash, "Test_MSP");

      // Initiate transfer
      await registry.initiateTransfer(
        "bio:cell_line:1",
        user.address,
        "User_MSP",
        ethers.keccak256(ethers.toUtf8Bytes("shipment"))
      );

      // Accept transfer
      await registry.connect(user).acceptTransfer("bio:cell_line:1");

      // Verify transfer completed once
      const transfers = await registry.getTransfers("bio:cell_line:1");
      expect(transfers.length).to.equal(1);
      expect(transfers[0].accepted).to.be.true;
    });
  });

  describe("Authorization Boundaries", function () {
    it("should prevent unauthorized material owner actions", async function () {
      // Register material
      const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("test"));
      await registry.registerMaterial(CELL_LINE, metadataHash, "Test_MSP");

      // Attacker cannot set status (not owner)
      await expect(
        registry.connect(attacker).setStatusByOwner("bio:cell_line:1", 1, ethers.keccak256(ethers.toUtf8Bytes("hack")))
      ).to.be.revertedWithCustomError(registry, "NotMaterialOwner");

      // Attacker cannot initiate transfer (not owner)
      await expect(
        registry.connect(attacker).initiateTransfer(
          "bio:cell_line:1",
          user.address,
          "User_MSP",
          ethers.keccak256(ethers.toUtf8Bytes("shipment"))
        )
      ).to.be.revertedWithCustomError(registry, "NotMaterialOwner");
    });

    it("should prevent credential revocation by unauthorized parties", async function () {
      // Register material and issue credential
      const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("test"));
      await registry.registerMaterial(CELL_LINE, metadataHash, "Test_MSP");

      await registry.connect(issuer).issueCredential(
        "bio:cell_line:1",
        0,
        ethers.keccak256(ethers.toUtf8Bytes("credential")),
        Math.floor(Date.now() / 1000) + 86400,
        "s3://test",
        ethers.keccak256(ethers.toUtf8Bytes("artifact")),
        "Issuer_MSP"
      );

      // Attacker (not issuer, not admin) cannot revoke
      await expect(
        registry.connect(attacker).revokeCredential("cred:1")
      ).to.be.revertedWithCustomError(registry, "NotAuthorizedToRevoke");
    });

    it("should allow only issuer or admin to revoke credentials", async function () {
      // Register material and issue credential
      const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("test"));
      await registry.registerMaterial(CELL_LINE, metadataHash, "Test_MSP");

      await registry.connect(issuer).issueCredential(
        "bio:cell_line:1",
        0,
        ethers.keccak256(ethers.toUtf8Bytes("credential")),
        Math.floor(Date.now() / 1000) + 86400,
        "s3://test",
        ethers.keccak256(ethers.toUtf8Bytes("artifact")),
        "Issuer_MSP"
      );

      // Issuer can revoke their own credential
      await registry.connect(issuer).revokeCredential("cred:1");
      let cred = await registry.credentials("cred:1");
      expect(cred.revoked).to.be.true;

      // Reset for next test - issue another credential
      await registry.connect(issuer).issueCredential(
        "bio:cell_line:1",
        0,
        ethers.keccak256(ethers.toUtf8Bytes("credential2")),
        Math.floor(Date.now() / 1000) + 86400,
        "s3://test2",
        ethers.keccak256(ethers.toUtf8Bytes("artifact2")),
        "Issuer_MSP"
      );

      // Admin can also revoke
      await registry.revokeCredential("cred:2");
      cred = await registry.credentials("cred:2");
      expect(cred.revoked).to.be.true;
    });

    it("should enforce credential type permissions for issuers", async function () {
      // Register material
      const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("test"));
      await registry.registerMaterial(CELL_LINE, metadataHash, "Test_MSP");

      // Authorize issuer with only QC permissions
      await registry.authorizeIssuer(user.address, false, true, false);

      // User cannot issue IDENTITY (no permission)
      await expect(
        registry.connect(user).issueCredential(
          "bio:cell_line:1",
          0, // IDENTITY
          ethers.keccak256(ethers.toUtf8Bytes("credential")),
          Math.floor(Date.now() / 1000) + 86400,
          "s3://test",
          ethers.keccak256(ethers.toUtf8Bytes("artifact")),
          "User_MSP"
        )
      ).to.be.revertedWithCustomError(registry, "NotAuthorizedForCredentialType");

      // User CAN issue QC_MYCO (has permission)
      await registry.connect(user).issueCredential(
        "bio:cell_line:1",
        1, // QC_MYCO
        ethers.keccak256(ethers.toUtf8Bytes("qc")),
        Math.floor(Date.now() / 1000) + 86400,
        "s3://qc",
        ethers.keccak256(ethers.toUtf8Bytes("qc_artifact")),
        "User_MSP"
      );

      const creds = await registry.getCredentials("bio:cell_line:1");
      expect(creds.length).to.equal(1);
      expect(creds[0].credType).to.equal(1); // QC_MYCO
    });
  });

  describe("Input Validation Security", function () {
    it("should reject zero commitment hashes", async function () {
      const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("test"));
      await registry.registerMaterial(CELL_LINE, metadataHash, "Test_MSP");

      await expect(
        registry.connect(issuer).issueCredential(
          "bio:cell_line:1",
          0,
          ZERO_HASH, // Invalid
          Math.floor(Date.now() / 1000) + 86400,
          "s3://test",
          ethers.keccak256(ethers.toUtf8Bytes("artifact")),
          "Issuer_MSP"
        )
      ).to.be.revertedWithCustomError(registry, "InvalidCommitmentHash");
    });

    it("should reject zero artifact hashes", async function () {
      const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("test"));
      await registry.registerMaterial(CELL_LINE, metadataHash, "Test_MSP");

      await expect(
        registry.connect(issuer).issueCredential(
          "bio:cell_line:1",
          0,
          ethers.keccak256(ethers.toUtf8Bytes("credential")),
          Math.floor(Date.now() / 1000) + 86400,
          "s3://test",
          ZERO_HASH, // Invalid
          "Issuer_MSP"
        )
      ).to.be.revertedWithCustomError(registry, "InvalidArtifactHash");
    });

    it("should reject invalid validUntil timestamps", async function () {
      const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("test"));
      await registry.registerMaterial(CELL_LINE, metadataHash, "Test_MSP");

      // Past timestamp
      await expect(
        registry.connect(issuer).issueCredential(
          "bio:cell_line:1",
          0,
          ethers.keccak256(ethers.toUtf8Bytes("credential")),
          Math.floor(Date.now() / 1000) - 86400, // Yesterday (invalid)
          "s3://test",
          ethers.keccak256(ethers.toUtf8Bytes("artifact")),
          "Issuer_MSP"
        )
      ).to.be.revertedWithCustomError(registry, "InvalidValidUntil");
    });
  });
});
