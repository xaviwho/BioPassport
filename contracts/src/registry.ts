/**
 * BioPassport Registry Contract for PureChain
 * 
 * Core contract implementing material registration, credential issuance,
 * transfer management, and policy-based verification.
 */

import { v4 as uuidv4 } from 'uuid';
import {
  Material,
  MaterialType,
  MaterialStatus,
  Credential,
  CredentialType,
  TransferEvent,
  PolicyRule,
  VerificationResult,
  VerificationReason,
  CredentialStatus,
  MaterialHistory,
  HistoryEvent,
  ArtifactRef
} from './types';

// PureChain SDK interfaces (stub for type safety)
interface PureChainContext {
  stub: {
    getTxID(): string;
    getTxTimestamp(): Date;
    getState(key: string): Promise<Uint8Array | null>;
    putState(key: string, value: Uint8Array): Promise<void>;
    deleteState(key: string): Promise<void>;
    getStateByRange(startKey: string, endKey: string): Promise<StateIterator>;
    getStateByPartialCompositeKey(objectType: string, attributes: string[]): Promise<StateIterator>;
    createCompositeKey(objectType: string, attributes: string[]): string;
    splitCompositeKey(compositeKey: string): { objectType: string; attributes: string[] };
  };
  clientIdentity: {
    getID(): string;
    getMSPID(): string;
    getAttributeValue(name: string): string | null;
  };
}

interface StateIterator {
  next(): Promise<{ value: { key: string; value: Uint8Array } | null; done: boolean }>;
  close(): Promise<void>;
}

// State key prefixes
const PREFIX = {
  MATERIAL: 'MAT',
  CREDENTIAL: 'CRED',
  TRANSFER: 'XFER',
  POLICY: 'POL',
  HISTORY: 'HIST',
  ORG_MATERIAL: 'ORGMAT',
  MATERIAL_CRED: 'MATCRED'
};

export class BioPassportRegistry {
  
  /**
   * Initialize the registry with default policies
   */
  async init(ctx: PureChainContext): Promise<void> {
    // Set default policy for cell lines
    const defaultCellLinePolicy: PolicyRule = {
      policyId: 'default-cell-line',
      materialType: MaterialType.CELL_LINE,
      requiredCredentials: [CredentialType.IDENTITY, CredentialType.QC_MYCO],
      qcExpiryDays: 90,
      requireContinuousTransferChain: true
    };
    
    const defaultPlasmidPolicy: PolicyRule = {
      policyId: 'default-plasmid',
      materialType: MaterialType.PLASMID,
      requiredCredentials: [CredentialType.IDENTITY],
      qcExpiryDays: 365,
      requireContinuousTransferChain: true
    };

    await this.putState(ctx, `${PREFIX.POLICY}:${defaultCellLinePolicy.policyId}`, defaultCellLinePolicy);
    await this.putState(ctx, `${PREFIX.POLICY}:${defaultPlasmidPolicy.policyId}`, defaultPlasmidPolicy);
  }

