// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Test.sol";
import "../src/BioPassportRegistry.sol";

contract EdgeAttestationFuzzTest is Test {
    BioPassportRegistry registry;
    address admin = address(this);
    address issuer;
    uint256 devicePk;
    address deviceAddr;
    bytes32 deviceId = keccak256("device:olympus:SN-0001");

    function setUp() public {
        registry = new BioPassportRegistry();
        issuer = vm.addr(0xBEEF);
        devicePk = 0xDEAD;
        deviceAddr = vm.addr(devicePk);

        registry.authorizeIssuer(issuer, false, true, false);
        registry.enrollDevice(deviceId, deviceAddr, "MICROSCOPE");
        vm.prank(admin);
        registry.registerMaterial("CELL_LINE", keccak256("meta"), "OrgA");
    }

    /// @notice Forgery resistance: no signature by any key other than devicePk should pass.
    function testFuzz_attestation_forgery_resistance(uint256 forgerPk, uint256 captureTs) public {
        forgerPk = bound(forgerPk, 1, type(uint128).max);
        vm.assume(forgerPk != devicePk);
        captureTs = bound(captureTs, 1, block.timestamp);

        string memory materialId = "bio:cell_line:1";
        bytes32 commitment = keccak256("cred");
        bytes32 artifactHash = keccak256("art");

        bytes32 msgHash = registry.attestationHash(
            deviceId,
            materialId,
            BioPassportRegistry.CredentialType.QC_MYCO,
            commitment,
            artifactHash,
            captureTs
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(forgerPk, msgHash);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.prank(issuer);
        vm.expectRevert(BioPassportRegistry.InvalidDeviceSignature.selector);
        registry.issueCredentialWithAttestation(
            materialId,
            BioPassportRegistry.CredentialType.QC_MYCO,
            commitment,
            0,
            "s3://x",
            artifactHash,
            "OrgQC",
            deviceId,
            captureTs,
            sig
        );
    }
}
