/**
 * Error Handling Hierarchy for BioPassport
 *
 * Benefits:
 * - Consistent error responses across services
 * - Error classification for retry logic
 * - Integration with logging and monitoring
 * - Type-safe error handling
 */

import { Request, Response, NextFunction } from 'express';
import { CorrelatedLogger } from './logger';

/**
 * Error codes for categorization
 */
export enum ErrorCode {
  // Validation Errors (4xx - non-retriable)
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  INVALID_INPUT = 'INVALID_INPUT',
  MISSING_REQUIRED_FIELD = 'MISSING_REQUIRED_FIELD',
  INVALID_FORMAT = 'INVALID_FORMAT',
  RESOURCE_NOT_FOUND = 'RESOURCE_NOT_FOUND',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  CONFLICT = 'CONFLICT',

  // Blockchain Errors (retriable)
  BLOCKCHAIN_ERROR = 'BLOCKCHAIN_ERROR',
  TRANSACTION_FAILED = 'TRANSACTION_FAILED',
  CONTRACT_ERROR = 'CONTRACT_ERROR',
  NONCE_ERROR = 'NONCE_ERROR',
  GAS_ESTIMATION_FAILED = 'GAS_ESTIMATION_FAILED',
  NETWORK_ERROR = 'NETWORK_ERROR',

  // Storage Errors (retriable)
  STORAGE_ERROR = 'STORAGE_ERROR',
  UPLOAD_FAILED = 'UPLOAD_FAILED',
  DOWNLOAD_FAILED = 'DOWNLOAD_FAILED',
  STORAGE_UNAVAILABLE = 'STORAGE_UNAVAILABLE',

  // Database Errors (retriable)
  DATABASE_ERROR = 'DATABASE_ERROR',
  QUERY_FAILED = 'QUERY_FAILED',
  CONNECTION_ERROR = 'CONNECTION_ERROR',
  DEADLOCK_ERROR = 'DEADLOCK_ERROR',

  // Circuit Breaker Errors
  CIRCUIT_BREAKER_OPEN = 'CIRCUIT_BREAKER_OPEN',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',

  // Cryptographic Errors (non-retriable)
  CRYPTO_ERROR = 'CRYPTO_ERROR',
  SIGNATURE_VERIFICATION_FAILED = 'SIGNATURE_VERIFICATION_FAILED',
  INVALID_KEY = 'INVALID_KEY',
  LOW_ENTROPY_KEY = 'LOW_ENTROPY_KEY',

  // Timeout Errors (retriable)
  TIMEOUT_ERROR = 'TIMEOUT_ERROR',
  OPERATION_TIMEOUT = 'OPERATION_TIMEOUT',

  // Rate Limiting (retriable with backoff)
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',

  // Internal Server Errors (retriable)
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  UNKNOWN_ERROR = 'UNKNOWN_ERROR'
}

/**
 * HTTP status codes for errors
 */
export const ErrorStatusCodes: Record<ErrorCode, number> = {
  // 4xx Client Errors
  [ErrorCode.VALIDATION_ERROR]: 400,
  [ErrorCode.INVALID_INPUT]: 400,
  [ErrorCode.MISSING_REQUIRED_FIELD]: 400,
  [ErrorCode.INVALID_FORMAT]: 400,
  [ErrorCode.RESOURCE_NOT_FOUND]: 404,
  [ErrorCode.UNAUTHORIZED]: 401,
  [ErrorCode.FORBIDDEN]: 403,
  [ErrorCode.CONFLICT]: 409,
  [ErrorCode.SIGNATURE_VERIFICATION_FAILED]: 400,
  [ErrorCode.INVALID_KEY]: 400,
  [ErrorCode.LOW_ENTROPY_KEY]: 400,
  [ErrorCode.CRYPTO_ERROR]: 400,

  // 429 Rate Limiting
  [ErrorCode.RATE_LIMIT_EXCEEDED]: 429,

  // 5xx Server Errors
  [ErrorCode.BLOCKCHAIN_ERROR]: 503,
  [ErrorCode.TRANSACTION_FAILED]: 503,
  [ErrorCode.CONTRACT_ERROR]: 503,
  [ErrorCode.NONCE_ERROR]: 503,
  [ErrorCode.GAS_ESTIMATION_FAILED]: 503,
  [ErrorCode.NETWORK_ERROR]: 503,
  [ErrorCode.STORAGE_ERROR]: 503,
  [ErrorCode.UPLOAD_FAILED]: 503,
  [ErrorCode.DOWNLOAD_FAILED]: 503,
  [ErrorCode.STORAGE_UNAVAILABLE]: 503,
  [ErrorCode.DATABASE_ERROR]: 503,
  [ErrorCode.QUERY_FAILED]: 503,
  [ErrorCode.CONNECTION_ERROR]: 503,
  [ErrorCode.DEADLOCK_ERROR]: 503,
  [ErrorCode.CIRCUIT_BREAKER_OPEN]: 503,
  [ErrorCode.SERVICE_UNAVAILABLE]: 503,
  [ErrorCode.TIMEOUT_ERROR]: 504,
  [ErrorCode.OPERATION_TIMEOUT]: 504,
  [ErrorCode.INTERNAL_ERROR]: 500,
  [ErrorCode.UNKNOWN_ERROR]: 500
};

