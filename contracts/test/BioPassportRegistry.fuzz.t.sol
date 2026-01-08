// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Test.sol";
import "../src/BioPassportRegistry.sol";

/**
 * @title BioPassport Fuzz Tests
 * @notice Property-based testing for contract invariants
 * @dev Run with: forge test --fuzz-runs 10000
 */
contract BioPassportRegistryFuzzTest is Test {
    BioPassportRegistry public registry;
    
    address public admin;
    address public repositoryIssuer;
    address public qcLabIssuer;
    address public labA;
    
    bytes32 constant ZERO_HASH = bytes32(0);
    
    function setUp() public {
        admin = address(this);
        repositoryIssuer = makeAddr("repositoryIssuer");
        qcLabIssuer = makeAddr("qcLabIssuer");
        labA = makeAddr("labA");
        
        registry = new BioPassportRegistry();
        
        // Authorize issuers
        registry.authorizeIssuer(repositoryIssuer, true, false, true);
        registry.authorizeIssuer(qcLabIssuer, false, true, false);
    }
    
    // ==================== INV-1: Credential Issuance Authorization ====================
    
    /// @notice Fuzz test: unauthorized addresses cannot issue credentials
    function testFuzz_unauthorizedIssuerRejected(address issuer, uint8 credType) public {
        vm.assume(issuer != repositoryIssuer && issuer != qcLabIssuer && issuer != admin);
        vm.assume(credType <= 2); // Valid credential types
        
        // Register a material first
        bytes32 metadataHash = keccak256("test");
        registry.registerMaterial("CELL_LINE", metadataHash, "TestOrg");
        string memory materialId = "bio:cell_line:1";
        
        bytes32 commitmentHash = keccak256(abi.encodePacked(issuer, credType));
        bytes32 artifactHash = keccak256("artifact");
        
        vm.prank(issuer);
        vm.expectRevert(BioPassportRegistry.NotApprovedIssuer.selector);
        registry.issueCredential(
            materialId,
            BioPassportRegistry.CredentialType(credType),
            commitmentHash,
            block.timestamp + 365 days,
            "s3://test",
            artifactHash,
            "TestOrg"
        );
    }
    
    /// @notice Fuzz test: wrong permission type is rejected
    function testFuzz_wrongPermissionTypeRejected(uint8 credType) public {
        vm.assume(credType <= 2);
        
        bytes32 metadataHash = keccak256("test");
        registry.registerMaterial("CELL_LINE", metadataHash, "TestOrg");
        string memory materialId = "bio:cell_line:1";
        
        bytes32 commitmentHash = keccak256(abi.encodePacked("cred", credType));
        bytes32 artifactHash = keccak256("artifact");
        
        // QC issuer trying to issue IDENTITY (type 0)
        if (credType == 0) {
            vm.prank(qcLabIssuer);
            vm.expectRevert(BioPassportRegistry.NotAuthorizedForCredentialType.selector);
            registry.issueCredential(
                materialId,
                BioPassportRegistry.CredentialType.IDENTITY,
                commitmentHash,
                block.timestamp + 365 days,
                "s3://test",
                artifactHash,
                "QCLab"
            );
        }
        
        // Repository issuer trying to issue QC_MYCO (type 1)
        if (credType == 1) {
            vm.prank(repositoryIssuer);
            vm.expectRevert(BioPassportRegistry.NotAuthorizedForCredentialType.selector);
            registry.issueCredential(
                materialId,
                BioPassportRegistry.CredentialType.QC_MYCO,
                commitmentHash,
                block.timestamp + 365 days,
                "s3://test",
                artifactHash,
                "Repository"
            );
        }
    }
    
    // ==================== INV-2: Issuer Revocation Semantics ====================
    
    /// @notice Fuzz test: revoked issuer cannot issue new credentials
    function testFuzz_revokedIssuerCannotIssue(uint256 timeDelta) public {
        vm.assume(timeDelta > 0 && timeDelta < 365 days);
        
        bytes32 metadataHash = keccak256("test");
        registry.registerMaterial("CELL_LINE", metadataHash, "TestOrg");
        string memory materialId = "bio:cell_line:1";
        
        // Revoke the issuer
        registry.revokeIssuer(repositoryIssuer);
        
        // Advance time
        vm.warp(block.timestamp + timeDelta);
        
        bytes32 commitmentHash = keccak256(abi.encodePacked("cred", timeDelta));
        bytes32 artifactHash = keccak256("artifact");
        
        vm.prank(repositoryIssuer);
        vm.expectRevert(BioPassportRegistry.IssuerRevoked.selector);
        registry.issueCredential(
            materialId,
            BioPassportRegistry.CredentialType.IDENTITY,
            commitmentHash,
            block.timestamp + 365 days,
            "s3://test",
            artifactHash,
            "Repository"
        );
    }
    
    // ==================== INV-4: Transfer Chain Continuity ====================
    
    /// @notice Fuzz test: cannot initiate transfer while one is pending
    function testFuzz_noDuplicatePendingTransfer(address recipient1, address recipient2) public {
        vm.assume(recipient1 != address(0) && recipient2 != address(0));
        vm.assume(recipient1 != recipient2);
        
        bytes32 metadataHash = keccak256("test");
        registry.registerMaterial("CELL_LINE", metadataHash, "TestOrg");
        string memory materialId = "bio:cell_line:1";
        
        // Issue required credentials
        vm.prank(repositoryIssuer);
        registry.issueCredential(
            materialId,
            BioPassportRegistry.CredentialType.IDENTITY,
            keccak256("id"),
            block.timestamp + 365 days,
            "s3://id",
            keccak256("a1"),
            "Repo"
        );
        
        vm.prank(qcLabIssuer);
        registry.issueCredential(
            materialId,
            BioPassportRegistry.CredentialType.QC_MYCO,
            keccak256("qc"),
            block.timestamp + 90 days,
            "s3://qc",
            keccak256("a2"),
            "QC"
        );
        
        // Initiate first transfer
        bytes32 shipmentHash = keccak256(abi.encodePacked(recipient1));
        registry.initiateTransfer(materialId, recipient1, "Org1", shipmentHash);
        
        // Try to initiate second transfer
        bytes32 shipmentHash2 = keccak256(abi.encodePacked(recipient2));
        vm.expectRevert(BioPassportRegistry.PendingTransferExists.selector);
        registry.initiateTransfer(materialId, recipient2, "Org2", shipmentHash2);
    }
    
    // ==================== INV-6: Material Type Validation ====================
    
    /// @notice Fuzz test: invalid material types are rejected
    function testFuzz_invalidMaterialTypeRejected(string calldata materialType) public {
        bytes32 typeHash = keccak256(bytes(materialType));
        bool isValid = typeHash == keccak256("CELL_LINE") || typeHash == keccak256("PLASMID");
        
        if (!isValid) {
            bytes32 metadataHash = keccak256("test");
            vm.expectRevert(BioPassportRegistry.InvalidMaterialType.selector);
            registry.registerMaterial(materialType, metadataHash, "TestOrg");
        }
    }
    
    // ==================== INV-7: Commitment Hash Integrity ====================
    
    /// @notice Fuzz test: zero commitment hash is rejected
    function testFuzz_zeroCommitmentHashRejected(uint8 operation) public {
        vm.assume(operation <= 2);
        
        if (operation == 0) {
            // Register material with zero hash
            vm.expectRevert(BioPassportRegistry.InvalidCommitmentHash.selector);
            registry.registerMaterial("CELL_LINE", ZERO_HASH, "TestOrg");
        } else if (operation == 1) {
            // Issue credential with zero hash
            bytes32 metadataHash = keccak256("test");
            registry.registerMaterial("CELL_LINE", metadataHash, "TestOrg");
            
            vm.prank(repositoryIssuer);
            vm.expectRevert(BioPassportRegistry.InvalidCommitmentHash.selector);
            registry.issueCredential(
                "bio:cell_line:1",
                BioPassportRegistry.CredentialType.IDENTITY,
                ZERO_HASH,
                block.timestamp + 365 days,
                "s3://test",
                keccak256("artifact"),
                "Repo"
            );
        }
    }
    
    // ==================== Verification Consistency ====================
    
    /// @notice Fuzz test: verification result is deterministic
    function testFuzz_verificationDeterministic(uint256 seed) public {
        bytes32 metadataHash = keccak256(abi.encodePacked("test", seed));
        registry.registerMaterial("CELL_LINE", metadataHash, "TestOrg");
        string memory materialId = "bio:cell_line:1";
        
        // Issue credentials based on seed
        if (seed % 2 == 0) {
            vm.prank(repositoryIssuer);
            registry.issueCredential(
                materialId,
                BioPassportRegistry.CredentialType.IDENTITY,
                keccak256(abi.encodePacked("id", seed)),
                block.timestamp + 365 days,
                "s3://id",
                keccak256("a1"),
                "Repo"
            );
        }
        
        if (seed % 3 == 0) {
            vm.prank(qcLabIssuer);
            registry.issueCredential(
                materialId,
                BioPassportRegistry.CredentialType.QC_MYCO,
                keccak256(abi.encodePacked("qc", seed)),
                block.timestamp + 90 days,
                "s3://qc",
                keccak256("a2"),
                "QC"
            );
        }
        
        // Verify multiple times - should be deterministic
        (bool pass1, string[] memory reasons1) = registry.verifyMaterial(materialId);
        (bool pass2, string[] memory reasons2) = registry.verifyMaterial(materialId);
        
        assertEq(pass1, pass2, "Verification should be deterministic");
        assertEq(reasons1.length, reasons2.length, "Reason count should be deterministic");
    }
    
    // ==================== Status Authority Control ====================
    
    /// @notice Fuzz test: owner cannot set REVOKED status
    function testFuzz_ownerCannotRevoke(address owner) public {
        vm.assume(owner != address(0) && owner != admin);
        
        bytes32 metadataHash = keccak256(abi.encodePacked("test", owner));
        
        vm.prank(owner);
        registry.registerMaterial("CELL_LINE", metadataHash, "TestOrg");
        string memory materialId = "bio:cell_line:1";
        
        vm.prank(owner);
        vm.expectRevert(BioPassportRegistry.NotAuthorizedForStatus.selector);
        registry.setStatusByOwner(materialId, BioPassportRegistry.MaterialStatus.REVOKED, keccak256("reason"));
    }
}