  /**
   * Register a new biomaterial
   */
  async registerMaterial(
    ctx: PureChainContext,
    materialType: MaterialType,
    metadataHash: string
  ): Promise<Material> {
    const materialId = `bio:${materialType.toLowerCase()}:${uuidv4()}`;
    const ownerOrg = ctx.clientIdentity.getMSPID();
    const timestamp = ctx.stub.getTxTimestamp().toISOString();

    const material: Material = {
      materialId,
      materialType,
      metadataHash,
      ownerOrg,
      status: MaterialStatus.ACTIVE,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    // Store material
    await this.putState(ctx, `${PREFIX.MATERIAL}:${materialId}`, material);
    
    // Create composite key for org lookup
    const orgKey = ctx.stub.createCompositeKey(PREFIX.ORG_MATERIAL, [ownerOrg, materialId]);
    await ctx.stub.putState(orgKey, Buffer.from(materialId));

    // Record history
    await this.recordHistory(ctx, materialId, 'REGISTERED', ownerOrg, { materialType, metadataHash });

    return material;
  }

  /**
   * Issue a credential for a material
   */
  async issueCredential(
    ctx: PureChainContext,
    materialId: string,
    credentialType: CredentialType,
    commitmentHash: string,
    validUntil: string,
    artifactRefs: ArtifactRef[],
    issuerSig: string
  ): Promise<Credential> {
    // Verify material exists
    const material = await this.getMaterial(ctx, materialId);
    if (!material) {
      throw new Error(`Material ${materialId} not found`);
    }

    // Verify material is not revoked
    if (material.status === MaterialStatus.REVOKED) {
      throw new Error(`Cannot issue credential for revoked material ${materialId}`);
    }

    const credentialId = `cred:${uuidv4()}`;
    const issuerId = ctx.clientIdentity.getMSPID();
    const timestamp = ctx.stub.getTxTimestamp().toISOString();

    const credential: Credential = {
      materialId,
      credentialId,
      credentialType,
      commitmentHash,
      issuerId,
      issuedAt: timestamp,
      validUntil,
      artifactRefs,
      signatureRef: issuerSig,
      revoked: false
    };

    // Store credential
    await this.putState(ctx, `${PREFIX.CREDENTIAL}:${credentialId}`, credential);
    
    // Create composite key for material-credential lookup
    const matCredKey = ctx.stub.createCompositeKey(PREFIX.MATERIAL_CRED, [materialId, credentialId]);
    await ctx.stub.putState(matCredKey, Buffer.from(credentialId));

    // Record history
    await this.recordHistory(ctx, materialId, 'CREDENTIAL_ISSUED', issuerId, {
      credentialId,
      credentialType,
      validUntil
    });

    return credential;
  }

  /**
   * Transfer material ownership
   */
  async transferMaterial(
    ctx: PureChainContext,
    materialId: string,
    toOrg: string,
    shipmentHash: string
  ): Promise<TransferEvent> {
    const material = await this.getMaterial(ctx, materialId);
    if (!material) {
      throw new Error(`Material ${materialId} not found`);
    }

    const fromOrg = ctx.clientIdentity.getMSPID();
    
    // Verify caller is current owner
    if (material.ownerOrg !== fromOrg) {
      throw new Error(`Only current owner ${material.ownerOrg} can transfer material`);
    }

    // Verify material is active
    if (material.status !== MaterialStatus.ACTIVE) {
      throw new Error(`Cannot transfer material with status ${material.status}`);
    }

    const transferId = `xfer:${uuidv4()}`;
    const timestamp = ctx.stub.getTxTimestamp().toISOString();

    const transfer: TransferEvent = {
      transferId,
      materialId,
      from: fromOrg,
      to: toOrg,
      shipmentHash,
      timestamp,
      accepted: false
    };

    // Store transfer event
    await this.putState(ctx, `${PREFIX.TRANSFER}:${transferId}`, transfer);

    // Update material owner (pending acceptance)
    material.ownerOrg = toOrg;
    material.updatedAt = timestamp;
    await this.putState(ctx, `${PREFIX.MATERIAL}:${materialId}`, material);

    // Update org composite keys
    const oldOrgKey = ctx.stub.createCompositeKey(PREFIX.ORG_MATERIAL, [fromOrg, materialId]);
    await ctx.stub.deleteState(oldOrgKey);
    const newOrgKey = ctx.stub.createCompositeKey(PREFIX.ORG_MATERIAL, [toOrg, materialId]);
    await ctx.stub.putState(newOrgKey, Buffer.from(materialId));

    // Record history
    await this.recordHistory(ctx, materialId, 'TRANSFERRED', fromOrg, {
      transferId,
      from: fromOrg,
      to: toOrg,
      shipmentHash
    });

    return transfer;
  }

  /**
   * Accept a transfer (by receiving org)
   */
  async acceptTransfer(ctx: PureChainContext, transferId: string): Promise<TransferEvent> {
    const transfer = await this.getState<TransferEvent>(ctx, `${PREFIX.TRANSFER}:${transferId}`);
    if (!transfer) {
      throw new Error(`Transfer ${transferId} not found`);
    }

    const callerOrg = ctx.clientIdentity.getMSPID();
    if (transfer.to !== callerOrg) {
      throw new Error(`Only receiving org ${transfer.to} can accept transfer`);
    }

    if (transfer.accepted) {
      throw new Error(`Transfer ${transferId} already accepted`);
    }

    transfer.accepted = true;
    transfer.acceptedAt = ctx.stub.getTxTimestamp().toISOString();
    await this.putState(ctx, `${PREFIX.TRANSFER}:${transferId}`, transfer);

    return transfer;
  }

  /**
   * Set material status (QUARANTINE/REVOKE)
   */
  async setStatus(
    ctx: PureChainContext,
    materialId: string,
    status: MaterialStatus,
    reasonHash: string
  ): Promise<Material> {
    const material = await this.getMaterial(ctx, materialId);
    if (!material) {
      throw new Error(`Material ${materialId} not found`);
    }

    const callerOrg = ctx.clientIdentity.getMSPID();
    const timestamp = ctx.stub.getTxTimestamp().toISOString();

    // Only owner or authorized QC org can change status
    // In production, add ACL check here

    material.status = status;
    material.updatedAt = timestamp;
    await this.putState(ctx, `${PREFIX.MATERIAL}:${materialId}`, material);

    // Record history
    await this.recordHistory(ctx, materialId, 'STATUS_CHANGED', callerOrg, {
      newStatus: status,
      reasonHash
    });

    return material;
  }

  /**
   * Revoke a credential
   */
  async revokeCredential(
    ctx: PureChainContext,
    credentialId: string,
    reason: string
  ): Promise<Credential> {
    const credential = await this.getState<Credential>(ctx, `${PREFIX.CREDENTIAL}:${credentialId}`);
    if (!credential) {
      throw new Error(`Credential ${credentialId} not found`);
    }

    const callerOrg = ctx.clientIdentity.getMSPID();
    
    // Only issuer can revoke
    if (credential.issuerId !== callerOrg) {
      throw new Error(`Only issuer ${credential.issuerId} can revoke credential`);
    }

    credential.revoked = true;
    credential.revokedAt = ctx.stub.getTxTimestamp().toISOString();
    credential.revokedReason = reason;
    await this.putState(ctx, `${PREFIX.CREDENTIAL}:${credentialId}`, credential);

    // Record history
    await this.recordHistory(ctx, credential.materialId, 'CREDENTIAL_REVOKED', callerOrg, {
      credentialId,
      credentialType: credential.credentialType,
      reason
    });

    return credential;
  }

  /**
   * Verify material against policy rules
   */
  async verifyMaterial(
    ctx: PureChainContext,
    materialId: string,
    atTime?: string
  ): Promise<VerificationResult> {
    const verifyTime = atTime ? new Date(atTime) : ctx.stub.getTxTimestamp();
    const reasons: VerificationReason[] = [];
    const credentialStatus: CredentialStatus[] = [];
    let pass = true;

    // Get material
    const material = await this.getMaterial(ctx, materialId);
    if (!material) {
      return {
        pass: false,
        materialId,
        verifiedAt: verifyTime.toISOString(),
        reasons: [{ code: 'MATERIAL_NOT_FOUND', message: `Material ${materialId} not found`, severity: 'ERROR' }],
        credentialStatus: [],
        transferChainValid: false
      };
    }

    // Check status
    if (material.status === MaterialStatus.REVOKED) {
      pass = false;
      reasons.push({ code: 'MATERIAL_REVOKED', message: 'Material has been revoked', severity: 'ERROR' });
    } else if (material.status === MaterialStatus.QUARANTINED) {
      pass = false;
      reasons.push({ code: 'MATERIAL_QUARANTINED', message: 'Material is quarantined', severity: 'ERROR' });
    } else if (material.status === MaterialStatus.EXPIRED) {
      pass = false;
      reasons.push({ code: 'MATERIAL_EXPIRED', message: 'Material has expired', severity: 'ERROR' });
    }

    // Get policy for material type
    const policy = await this.getPolicyForMaterialType(ctx, material.materialType);
    if (!policy) {
      reasons.push({ code: 'NO_POLICY', message: `No policy defined for material type ${material.materialType}`, severity: 'WARNING' });
    }

    // Get all credentials for material
    const credentials = await this.getCredentialsForMaterial(ctx, materialId);
    
    // Check required credentials
    if (policy) {
      for (const requiredType of policy.requiredCredentials) {
        const matchingCreds = credentials.filter(c => c.credentialType === requiredType && !c.revoked);
        
        if (matchingCreds.length === 0) {
          pass = false;
          credentialStatus.push({
            credentialType: requiredType,
            present: false,
            valid: false
          });
          reasons.push({
            code: 'MISSING_CREDENTIAL',
            message: `Missing required credential: ${requiredType}`,
            severity: 'ERROR'
          });
        } else {
          // Check if any valid (not expired) credential exists
          const validCred = matchingCreds.find(c => new Date(c.validUntil) > verifyTime);
          
          if (validCred) {
            credentialStatus.push({
              credentialType: requiredType,
              present: true,
              valid: true,
              issuerId: validCred.issuerId
            });
          } else {
            pass = false;
            const mostRecent = matchingCreds.sort((a, b) => 
              new Date(b.validUntil).getTime() - new Date(a.validUntil).getTime()
            )[0];
            credentialStatus.push({
              credentialType: requiredType,
              present: true,
              valid: false,
              expiredAt: mostRecent.validUntil,
              issuerId: mostRecent.issuerId
            });
            reasons.push({
              code: 'CREDENTIAL_EXPIRED',
              message: `Credential ${requiredType} expired at ${mostRecent.validUntil}`,
              severity: 'ERROR'
            });
          }
        }
      }
    }

    // Check transfer chain continuity
    const transferChainValid = await this.verifyTransferChain(ctx, materialId);
    if (policy?.requireContinuousTransferChain && !transferChainValid) {
      pass = false;
      reasons.push({
        code: 'BROKEN_TRANSFER_CHAIN',
        message: 'Transfer chain has gaps or unaccepted transfers',
        severity: 'ERROR'
      });
    }

    return {
      pass,
      materialId,
      verifiedAt: verifyTime.toISOString(),
      reasons,
      credentialStatus,
      transferChainValid
    };
  }

  /**
   * Get material history for audit
   */
  async getHistory(ctx: PureChainContext, materialId: string): Promise<MaterialHistory> {
    const historyKey = `${PREFIX.HISTORY}:${materialId}`;
    const history = await this.getState<HistoryEvent[]>(ctx, historyKey);
    
    return {
      materialId,
      events: history || []
    };
  }

  /**
   * Get material by ID
   */
  async getMaterial(ctx: PureChainContext, materialId: string): Promise<Material | null> {
    return this.getState<Material>(ctx, `${PREFIX.MATERIAL}:${materialId}`);
  }

  /**
   * Get credential by ID
   */
  async getCredential(ctx: PureChainContext, credentialId: string): Promise<Credential | null> {
    return this.getState<Credential>(ctx, `${PREFIX.CREDENTIAL}:${credentialId}`);
  }

  /**
   * Get all materials for an organization
   */
  async getMaterialsByOrg(ctx: PureChainContext, orgId: string): Promise<Material[]> {
    const materials: Material[] = [];
    const iterator = await ctx.stub.getStateByPartialCompositeKey(PREFIX.ORG_MATERIAL, [orgId]);
    
    let result = await iterator.next();
    while (!result.done) {
      if (result.value) {
        const materialId = Buffer.from(result.value.value).toString();
        const material = await this.getMaterial(ctx, materialId);
        if (material) {
          materials.push(material);
        }
      }
      result = await iterator.next();
    }
    await iterator.close();
    
    return materials;
  }

  /**
   * Get all credentials for a material
   */
  async getCredentialsForMaterial(ctx: PureChainContext, materialId: string): Promise<Credential[]> {
    const credentials: Credential[] = [];
    const iterator = await ctx.stub.getStateByPartialCompositeKey(PREFIX.MATERIAL_CRED, [materialId]);
    
    let result = await iterator.next();
    while (!result.done) {
      if (result.value) {
        const credentialId = Buffer.from(result.value.value).toString();
        const credential = await this.getState<Credential>(ctx, `${PREFIX.CREDENTIAL}:${credentialId}`);
        if (credential) {
          credentials.push(credential);
        }
      }
      result = await iterator.next();
    }
    await iterator.close();
    
    return credentials;
  }

  /**
   * Update or create a policy rule
   */
  async setPolicy(ctx: PureChainContext, policy: PolicyRule): Promise<PolicyRule> {
    await this.putState(ctx, `${PREFIX.POLICY}:${policy.policyId}`, policy);
    return policy;
  }

  // ==================== Private Helper Methods ====================

  private async getState<T>(ctx: PureChainContext, key: string): Promise<T | null> {
    const data = await ctx.stub.getState(key);
    if (!data || data.length === 0) {
      return null;
    }
    return JSON.parse(Buffer.from(data).toString()) as T;
  }

  private async putState<T>(ctx: PureChainContext, key: string, value: T): Promise<void> {
    await ctx.stub.putState(key, Buffer.from(JSON.stringify(value)));
  }

  private async recordHistory(
    ctx: PureChainContext,
    materialId: string,
    eventType: HistoryEvent['eventType'],
    actor: string,
    details: Record<string, unknown>
  ): Promise<void> {
    const historyKey = `${PREFIX.HISTORY}:${materialId}`;
    const history = await this.getState<HistoryEvent[]>(ctx, historyKey) || [];
    
    history.push({
      eventType,
      timestamp: ctx.stub.getTxTimestamp().toISOString(),
      actor,
      details,
      txId: ctx.stub.getTxID()
    });
    
    await this.putState(ctx, historyKey, history);
  }

  private async getPolicyForMaterialType(
    ctx: PureChainContext,
    materialType: MaterialType
  ): Promise<PolicyRule | null> {
    // Look for default policy for this material type
    const policyId = `default-${materialType.toLowerCase().replace('_', '-')}`;
    return this.getState<PolicyRule>(ctx, `${PREFIX.POLICY}:${policyId}`);
  }

  private async verifyTransferChain(ctx: PureChainContext, materialId: string): Promise<boolean> {
    // Get all transfers for this material
    const transfers: TransferEvent[] = [];
    const iterator = await ctx.stub.getStateByRange(
      `${PREFIX.TRANSFER}:`,
      `${PREFIX.TRANSFER}:\uffff`
    );
    
    let result = await iterator.next();
    while (!result.done) {
      if (result.value) {
        const transfer = JSON.parse(Buffer.from(result.value.value).toString()) as TransferEvent;
        if (transfer.materialId === materialId) {
          transfers.push(transfer);
        }
      }
      result = await iterator.next();
    }
    await iterator.close();

    // If no transfers, chain is valid
    if (transfers.length === 0) {
      return true;
    }

    // Sort by timestamp
    transfers.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    // Check all transfers are accepted
    for (const transfer of transfers) {
      if (!transfer.accepted) {
        return false;
      }
    }

    // Check chain continuity (each 'to' should match next 'from')
    for (let i = 0; i < transfers.length - 1; i++) {
      if (transfers[i].to !== transfers[i + 1].from) {
        return false;
      }
    }

    return true;
  }
}

export default BioPassportRegistry;