/**
 * Error retriability classification
 */
export function isRetriableError(code: ErrorCode): boolean {
  const retriableErrors = new Set([
    ErrorCode.BLOCKCHAIN_ERROR,
    ErrorCode.TRANSACTION_FAILED,
    ErrorCode.CONTRACT_ERROR,
    ErrorCode.NONCE_ERROR,
    ErrorCode.GAS_ESTIMATION_FAILED,
    ErrorCode.NETWORK_ERROR,
    ErrorCode.STORAGE_ERROR,
    ErrorCode.UPLOAD_FAILED,
    ErrorCode.DOWNLOAD_FAILED,
    ErrorCode.STORAGE_UNAVAILABLE,
    ErrorCode.DATABASE_ERROR,
    ErrorCode.QUERY_FAILED,
    ErrorCode.CONNECTION_ERROR,
    ErrorCode.DEADLOCK_ERROR,
    ErrorCode.TIMEOUT_ERROR,
    ErrorCode.OPERATION_TIMEOUT,
    ErrorCode.RATE_LIMIT_EXCEEDED,
    ErrorCode.INTERNAL_ERROR
  ]);

  return retriableErrors.has(code);
}

/**
 * Base error class for all BioPassport errors
 */
export class BioPassportError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;
  public readonly retriable: boolean;
  public readonly timestamp: Date;
  public readonly details?: Record<string, any>;
  public readonly correlationId?: string;

  constructor(
    message: string,
    code: ErrorCode = ErrorCode.INTERNAL_ERROR,
    details?: Record<string, any>,
    correlationId?: string
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = ErrorStatusCodes[code];
    this.retriable = isRetriableError(code);
    this.timestamp = new Date();
    this.details = details;
    this.correlationId = correlationId;

    // Maintains proper stack trace for where error was thrown
    Error.captureStackTrace(this, this.constructor);
  }

  /**
   * Convert error to JSON response format
   */
  toJSON() {
    return {
      error: {
        name: this.name,
        message: this.message,
        code: this.code,
        statusCode: this.statusCode,
        retriable: this.retriable,
        timestamp: this.timestamp.toISOString(),
        correlationId: this.correlationId,
        ...(this.details && { details: this.details })
      }
    };
  }

  /**
   * Convert error to log format
   */
  toLogFormat() {
    return {
      errorName: this.name,
      errorMessage: this.message,
      errorCode: this.code,
      statusCode: this.statusCode,
      retriable: this.retriable,
      correlationId: this.correlationId,
      stack: this.stack,
      ...(this.details && { details: this.details })
    };
  }
}

/**
 * Validation errors (non-retriable)
 */
export class ValidationError extends BioPassportError {
  constructor(
    message: string,
    code: ErrorCode = ErrorCode.VALIDATION_ERROR,
    details?: Record<string, any>,
    correlationId?: string
  ) {
    super(message, code, details, correlationId);
  }

  static missingField(fieldName: string, correlationId?: string): ValidationError {
    return new ValidationError(
      `Missing required field: ${fieldName}`,
      ErrorCode.MISSING_REQUIRED_FIELD,
      { field: fieldName },
      correlationId
    );
  }

  static invalidFormat(fieldName: string, expected: string, correlationId?: string): ValidationError {
    return new ValidationError(
      `Invalid format for field '${fieldName}'. Expected: ${expected}`,
      ErrorCode.INVALID_FORMAT,
      { field: fieldName, expected },
      correlationId
    );
  }

  static resourceNotFound(resourceType: string, resourceId: string, correlationId?: string): ValidationError {
    return new ValidationError(
      `${resourceType} not found: ${resourceId}`,
      ErrorCode.RESOURCE_NOT_FOUND,
      { resourceType, resourceId },
      correlationId
    );
  }
}

