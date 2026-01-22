// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title BioPassportV2
 * @notice Production-ready, acquirer-friendly biological material provenance registry
 * @dev Event-driven design: minimal on-chain storage, rich event logs for indexing
 * 
 * Architecture:
 *   - On-chain: hashes + pointers + signatures + minimal metadata
 *   - Off-chain: evidence files (S3/IPFS), indexed DB, API layer
 *   - Events: the audit trail (indexed for efficient querying)
 */
contract BioPassportV2 is AccessControl, ReentrancyGuard {
    
    // ==================== Roles ====================
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");
    bytes32 public constant AUDITOR_ROLE = keccak256("AUDITOR_ROLE");
    
    // ==================== Structs ====================
    
    /**
     * @notice Credential record stored on-chain
     * @dev Minimal storage: only hashes and pointers, no bulk data
     */
    struct CredentialRecord {
        bytes32 assetIdHash;        // keccak256(assetId)
        bytes32 credentialHash;     // keccak256(canonicalized credential JSON)
        bytes32 prevHash;           // Previous credential hash (chain linkage)
        bytes32 evidenceRoot;       // keccak256(sorted evidence SHA256s)
        string pointer;             // Off-chain location (s3://, ipfs://, https://)
        address issuer;             // Issuer wallet address
        uint64 issuedAt;            // Block timestamp
        bool exists;                // Existence flag
    }
    
    /**
     * @notice Exception record for compliance issues
     */
    struct ExceptionRecord {
        uint256 exceptionId;
        bytes32 assetIdHash;
        bytes32 relatedCredentialHash;
        uint8 reasonCode;           // 1=HASH_MISMATCH, 2=EVIDENCE_MISSING, 3=CHAIN_BREAK, etc.
        string detailsPointer;      // Off-chain exception details
        address openedBy;
        uint64 openedAt;
        bool closed;
        address closedBy;
        uint64 closedAt;
        string resolutionPointer;
    }
    
    /**
     * @notice Asset registration record
     */
    struct AssetRecord {
        bytes32 assetIdHash;
        string pointer;             // Off-chain asset metadata location
        address registrar;
        uint64 createdAt;
        bytes32 latestCredentialHash;
        bool exists;
    }
    
    // ==================== Storage ====================
    
    // Assets: assetIdHash => AssetRecord
    mapping(bytes32 => AssetRecord) public assets;
    
    // Credentials: credentialHash => CredentialRecord
    mapping(bytes32 => CredentialRecord) public credentials;
    
    // Exceptions: exceptionId => ExceptionRecord
    mapping(uint256 => ExceptionRecord) public exceptions;
    
    // Exception counter
    uint256 public nextExceptionId;
    
    // Credential count per asset (for chain length queries)
    mapping(bytes32 => uint256) public credentialCount;
    
    // ==================== Events ====================
    
    /**
     * @notice Emitted when a new asset is registered
     */
    event AssetRegistered(
        bytes32 indexed assetIdHash,
        string pointer,
        address indexed registrar,
        uint64 timestamp
    );
    
    /**
     * @notice Emitted when a credential is issued
     * @dev This is the primary audit trail event
     */
    event CredentialIssued(
        bytes32 indexed assetIdHash,
        bytes32 indexed credentialHash,
        bytes32 prevHash,
        bytes32 evidenceRoot,
        string pointer,
        address indexed issuer,
        uint64 timestamp
    );
    
    /**
     * @notice Emitted when an exception is opened
     */
    event ExceptionOpened(
        uint256 indexed exceptionId,
        bytes32 indexed assetIdHash,
        bytes32 relatedCredentialHash,
        uint8 reasonCode,
        string detailsPointer,
        address indexed openedBy,
        uint64 timestamp
    );
    
    /**
     * @notice Emitted when an exception is closed
     */
    event ExceptionClosed(
        uint256 indexed exceptionId,
        string resolutionPointer,
        address indexed closedBy,
        uint64 timestamp
    );
    
    // ==================== Errors ====================
    
    error AssetAlreadyExists();
    error AssetNotFound();
    error CredentialAlreadyExists();
    error CredentialNotFound();
    error InvalidPrevHash();
    error InvalidEvidenceRoot();
    error InvalidPointer();
    error ExceptionNotFound();
    error ExceptionAlreadyClosed();
    error ZeroHash();
    
    // ==================== Constructor ====================
    
    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ISSUER_ROLE, msg.sender);
        _grantRole(AUDITOR_ROLE, msg.sender);
        nextExceptionId = 1;
    }
    
    // ==================== Asset Functions ====================
    
    /**
     * @notice Register a new asset (sample, batch, kit, shipment)
     * @param assetIdHash keccak256 hash of the asset ID
     * @param pointer Off-chain location of asset metadata
     */
    function registerAsset(
        bytes32 assetIdHash,
        string calldata pointer
    ) external onlyRole(ISSUER_ROLE) {
        if (assetIdHash == bytes32(0)) revert ZeroHash();
        if (bytes(pointer).length == 0) revert InvalidPointer();
        if (assets[assetIdHash].exists) revert AssetAlreadyExists();
        
        assets[assetIdHash] = AssetRecord({
            assetIdHash: assetIdHash,
            pointer: pointer,
            registrar: msg.sender,
            createdAt: uint64(block.timestamp),
            latestCredentialHash: bytes32(0),
            exists: true
        });
        
        emit AssetRegistered(assetIdHash, pointer, msg.sender, uint64(block.timestamp));
    }
    
    // ==================== Credential Functions ====================
    
    /**
     * @notice Issue a credential for an asset
     * @param assetIdHash Asset this credential belongs to
     * @param credentialHash keccak256 of canonicalized credential JSON
     * @param prevHash Previous credential hash (0x0 for first credential)
     * @param evidenceRoot keccak256(sorted evidence file hashes)
     * @param pointer Off-chain location of credential JSON
     */
    function issueCredential(
        bytes32 assetIdHash,
        bytes32 credentialHash,
        bytes32 prevHash,
        bytes32 evidenceRoot,
        string calldata pointer
    ) external onlyRole(ISSUER_ROLE) nonReentrant {
        // Validate inputs
        if (assetIdHash == bytes32(0)) revert ZeroHash();
        if (credentialHash == bytes32(0)) revert ZeroHash();
        if (evidenceRoot == bytes32(0)) revert InvalidEvidenceRoot();
        if (bytes(pointer).length == 0) revert InvalidPointer();
        
        // Asset must exist
        AssetRecord storage asset = assets[assetIdHash];
        if (!asset.exists) revert AssetNotFound();
        
        // Credential must not already exist
        if (credentials[credentialHash].exists) revert CredentialAlreadyExists();
        
        // Validate chain linkage
        if (asset.latestCredentialHash != prevHash) revert InvalidPrevHash();
        
        // If prevHash is set, it must exist
        if (prevHash != bytes32(0) && !credentials[prevHash].exists) {
            revert CredentialNotFound();
        }
        
        // Store credential
        credentials[credentialHash] = CredentialRecord({
            assetIdHash: assetIdHash,
            credentialHash: credentialHash,
            prevHash: prevHash,
            evidenceRoot: evidenceRoot,
            pointer: pointer,
            issuer: msg.sender,
            issuedAt: uint64(block.timestamp),
            exists: true
        });
        
        // Update asset's latest credential
        asset.latestCredentialHash = credentialHash;
        credentialCount[assetIdHash]++;
        
        emit CredentialIssued(
            assetIdHash,
            credentialHash,
            prevHash,
            evidenceRoot,
            pointer,
            msg.sender,
            uint64(block.timestamp)
        );
    }
    
    // ==================== Exception Functions ====================
    
    /**
     * @notice Open an exception for a verification failure
     * @param assetIdHash Asset with the issue
     * @param relatedCredentialHash Credential that failed verification (0x0 if N/A)
     * @param reasonCode Exception reason (1=HASH_MISMATCH, 2=EVIDENCE_MISSING, etc.)
     * @param detailsPointer Off-chain location of exception details
     */
    function openException(
        bytes32 assetIdHash,
        bytes32 relatedCredentialHash,
        uint8 reasonCode,
        string calldata detailsPointer
    ) external onlyRole(ISSUER_ROLE) returns (uint256 exceptionId) {
        if (assetIdHash == bytes32(0)) revert ZeroHash();
        if (!assets[assetIdHash].exists) revert AssetNotFound();
        
        exceptionId = nextExceptionId++;
        
        exceptions[exceptionId] = ExceptionRecord({
            exceptionId: exceptionId,
            assetIdHash: assetIdHash,
            relatedCredentialHash: relatedCredentialHash,
            reasonCode: reasonCode,
            detailsPointer: detailsPointer,
            openedBy: msg.sender,
            openedAt: uint64(block.timestamp),
            closed: false,
            closedBy: address(0),
            closedAt: 0,
            resolutionPointer: ""
        });
        
        emit ExceptionOpened(
            exceptionId,
            assetIdHash,
            relatedCredentialHash,
            reasonCode,
            detailsPointer,
            msg.sender,
            uint64(block.timestamp)
        );
    }
    
    /**
     * @notice Close an exception with resolution
     * @param exceptionId Exception to close
     * @param resolutionPointer Off-chain location of resolution details
     */
    function closeException(
        uint256 exceptionId,
        string calldata resolutionPointer
    ) external onlyRole(ISSUER_ROLE) {
        ExceptionRecord storage exc = exceptions[exceptionId];
        if (exc.exceptionId == 0) revert ExceptionNotFound();
        if (exc.closed) revert ExceptionAlreadyClosed();
        
        exc.closed = true;
        exc.closedBy = msg.sender;
        exc.closedAt = uint64(block.timestamp);
        exc.resolutionPointer = resolutionPointer;
        
        emit ExceptionClosed(
            exceptionId,
            resolutionPointer,
            msg.sender,
            uint64(block.timestamp)
        );
    }
    
    // ==================== View Functions ====================
    
    /**
     * @notice Get asset details
     */
    function getAsset(bytes32 assetIdHash) external view returns (AssetRecord memory) {
        if (!assets[assetIdHash].exists) revert AssetNotFound();
        return assets[assetIdHash];
    }
    
    /**
     * @notice Get credential details
     */
    function getCredential(bytes32 credentialHash) external view returns (CredentialRecord memory) {
        if (!credentials[credentialHash].exists) revert CredentialNotFound();
        return credentials[credentialHash];
    }
    
    /**
     * @notice Get exception details
     */
    function getException(uint256 exceptionId) external view returns (ExceptionRecord memory) {
        if (exceptions[exceptionId].exceptionId == 0) revert ExceptionNotFound();
        return exceptions[exceptionId];
    }
    
    /**
     * @notice Verify a credential's chain linkage (on-chain only)
     * @return valid True if prevHash matches and credential exists
     */
    function verifyChainLinkage(bytes32 credentialHash) external view returns (bool valid) {
        CredentialRecord storage cred = credentials[credentialHash];
        if (!cred.exists) return false;
        
        // First credential: prevHash should be 0x0
        if (cred.prevHash == bytes32(0)) return true;
        
        // Otherwise, prevHash must exist and belong to same asset
        CredentialRecord storage prevCred = credentials[cred.prevHash];
        return prevCred.exists && prevCred.assetIdHash == cred.assetIdHash;
    }
    
    /**
     * @notice Get credential chain length for an asset
     */
    function getCredentialCount(bytes32 assetIdHash) external view returns (uint256) {
        return credentialCount[assetIdHash];
    }
    
    /**
     * @notice Check if address has issuer role
     */
    function isIssuer(address account) external view returns (bool) {
        return hasRole(ISSUER_ROLE, account);
    }
    
    /**
     * @notice Check if address has auditor role
     */
    function isAuditor(address account) external view returns (bool) {
        return hasRole(AUDITOR_ROLE, account);
    }
}
