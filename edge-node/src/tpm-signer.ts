import { spawn } from 'node:child_process';
import { ethers } from 'ethers';
import { Signer } from './types.js';

/**
 * TPM 2.0 signer using tpm2-tools (tpm2_sign) under the hood.
 * The MVP keeps PEM public-key extraction as a TODO; software signing is the
 * first green path and TPM parsing is a follow-up hardening step.
 */
export class TpmSigner implements Signer {
  private cachedAddress?: string;
  private deviceIdHex: string;

  constructor(private persistentHandle: string, deviceIdRaw: string) {
    this.deviceIdHex = ethers.keccak256(ethers.toUtf8Bytes(deviceIdRaw));
  }

  async getDeviceId(): Promise<string> {
    return this.deviceIdHex;
  }

  async getDeviceAddress(): Promise<string> {
    if (this.cachedAddress) return this.cachedAddress;
    const pub = await this.runTpm2(['readpublic', '-c', this.persistentHandle, '-f', 'pem']);
    const pk = this.extractUncompressedPubKey(pub);
    this.cachedAddress = ethers.computeAddress('0x04' + pk);
    return this.cachedAddress;
  }

  async signDigest(digest: Uint8Array): Promise<string> {
    const hexDigest = Buffer.from(digest).toString('hex');
    const derSig = await this.runTpm2Bin(['sign', '-c', this.persistentHandle, '-g', 'sha256', '-f', 'plain'], digest);
    const { r, s } = this.parseDer(derSig);

    for (const v of [27, 28]) {
      const sig = ethers.concat([r, s, Uint8Array.from([v])]);
      const recovered = ethers.recoverAddress('0x' + hexDigest, ethers.hexlify(sig));
      if (recovered.toLowerCase() === (await this.getDeviceAddress()).toLowerCase()) {
        return ethers.hexlify(sig);
      }
    }
    throw new Error('TpmSigner: could not determine recovery id');
  }

  private runTpm2(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const p = spawn('tpm2', args);
      let out = '';
      p.stdout.on('data', (d) => (out += d.toString()));
      p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`tpm2 ${args.join(' ')} exit ${code}`))));
    });
  }

  private runTpm2Bin(args: string[], input: Uint8Array): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const p = spawn('tpm2', args);
      const chunks: Buffer[] = [];
      p.stdout.on('data', (d) => chunks.push(d));
      p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`tpm2 ${args.join(' ')} exit ${code}`))));
      p.stdin.write(input);
      p.stdin.end();
    });
  }

  private extractUncompressedPubKey(_pem: string): string {
    throw new Error('extractUncompressedPubKey: implement with node-forge or similar');
  }

  private parseDer(der: Buffer): { r: Uint8Array; s: Uint8Array } {
    let idx = 0;
    if (der[idx++] !== 0x30) throw new Error('DER: bad seq');
    idx++;
    if (der[idx++] !== 0x02) throw new Error('DER: bad r tag');
    const rLen = der[idx++];
    let r = der.slice(idx, idx + rLen);
    idx += rLen;
    if (der[idx++] !== 0x02) throw new Error('DER: bad s tag');
    const sLen = der[idx++];
    let s = der.slice(idx, idx + sLen);
    const norm = (b: Buffer) => {
      if (b.length === 32) return b;
      if (b.length === 33 && b[0] === 0) return b.slice(1);
      if (b.length > 32) throw new Error('DER: integer too large');
      return Buffer.concat([Buffer.alloc(32 - b.length, 0), b]);
    };
    return { r: norm(r), s: norm(s) };
  }
}