/**
 * Blockchain errors (retriable)
 */
export class BlockchainError extends BioPassportError {
  constructor(
    message: string,
    code: ErrorCode = ErrorCode.BLOCKCHAIN_ERROR,
    details?: Record<string, any>,
    correlationId?: string
  ) {
    super(message, code, details, correlationId);
  }

  static transactionFailed(txHash: string, reason: string, correlationId?: string): BlockchainError {
    return new BlockchainError(
      `Transaction failed: ${reason}`,
      ErrorCode.TRANSACTION_FAILED,
      { txHash, reason },
      correlationId
    );
  }

  static contractError(method: string, reason: string, correlationId?: string): BlockchainError {
    return new BlockchainError(
      `Contract method '${method}' failed: ${reason}`,
      ErrorCode.CONTRACT_ERROR,
      { method, reason },
      correlationId
    );
  }

  static nonceError(nonce: number, reason: string, correlationId?: string): BlockchainError {
    return new BlockchainError(
      `Nonce error (nonce ${nonce}): ${reason}`,
      ErrorCode.NONCE_ERROR,
      { nonce, reason },
      correlationId
    );
  }

  static networkError(reason: string, correlationId?: string): BlockchainError {
    return new BlockchainError(
      `Blockchain network error: ${reason}`,
      ErrorCode.NETWORK_ERROR,
      { reason },
      correlationId
    );
  }
}

/**
 * Storage errors (retriable)
 */
export class StorageError extends BioPassportError {
  constructor(
    message: string,
    code: ErrorCode = ErrorCode.STORAGE_ERROR,
    details?: Record<string, any>,
    correlationId?: string
  ) {
    super(message, code, details, correlationId);
  }

  static uploadFailed(fileName: string, reason: string, correlationId?: string): StorageError {
    return new StorageError(
      `Upload failed for '${fileName}': ${reason}`,
      ErrorCode.UPLOAD_FAILED,
      { fileName, reason },
      correlationId
    );
  }

  static downloadFailed(cid: string, reason: string, correlationId?: string): StorageError {
    return new StorageError(
      `Download failed for CID '${cid}': ${reason}`,
      ErrorCode.DOWNLOAD_FAILED,
      { cid, reason },
      correlationId
    );
  }

  static storageUnavailable(reason: string, correlationId?: string): StorageError {
    return new StorageError(
      `Storage service unavailable: ${reason}`,
      ErrorCode.STORAGE_UNAVAILABLE,
      { reason },
      correlationId
    );
  }
}

/**
 * Database errors (retriable)
 */
export class DatabaseError extends BioPassportError {
  constructor(
    message: string,
    code: ErrorCode = ErrorCode.DATABASE_ERROR,
    details?: Record<string, any>,
    correlationId?: string
  ) {
    super(message, code, details, correlationId);
  }

  static queryFailed(query: string, reason: string, correlationId?: string): DatabaseError {
    return new DatabaseError(
      `Database query failed: ${reason}`,
      ErrorCode.QUERY_FAILED,
      { query: query.substring(0, 100), reason },
      correlationId
    );
  }

  static connectionError(reason: string, correlationId?: string): DatabaseError {
    return new DatabaseError(
      `Database connection error: ${reason}`,
      ErrorCode.CONNECTION_ERROR,
      { reason },
      correlationId
    );
  }

  static deadlock(query: string, correlationId?: string): DatabaseError {
    return new DatabaseError(
      `Database deadlock detected`,
      ErrorCode.DEADLOCK_ERROR,
      { query: query.substring(0, 100) },
      correlationId
    );
  }
}

/**
 * Circuit breaker errors
 */
export class CircuitBreakerOpenError extends BioPassportError {
  constructor(
    circuitName: string,
    details?: Record<string, any>,
    correlationId?: string
  ) {
    super(
      `Circuit breaker open: ${circuitName}`,
      ErrorCode.CIRCUIT_BREAKER_OPEN,
      { circuitName, ...details },
      correlationId
    );
  }
}

/**
 * Cryptographic errors (non-retriable)
 */
export class CryptoError extends BioPassportError {
  constructor(
    message: string,
    code: ErrorCode = ErrorCode.CRYPTO_ERROR,
    details?: Record<string, any>,
    correlationId?: string
  ) {
    super(message, code, details, correlationId);
  }

  static signatureVerificationFailed(credentialId: string, correlationId?: string): CryptoError {
    return new CryptoError(
      `Signature verification failed for credential: ${credentialId}`,
      ErrorCode.SIGNATURE_VERIFICATION_FAILED,
      { credentialId },
      correlationId
    );
  }

