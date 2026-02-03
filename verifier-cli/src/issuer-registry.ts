/**
 * Issuer Registry - Manages public keys for credential issuers
 *
 * This registry provides a mapping between issuer IDs and their public keys,
 * which are used to verify credential signatures.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface IssuerPublicKey {
  issuerId: string;
  publicKey: string;  // Hex-encoded public key
  addedAt: string;
  description?: string;
}

export interface IssuerRegistryConfig {
  issuers: Record<string, IssuerPublicKey>;
}

export class IssuerRegistry {
  private issuers: Map<string, IssuerPublicKey> = new Map();
  private configPath?: string;

  constructor(configPath?: string) {
    this.configPath = configPath;
    if (configPath) {
      this.loadFromFile(configPath);
    }
  }

  /**
   * Load issuer public keys from JSON file
   */
  private loadFromFile(filePath: string): void {
    try {
      if (!fs.existsSync(filePath)) {
        console.warn(`Issuer registry file not found: ${filePath}`);
        return;
      }

      const content = fs.readFileSync(filePath, 'utf-8');
      const config: IssuerRegistryConfig = JSON.parse(content);

      if (!config.issuers || typeof config.issuers !== 'object') {
        throw new Error('Invalid issuer registry format: missing "issuers" object');
      }

      for (const [issuerId, issuerData] of Object.entries(config.issuers)) {
        if (!issuerData.publicKey) {
          console.warn(`Skipping issuer ${issuerId}: missing publicKey`);
          continue;
        }

        this.issuers.set(issuerId, {
          issuerId,
          publicKey: issuerData.publicKey,
          addedAt: issuerData.addedAt || new Date().toISOString(),
          description: issuerData.description,
        });
      }

      console.log(`Loaded ${this.issuers.size} issuer public keys from ${filePath}`);
    } catch (error: any) {
      throw new Error(`Failed to load issuer registry: ${error.message}`);
    }
  }

  /**
   * Get public key for an issuer
   * @returns Public key in hex format, or null if issuer not found
   */
  async getPublicKey(issuerId: string): Promise<string | null> {
    const issuer = this.issuers.get(issuerId);
    if (!issuer) {
      return null;
    }
    return issuer.publicKey;
  }

  /**
   * Add or update an issuer's public key
   */
  addIssuer(issuerId: string, publicKey: string, description?: string): void {
    this.issuers.set(issuerId, {
      issuerId,
      publicKey,
      addedAt: new Date().toISOString(),
      description,
    });
  }

  /**
   * Remove an issuer from the registry
   */
  removeIssuer(issuerId: string): boolean {
    return this.issuers.delete(issuerId);
  }

  /**
   * Check if an issuer exists in the registry
   */
  hasIssuer(issuerId: string): boolean {
    return this.issuers.has(issuerId);
  }

  /**
   * Get all registered issuers
   */
  getAllIssuers(): IssuerPublicKey[] {
    return Array.from(this.issuers.values());
  }

  /**
   * Save the registry to file
   */
  saveToFile(filePath?: string): void {
    const targetPath = filePath || this.configPath;
    if (!targetPath) {
      throw new Error('No file path specified for saving registry');
    }

    const config: IssuerRegistryConfig = {
      issuers: {},
    };

    for (const issuer of this.issuers.values()) {
      config.issuers[issuer.issuerId] = issuer;
    }

    fs.writeFileSync(targetPath, JSON.stringify(config, null, 2), 'utf-8');
    console.log(`Saved issuer registry to ${targetPath}`);
  }

  /**
   * Create an example registry file
   */
  static createExampleRegistry(filePath: string): void {
    const exampleConfig: IssuerRegistryConfig = {
      issuers: {
        'Org1MSP': {
          issuerId: 'Org1MSP',
          publicKey: '04a1b2c3d4e5f6...', // Replace with actual public key
          addedAt: new Date().toISOString(),
          description: 'Research Laboratory A',
        },
        'QCLab': {
          issuerId: 'QCLab',
          publicKey: '04d4e5f6a7b8c9...', // Replace with actual public key
          addedAt: new Date().toISOString(),
          description: 'Quality Control Laboratory',
        },
      },
    };

    fs.writeFileSync(filePath, JSON.stringify(exampleConfig, null, 2), 'utf-8');
    console.log(`Created example issuer registry at ${filePath}`);
    console.log('⚠️  WARNING: Replace example public keys with real keys before use!');
  }
}

/**
 * Create issuer registry from environment or config
 */
export function createIssuerRegistry(configPath?: string): IssuerRegistry {
  const registryPath = configPath ||
    process.env.ISSUER_REGISTRY_PATH ||
    path.resolve(process.cwd(), 'issuer-registry.json');

  return new IssuerRegistry(registryPath);
}
