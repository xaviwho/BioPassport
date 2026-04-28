import { ethers } from 'ethers';
import fs from 'node:fs';
import { Signer } from './types.js';

/**
 * Software-only signer: reads a private key from disk (development/testing).
 * DO NOT USE IN PRODUCTION. Real deployments use TpmSigner or SeSigner.
 */
export class SoftwareSigner implements Signer {
  private wallet: ethers.Wallet;
  private deviceIdHex: string;

  constructor(privateKeyHex: string, deviceIdRaw: string) {
    this.wallet = new ethers.Wallet(privateKeyHex);
    this.deviceIdHex = ethers.keccak256(ethers.toUtf8Bytes(deviceIdRaw));
  }

  static fromFile(keyPath: string, deviceIdRaw: string): SoftwareSigner {
    const key = fs.readFileSync(keyPath, 'utf-8').trim();
    return new SoftwareSigner(key, deviceIdRaw);
  }

  async getDeviceId(): Promise<string> {
    return this.deviceIdHex;
  }

  async getDeviceAddress(): Promise<string> {
    return this.wallet.address;
  }

  async signDigest(digest: Uint8Array): Promise<string> {
    const sig = this.wallet.signingKey.sign(digest);
    return sig.serialized;
  }
}
