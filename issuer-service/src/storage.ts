/**
 * Off-chain artifact storage service (S3/MinIO compatible)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as Minio from 'minio';
import { ArtifactUploadResult } from './types';
import { sha256File } from './crypto';

export interface StorageConfig {
  endpoint: string;
  port: number;
  useSSL: boolean;
  accessKey: string;
  secretKey: string;
  bucket: string;
}

export class ArtifactStorage {
  private client: Minio.Client;
  private bucket: string;

  constructor(config: StorageConfig) {
    this.client = new Minio.Client({
      endPoint: config.endpoint,
      port: config.port,
      useSSL: config.useSSL,
      accessKey: config.accessKey,
      secretKey: config.secretKey
    });
    this.bucket = config.bucket;
  }

  /**
   * Initialize storage (create bucket if not exists)
   */
  async init(): Promise<void> {
    const exists = await this.client.bucketExists(this.bucket);
    if (!exists) {
      await this.client.makeBucket(this.bucket);
    }
  }

  /**
   * Upload an artifact file
   */
  async uploadArtifact(
    filePath: string,
    materialId: string,
    credentialType: string
  ): Promise<ArtifactUploadResult> {
    const filename = path.basename(filePath);
    const fileHash = await sha256File(filePath);
    const stats = fs.statSync(filePath);
    const contentType = this.getContentType(filename);

    // Generate storage key: materialId/credentialType/hash-filename
    const objectKey = `${materialId}/${credentialType}/${fileHash.substring(0, 8)}-${filename}`;

    // Upload file
    await this.client.fPutObject(this.bucket, objectKey, filePath, {
      'Content-Type': contentType,
      'x-amz-meta-hash': fileHash,
      'x-amz-meta-material-id': materialId,
      'x-amz-meta-credential-type': credentialType
    });

    // Generate CID (content-addressed identifier)
    const cid = `s3://${this.bucket}/${objectKey}`;

    return {
      cid,
      hash: fileHash,
      filename,
      contentType,
      size: stats.size
    };
  }

  /**
   * Upload artifact from buffer
   */
  async uploadArtifactBuffer(
    buffer: Buffer,
    filename: string,
    materialId: string,
    credentialType: string
  ): Promise<ArtifactUploadResult> {
    const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');
    const contentType = this.getContentType(filename);

    const objectKey = `${materialId}/${credentialType}/${fileHash.substring(0, 8)}-${filename}`;

    await this.client.putObject(this.bucket, objectKey, buffer, buffer.length, {
      'Content-Type': contentType,
      'x-amz-meta-hash': fileHash,
      'x-amz-meta-material-id': materialId,
      'x-amz-meta-credential-type': credentialType
    });

    const cid = `s3://${this.bucket}/${objectKey}`;

    return {
      cid,
      hash: fileHash,
      filename,
      contentType,
      size: buffer.length
    };
  }

  /**
   * Download artifact and verify hash
   */
  async downloadAndVerify(cid: string, expectedHash: string): Promise<Buffer> {
    const objectKey = this.cidToObjectKey(cid);
    
    const chunks: Buffer[] = [];
    const stream = await this.client.getObject(this.bucket, objectKey);
    
    return new Promise((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const actualHash = crypto.createHash('sha256').update(buffer).digest('hex');
        
        if (actualHash !== expectedHash) {
          reject(new Error(`Hash mismatch: expected ${expectedHash}, got ${actualHash}`));
        } else {
          resolve(buffer);
        }
      });
      stream.on('error', reject);
    });
  }

  /**
   * Check if artifact exists and hash matches
   */
  async verifyArtifact(cid: string, expectedHash: string): Promise<boolean> {
    try {
      const objectKey = this.cidToObjectKey(cid);
      const stat = await this.client.statObject(this.bucket, objectKey);
      const storedHash = stat.metaData?.['x-amz-meta-hash'] || stat.metaData?.['hash'];
      return storedHash === expectedHash;
    } catch {
      return false;
    }
  }

  /**
   * Get presigned URL for artifact download
   */
  async getPresignedUrl(cid: string, expirySeconds: number = 3600): Promise<string> {
    const objectKey = this.cidToObjectKey(cid);
    return this.client.presignedGetObject(this.bucket, objectKey, expirySeconds);
  }

  /**
   * Delete artifact
   */
  async deleteArtifact(cid: string): Promise<void> {
    const objectKey = this.cidToObjectKey(cid);
    await this.client.removeObject(this.bucket, objectKey);
  }

  private cidToObjectKey(cid: string): string {
    // Parse s3://bucket/key format
    const match = cid.match(/^s3:\/\/[^/]+\/(.+)$/);
    if (match) {
      return match[1];
    }
    // Assume it's already an object key
    return cid;
  }

  private getContentType(filename: string): string {
    const ext = path.extname(filename).toLowerCase();
    const types: Record<string, string> = {
      '.pdf': 'application/pdf',
      '.json': 'application/json',
      '.txt': 'text/plain',
      '.csv': 'text/csv',
      '.xml': 'application/xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.zip': 'application/zip',
      '.gz': 'application/gzip',
      '.fasta': 'text/plain',
      '.fa': 'text/plain',
      '.fastq': 'text/plain',
      '.fq': 'text/plain',
      '.gb': 'text/plain',
      '.gbk': 'text/plain'
    };
    return types[ext] || 'application/octet-stream';
  }
}

/**
 * Create storage instance from environment or config
 */
export function createStorage(config?: Partial<StorageConfig>): ArtifactStorage {
  const fullConfig: StorageConfig = {
    endpoint: config?.endpoint || process.env.STORAGE_ENDPOINT || 'localhost',
    port: config?.port || parseInt(process.env.STORAGE_PORT || '9000'),
    useSSL: config?.useSSL ?? (process.env.STORAGE_USE_SSL === 'true'),
    accessKey: config?.accessKey || process.env.STORAGE_ACCESS_KEY || 'minioadmin',
    secretKey: config?.secretKey || process.env.STORAGE_SECRET_KEY || 'minioadmin',
    bucket: config?.bucket || process.env.STORAGE_BUCKET || 'biopassport'
  };
  return new ArtifactStorage(fullConfig);
}