  static invalidKey(keyType: string, reason: string, correlationId?: string): CryptoError {
    return new CryptoError(
      `Invalid ${keyType} key: ${reason}`,
      ErrorCode.INVALID_KEY,
      { keyType, reason },
      correlationId
    );
  }

  static lowEntropyKey(entropy: number, minimum: number, correlationId?: string): CryptoError {
    return new CryptoError(
      `Private key has low entropy: ${entropy.toFixed(2)} (minimum: ${minimum})`,
      ErrorCode.LOW_ENTROPY_KEY,
      { entropy, minimum },
      correlationId
    );
  }
}

/**
 * Timeout errors (retriable)
 */
export class TimeoutError extends BioPassportError {
  constructor(
    operation: string,
    timeoutMs: number,
    details?: Record<string, any>,
    correlationId?: string
  ) {
    super(
      `Operation timed out after ${timeoutMs}ms: ${operation}`,
      ErrorCode.OPERATION_TIMEOUT,
      { operation, timeoutMs, ...details },
      correlationId
    );
  }
}

/**
 * Rate limiting errors (retriable with backoff)
 */
export class RateLimitError extends BioPassportError {
  constructor(
    retryAfterSeconds?: number,
    details?: Record<string, any>,
    correlationId?: string
  ) {
    super(
      `Rate limit exceeded${retryAfterSeconds ? `, retry after ${retryAfterSeconds}s` : ''}`,
      ErrorCode.RATE_LIMIT_EXCEEDED,
      { retryAfterSeconds, ...details },
      correlationId
    );
  }
}

/**
 * Convert unknown error to BioPassportError
 */
export function toBioPassportError(error: any, correlationId?: string): BioPassportError {
  // Already a BioPassportError
  if (error instanceof BioPassportError) {
    return error;
  }

  // Extract message
  const message = error.message || String(error);

  // Detect error type from error properties
  if (error.code) {
    // Blockchain/network errors
    if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'].includes(error.code)) {
      return new BlockchainError(message, ErrorCode.NETWORK_ERROR, { originalCode: error.code }, correlationId);
    }

    // Nonce errors
    if (['NONCE_EXPIRED', 'REPLACEMENT_UNDERPRICED'].includes(error.code)) {
      return new BlockchainError(message, ErrorCode.NONCE_ERROR, { originalCode: error.code }, correlationId);
    }

    // PostgreSQL error codes
    if (error.code === '40P01') {
      return new DatabaseError(message, ErrorCode.DEADLOCK_ERROR, undefined, correlationId);
    }
    if (error.code === '08006') {
      return new DatabaseError(message, ErrorCode.CONNECTION_ERROR, undefined, correlationId);
    }
  }

  // Detect from error message
  const lowerMessage = message.toLowerCase();

  if (lowerMessage.includes('timeout')) {
    return new TimeoutError('Unknown operation', 0, { originalError: message }, correlationId);
  }

  if (lowerMessage.includes('rate limit') || lowerMessage.includes('too many requests')) {
    return new RateLimitError(undefined, { originalError: message }, correlationId);
  }

  if (lowerMessage.includes('signature') || lowerMessage.includes('verification')) {
    return new CryptoError(message, ErrorCode.SIGNATURE_VERIFICATION_FAILED, undefined, correlationId);
  }

  if (lowerMessage.includes('not found')) {
    return new ValidationError(message, ErrorCode.RESOURCE_NOT_FOUND, undefined, correlationId);
  }

  // Default to internal error
  return new BioPassportError(
    message,
    ErrorCode.INTERNAL_ERROR,
    { originalError: error.constructor?.name },
    correlationId
  );
}

/**
 * Express error handling middleware
 */
export function errorHandlingMiddleware(logger?: CorrelatedLogger) {
  return (err: any, req: Request, res: Response, next: NextFunction) => {
    // Get correlation ID from request
    const correlationId = req.correlationId || (req as any).log?.getCorrelationId();

    // Convert to BioPassportError
    const bioPassportError = toBioPassportError(err, correlationId);

    // Log error
    if (logger || (req as any).log) {
      const logInstance = (req as any).log || logger;
      logInstance.error(
        bioPassportError.toLogFormat(),
        `Request error: ${bioPassportError.message}`
      );
    }

    // Send response
    res.status(bioPassportError.statusCode).json(bioPassportError.toJSON());
  };
}

/**
 * Async handler wrapper for Express routes
 * Automatically catches errors and passes to error middleware
 */
export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
