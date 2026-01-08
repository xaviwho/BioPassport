// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title BioPassportRegistry V2
 * @notice On-chain registry for biomaterial provenance and credential anchoring
 * @dev Designed for PureChain (zero gas EVM). Implements:
 *      - Strict materialType validation (CELL_LINE or PLASMID only)
 *      - Authority-based status control (admin/QC can quarantine/revoke)
 *      - Issuer revocation with timestamp tracking
 *      - Latest QC credential policy (not just any valid QC)
 *      - Input sanity checks
 *      - Custom errors for gas efficiency
 */
contract BioPassportRegistry {
    // ==================== Custom Errors ====================
    
    error OnlyAdmin();
    error NotMaterialOwner();
    error NotAuthorizedForStatus();
    error MaterialNotFound();
    error MaterialAlreadyExists();
    error InvalidMaterialType();
    error NotApprovedIssuer();
    error IssuerRevoked();
    error NotAuthorizedForCredentialType();
    error CredentialNotFound();
    error CredentialAlreadyRevoked();
    error NotAuthorizedToRevoke();
    error InvalidCommitmentHash();
    error InvalidArtifactHash();
    error InvalidValidUntil();
    error MaterialNotActive();
    error PendingTransferExists();
    error NoTransfers();
    error NoPendingTransfer();
    error NotTransferRecipient();
    error InvalidHistoryIndex();
    
    // ==================== Types ====================
    
    enum MaterialStatus { ACTIVE, QUARANTINED, REVOKED }
    enum CredentialType { IDENTITY, QC_MYCO, USAGE_RIGHTS }
    
    struct Material {
        string materialId;      // bio:cell_line:<id> or bio:plasmid:<id>
        string materialType;    // CELL_LINE or PLASMID
        bytes32 metadataHash;   // sha256 of off-chain metadata JSON
        address owner;          // Current owner address
        string ownerOrg;        // Organization MSP ID
        MaterialStatus status;
        uint256 createdAt;
        uint256 updatedAt;
    }
    
    struct Credential {
        string credentialId;    // cred:<id>
        string materialId;
        CredentialType credType;
        bytes32 commitmentHash; // sha256(canonical_credential_json)
        address issuer;
        string issuerId;        // Issuer org MSP ID
        uint256 issuedAt;
        uint256 validUntil;
        string artifactCid;     // Off-chain storage URI (s3://, ipfs://)
        bytes32 artifactHash;   // sha256 of artifact file
        bool revoked;
    }
    
    struct Transfer {
        string transferId;      // xfer:<id>
        string materialId;
        address fromAddress;
        string fromOrg;
        address toAddress;
        string toOrg;
        bytes32 shipmentHash;   // sha256 of shipment documentation
        uint256 timestamp;
        bool accepted;
    }
    
    struct IssuerPermission {
        bool isApproved;
        bool canIssueIdentity;
        bool canIssueQC;
        bool canIssueUsageRights;
    }
    
    // ==================== State ====================
    
    address public admin;
    uint256 public materialCount;
    uint256 public credentialCount;
    uint256 public transferCount;
    
    // Material storage
    mapping(string => Material) public materials;
    mapping(string => bool) public materialExists;
    
    // Credential storage (materialId => credentialId[])
    mapping(string => string[]) public materialCredentials;
    mapping(string => Credential) public credentials;
    
    // Transfer storage (materialId => Transfer[])
    mapping(string => Transfer[]) public materialTransfers;
    
    // Issuer authorization with revocation tracking
    mapping(address => IssuerPermission) public issuerPermissions;
    mapping(address => uint256) public issuerRevokedAt; // 0 = not revoked, >0 = revocation timestamp
    
    // History events (for audit trail)
    mapping(string => bytes32[]) public materialHistory;
    
    // Valid material types
    bytes32 private constant CELL_LINE_HASH = keccak256("CELL_LINE");
    bytes32 private constant PLASMID_HASH = keccak256("PLASMID");
    
    // ==================== Events ====================
    
    event MaterialRegistered(
        string indexed materialId,
        string materialType,
        address indexed owner,
        string ownerOrg,
        uint256 timestamp
    );
    
    event CredentialIssued(
        string indexed credentialId,
        string indexed materialId,
        CredentialType credType,
        address indexed issuer,
        uint256 validUntil
    );
    
    event CredentialRevoked(
        string indexed credentialId,
        string indexed materialId,
        address indexed revoker,
        uint256 timestamp
    );
    
    event TransferInitiated(
        string indexed transferId,
        string indexed materialId,
        address indexed from,
        address to,
        uint256 timestamp
    );
    
    event TransferAccepted(
        string indexed transferId,
        string indexed materialId,
        address indexed newOwner,
        uint256 timestamp
    );
    
    event StatusChangedByOwner(
        string indexed materialId,
        MaterialStatus oldStatus,
        MaterialStatus newStatus,
        bytes32 reasonHash,
        uint256 timestamp
    );
    
    event StatusChangedByAuthority(
        string indexed materialId,
        MaterialStatus oldStatus,
        MaterialStatus newStatus,
        address indexed authority,
        bytes32 reasonHash,
        uint256 timestamp
    );
    
    event IssuerAuthorized(
        address indexed issuer,
        bool canIdentity,
        bool canQC,
        bool canUsageRights
    );
    
    event IssuerRevoked(address indexed issuer, uint256 revokedAt);
    
    // ==================== Modifiers ====================
    
    modifier onlyAdmin() {
        if (msg.sender != admin) revert OnlyAdmin();
        _;
    }
    
    modifier onlyMaterialOwner(string memory materialId) {
        if (!materialExists[materialId]) revert MaterialNotFound();
        if (materials[materialId].owner != msg.sender) revert NotMaterialOwner();
        _;
    }
    
    modifier onlyApprovedIssuer() {
        if (!issuerPermissions[msg.sender].isApproved) revert NotApprovedIssuer();
        if (issuerRevokedAt[msg.sender] != 0) revert IssuerRevoked();
        _;
    }
    
    modifier materialMustExist(string memory materialId) {
        if (!materialExists[materialId]) revert MaterialNotFound();
        _;
    }
    
    // ==================== Constructor ====================
    
    constructor() {
        admin = msg.sender;
        // Admin is automatically an approved issuer with all permissions
        issuerPermissions[msg.sender] = IssuerPermission({
            isApproved: true,
            canIssueIdentity: true,
            canIssueQC: true,
            canIssueUsageRights: true
        });
    }
    
    // ==================== Admin Functions ====================
    
    /**
     * @notice Authorize an issuer with specific credential type permissions
     */
    function authorizeIssuer(
        address issuer,
        bool canIdentity,
        bool canQC,
        bool canUsageRights
    ) external onlyAdmin {
        issuerPermissions[issuer] = IssuerPermission({
            isApproved: true,
            canIssueIdentity: canIdentity,
            canIssueQC: canQC,
            canIssueUsageRights: canUsageRights
        });
        // Clear any previous revocation
        issuerRevokedAt[issuer] = 0;
        
        emit IssuerAuthorized(issuer, canIdentity, canQC, canUsageRights);
    }
    
    /**
     * @notice Revoke issuer authorization with timestamp tracking
     * @dev Credentials issued after this timestamp will be considered invalid
     */
    function revokeIssuer(address issuer) external onlyAdmin {
        issuerPermissions[issuer].isApproved = false;
        issuerRevokedAt[issuer] = block.timestamp;
        
        emit IssuerRevoked(issuer, block.timestamp);
    }
    
    // ==================== Material Functions ====================
    
    /**
     * @notice Register a new biomaterial
     * @param materialType Must be exactly "CELL_LINE" or "PLASMID"
     * @param metadataHash sha256 hash of off-chain metadata JSON (must be non-zero)
     * @param ownerOrg Organization MSP ID
     * @return materialId The generated material ID
     */
    function registerMaterial(
        string memory materialType,
        bytes32 metadataHash,
        string memory ownerOrg
    ) external returns (string memory materialId) {
        // Must-fix #1: Validate materialType strictly
        bytes32 mtHash = keccak256(bytes(materialType));
        if (mtHash != CELL_LINE_HASH && mtHash != PLASMID_HASH) {
            revert InvalidMaterialType();
        }
        
        // Must-fix #5: Input sanity check
        if (metadataHash == bytes32(0)) revert InvalidCommitmentHash();
        
        materialCount++;
        
        // Generate standardized material ID
        string memory typePrefix = (mtHash == CELL_LINE_HASH) ? "cell_line" : "plasmid";
        materialId = string(abi.encodePacked("bio:", typePrefix, ":", uint2str(materialCount)));
        
        if (materialExists[materialId]) revert MaterialAlreadyExists();
        
        materials[materialId] = Material({
            materialId: materialId,
            materialType: materialType,
            metadataHash: metadataHash,
            owner: msg.sender,
            ownerOrg: ownerOrg,
            status: MaterialStatus.ACTIVE,
            createdAt: block.timestamp,
            updatedAt: block.timestamp
        });
        
        materialExists[materialId] = true;
        
        // Record in history
        materialHistory[materialId].push(keccak256(abi.encodePacked(
            "REGISTERED", msg.sender, block.timestamp
        )));
        
        emit MaterialRegistered(materialId, materialType, msg.sender, ownerOrg, block.timestamp);
        
        return materialId;
    }
    
    /**
     * @notice Owner can self-quarantine (but NOT revoke)
     * @dev Must-fix #2: Owners can only quarantine, not revoke
     */
    function setStatusByOwner(
        string memory materialId,
        MaterialStatus newStatus,
        bytes32 reasonHash
    ) external onlyMaterialOwner(materialId) {
        // Owners can only set QUARANTINED or return to ACTIVE
        if (newStatus == MaterialStatus.REVOKED) revert NotAuthorizedForStatus();
        
        Material storage mat = materials[materialId];
        MaterialStatus oldStatus = mat.status;
        
        // Cannot change from REVOKED
        if (oldStatus == MaterialStatus.REVOKED) revert NotAuthorizedForStatus();
        
        mat.status = newStatus;
        mat.updatedAt = block.timestamp;
        
        materialHistory[materialId].push(keccak256(abi.encodePacked(
            "STATUS_OWNER", uint8(newStatus), reasonHash, block.timestamp
        )));
        
        emit StatusChangedByOwner(materialId, oldStatus, newStatus, reasonHash, block.timestamp);
    }
    
    /**
     * @notice Admin or authorized QC issuer can quarantine/revoke
     * @dev Must-fix #2: Authority-based status control
     */
    function setStatusByAuthority(
        string memory materialId,
        MaterialStatus newStatus,
        bytes32 reasonHash
    ) external materialMustExist(materialId) {
        // Must be admin OR an approved QC issuer (not revoked)
        bool isAuthorized = (msg.sender == admin) || 
            (issuerPermissions[msg.sender].isApproved && 
             issuerPermissions[msg.sender].canIssueQC &&
             issuerRevokedAt[msg.sender] == 0);
        
        if (!isAuthorized) revert NotAuthorizedForStatus();
        
        Material storage mat = materials[materialId];
        MaterialStatus oldStatus = mat.status;
        
        mat.status = newStatus;
        mat.updatedAt = block.timestamp;
        
        materialHistory[materialId].push(keccak256(abi.encodePacked(
            "STATUS_AUTHORITY", msg.sender, uint8(newStatus), reasonHash, block.timestamp
        )));
        
        emit StatusChangedByAuthority(materialId, oldStatus, newStatus, msg.sender, reasonHash, block.timestamp);
    }
    
    // ==================== Credential Functions ====================
    
    /**
     * @notice Issue a credential (commitment hash only - full credential stored off-chain)
     * @dev Must-fix #5: Input validation for hashes and timestamps
     */
    function issueCredential(
        string memory materialId,
        CredentialType credType,
        bytes32 commitmentHash,
        uint256 validUntil,
        string memory artifactCid,
        bytes32 artifactHash,
        string memory issuerId
    ) external onlyApprovedIssuer materialMustExist(materialId) returns (string memory credentialId) {
        // Must-fix #5: Input sanity checks
        if (commitmentHash == bytes32(0)) revert InvalidCommitmentHash();
        if (artifactHash == bytes32(0)) revert InvalidArtifactHash();
        if (validUntil != 0 && validUntil <= block.timestamp) revert InvalidValidUntil();
        
        // Check issuer has permission for this credential type
        IssuerPermission memory perm = issuerPermissions[msg.sender];
        if (credType == CredentialType.IDENTITY) {
            if (!perm.canIssueIdentity) revert NotAuthorizedForCredentialType();
        } else if (credType == CredentialType.QC_MYCO) {
            if (!perm.canIssueQC) revert NotAuthorizedForCredentialType();
        } else if (credType == CredentialType.USAGE_RIGHTS) {
            if (!perm.canIssueUsageRights) revert NotAuthorizedForCredentialType();
        }
        
        credentialCount++;
        credentialId = string(abi.encodePacked("cred:", uint2str(credentialCount)));
        
        credentials[credentialId] = Credential({
            credentialId: credentialId,
            materialId: materialId,
            credType: credType,
            commitmentHash: commitmentHash,
            issuer: msg.sender,
            issuerId: issuerId,
            issuedAt: block.timestamp,
            validUntil: validUntil,
            artifactCid: artifactCid,
            artifactHash: artifactHash,
            revoked: false
        });
        
        materialCredentials[materialId].push(credentialId);
        
        materialHistory[materialId].push(keccak256(abi.encodePacked(
            "CREDENTIAL_ISSUED", credentialId, uint8(credType), block.timestamp
        )));
        
        emit CredentialIssued(credentialId, materialId, credType, msg.sender, validUntil);
        
        return credentialId;
    }
    
    /**
     * @notice Revoke a credential
     */
    function revokeCredential(string memory credentialId) external {
        Credential storage cred = credentials[credentialId];
        if (bytes(cred.credentialId).length == 0) revert CredentialNotFound();
        if (cred.issuer != msg.sender && msg.sender != admin) revert NotAuthorizedToRevoke();
        if (cred.revoked) revert CredentialAlreadyRevoked();
        
        cred.revoked = true;
        
        materialHistory[cred.materialId].push(keccak256(abi.encodePacked(
            "CREDENTIAL_REVOKED", credentialId, block.timestamp
        )));
        
        emit CredentialRevoked(credentialId, cred.materialId, msg.sender, block.timestamp);
    }
    
    // ==================== Transfer Functions ====================
    
    /**
     * @notice Initiate a material transfer (enforces chain continuity)
     */
    function initiateTransfer(
        string memory materialId,
        address toAddress,
        string memory toOrg,
        bytes32 shipmentHash
    ) external onlyMaterialOwner(materialId) returns (string memory transferId) {
        Material storage mat = materials[materialId];
        if (mat.status != MaterialStatus.ACTIVE) revert MaterialNotActive();
        
        // Check no pending transfers
        Transfer[] storage transfers = materialTransfers[materialId];
        if (transfers.length > 0 && !transfers[transfers.length - 1].accepted) {
            revert PendingTransferExists();
        }
        
        transferCount++;
        transferId = string(abi.encodePacked("xfer:", uint2str(transferCount)));
        
        transfers.push(Transfer({
            transferId: transferId,
            materialId: materialId,
            fromAddress: msg.sender,
            fromOrg: mat.ownerOrg,
            toAddress: toAddress,
            toOrg: toOrg,
            shipmentHash: shipmentHash,
            timestamp: block.timestamp,
            accepted: false
        }));
        
        materialHistory[materialId].push(keccak256(abi.encodePacked(
            "TRANSFER_INITIATED", transferId, toAddress, block.timestamp
        )));
        
        emit TransferInitiated(transferId, materialId, msg.sender, toAddress, block.timestamp);
        
        return transferId;
    }
    
    /**
     * @notice Accept a pending transfer
     */
    function acceptTransfer(string memory materialId) external materialMustExist(materialId) {
        Transfer[] storage transfers = materialTransfers[materialId];
        if (transfers.length == 0) revert NoTransfers();
        
        Transfer storage pending = transfers[transfers.length - 1];
        if (pending.accepted) revert NoPendingTransfer();
        if (pending.toAddress != msg.sender) revert NotTransferRecipient();
        
        pending.accepted = true;
        
        Material storage mat = materials[materialId];
        mat.owner = msg.sender;
        mat.ownerOrg = pending.toOrg;
        mat.updatedAt = block.timestamp;
        
        materialHistory[materialId].push(keccak256(abi.encodePacked(
            "TRANSFER_ACCEPTED", pending.transferId, msg.sender, block.timestamp
        )));
        
        emit TransferAccepted(pending.transferId, materialId, msg.sender, block.timestamp);
    }
    
    // ==================== Query Functions ====================
    
    function getMaterial(string memory materialId) 
        external view 
        materialMustExist(materialId) 
        returns (Material memory) 
    {
        return materials[materialId];
    }
    
    function getCredentials(string memory materialId) 
        external view 
        returns (Credential[] memory) 
    {
        string[] memory credIds = materialCredentials[materialId];
        Credential[] memory creds = new Credential[](credIds.length);
        
        for (uint i = 0; i < credIds.length; i++) {
            creds[i] = credentials[credIds[i]];
        }
        
        return creds;
    }
    
    /**
     * @notice Get credential IDs for pagination support
     */
    function getCredentialIds(string memory materialId) 
        external view 
        returns (string[] memory) 
    {
        return materialCredentials[materialId];
    }
    
    /**
     * @notice Get single credential by ID
     */
    function getCredential(string memory credentialId) 
        external view 
        returns (Credential memory) 
    {
        if (bytes(credentials[credentialId].credentialId).length == 0) {
            revert CredentialNotFound();
        }
        return credentials[credentialId];
    }
    
    function getTransfers(string memory materialId) 
        external view 
        returns (Transfer[] memory) 
    {
        return materialTransfers[materialId];
    }
    
    /**
     * @notice Verify material validity at current time
     * @dev Must-fix #3: Checks issuer revocation timestamp
     * @dev Must-fix #4: Uses LATEST QC credential only
     */
    function verifyMaterial(string memory materialId) 
        external view 
        materialMustExist(materialId) 
        returns (bool pass, string[] memory reasons) 
    {
        return _verifyMaterialAt(materialId, block.timestamp);
    }
    
    function verifyMaterialAt(string memory materialId, uint256 atTime) 
        external view 
        materialMustExist(materialId) 
        returns (bool pass, string[] memory reasons) 
    {
        return _verifyMaterialAt(materialId, atTime);
    }
    
    function _verifyMaterialAt(string memory materialId, uint256 atTime) 
        internal view 
        returns (bool pass, string[] memory reasons) 
    {
        Material memory mat = materials[materialId];
        string[] memory tempReasons = new string[](10);
        uint reasonCount = 0;
        
        // Check 1: Material status
        if (mat.status == MaterialStatus.REVOKED) {
            tempReasons[reasonCount++] = "MATERIAL_REVOKED";
        } else if (mat.status == MaterialStatus.QUARANTINED) {
            tempReasons[reasonCount++] = "MATERIAL_QUARANTINED";
        }
        
        // Check 2: Has valid IDENTITY credential (from non-revoked issuer)
        bool hasIdentity = false;
        
        // Must-fix #4: Track LATEST QC credential
        uint256 latestQcIssuedAt = 0;
        uint256 latestQcValidUntil = 0;
        bool latestQcFromRevokedIssuer = false;
        
        string[] memory credIds = materialCredentials[materialId];
        for (uint i = 0; i < credIds.length; i++) {
            Credential memory cred = credentials[credIds[i]];
            
            // Must-fix #3: Check if issuer was revoked BEFORE credential was issued
            uint256 issuerRevokeTime = issuerRevokedAt[cred.issuer];
            bool issuerWasRevokedBeforeIssuance = (issuerRevokeTime != 0 && cred.issuedAt >= issuerRevokeTime);
            
            if (cred.credType == CredentialType.IDENTITY && !cred.revoked && !issuerWasRevokedBeforeIssuance) {
                hasIdentity = true;
            }
            
            // Must-fix #4: Find the LATEST QC credential
            if (cred.credType == CredentialType.QC_MYCO && !cred.revoked) {
                if (cred.issuedAt > latestQcIssuedAt) {
                    latestQcIssuedAt = cred.issuedAt;
                    latestQcValidUntil = cred.validUntil;
                    latestQcFromRevokedIssuer = issuerWasRevokedBeforeIssuance;
                }
            }
        }
        
        if (!hasIdentity) {
            tempReasons[reasonCount++] = "MISSING_IDENTITY";
        }
        
        // Must-fix #4: Evaluate only the LATEST QC credential
        bool hasValidQC = (latestQcIssuedAt != 0 && 
                          latestQcValidUntil >= atTime && 
                          !latestQcFromRevokedIssuer);
        
        if (!hasValidQC) {
            if (latestQcIssuedAt == 0) {
                tempReasons[reasonCount++] = "QC_MISSING";
            } else if (latestQcFromRevokedIssuer) {
                tempReasons[reasonCount++] = "QC_ISSUER_REVOKED";
            } else {
                tempReasons[reasonCount++] = "QC_EXPIRED";
            }
        }
        
        // Check 3: Transfer chain continuity
        Transfer[] memory transfers = materialTransfers[materialId];
        for (uint i = 0; i < transfers.length; i++) {
            if (!transfers[i].accepted) {
                tempReasons[reasonCount++] = "TRANSFER_PENDING";
                break;
            }
        }
        
        // Build final reasons array
        reasons = new string[](reasonCount);
        for (uint i = 0; i < reasonCount; i++) {
            reasons[i] = tempReasons[i];
        }
        
        pass = (reasonCount == 0);
        return (pass, reasons);
    }
    
    // ==================== History Functions ====================
    
    function getHistoryCount(string memory materialId) external view returns (uint256) {
        return materialHistory[materialId].length;
    }
    
    /**
     * @notice Get history entry at specific index
     */
    function getHistoryAt(string memory materialId, uint256 index) 
        external view 
        returns (bytes32) 
    {
        if (index >= materialHistory[materialId].length) revert InvalidHistoryIndex();
        return materialHistory[materialId][index];
    }
    
    /**
     * @notice Get history slice (for pagination)
     */
    function getHistorySlice(string memory materialId, uint256 offset, uint256 limit) 
        external view 
        returns (bytes32[] memory) 
    {
        bytes32[] storage history = materialHistory[materialId];
        uint256 len = history.length;
        
        if (offset >= len) {
            return new bytes32[](0);
        }
        
        uint256 end = offset + limit;
        if (end > len) end = len;
        
        bytes32[] memory slice = new bytes32[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            slice[i - offset] = history[i];
        }
        
        return slice;
    }
    
    // ==================== Utility Functions ====================
    
    function uint2str(uint256 _i) internal pure returns (string memory) {
        if (_i == 0) return "0";
        uint256 j = _i;
        uint256 length;
        while (j != 0) {
            length++;
            j /= 10;
        }
        bytes memory bstr = new bytes(length);
        uint256 k = length;
        while (_i != 0) {
            k = k - 1;
            uint8 temp = (48 + uint8(_i - _i / 10 * 10));
            bytes1 b1 = bytes1(temp);
            bstr[k] = b1;
            _i /= 10;
        }
        return string(bstr);
    }
}
