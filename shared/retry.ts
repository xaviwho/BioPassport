/**
 * Advanced Retry Policies with p-retry
 *
 * Benefits:
 * - Exponential backoff with jitter
 * - Configurable retry conditions
 * - Timeout support
 * - Idempotency checks
 * - Error classification
 */

import pRetry, { AbortError, Options as PRetryOptions } from 'p-retry';
import pTimeout from 'p-timeout';
import { CorrelatedLogger } from './logger';

export interface RetryConfig {
  retries?: number;              // Maximum retry attempts
  minTimeout?: number;           // Minimum delay between retries (ms)
  maxTimeout?: number;           // Maximum delay between retries (ms)
  factor?: number;               // Exponential backoff factor
  randomize?: boolean;           // Add jitter to prevent thundering herd
  timeout?: number;              // Overall operation timeout (ms)
  onFailedAttempt?: (error: any, attempt: number) => void;
  shouldRetry?: (error: any) => boolean;
}

/**
 * Error classification for retry decisions
 */
export enum ErrorType {
  RETRIABLE = 'retriable',       // Network errors, timeouts, 5xx
  NON_RETRIABLE = 'non_retriable', // Validation errors, 4xx (except 429)
  RATE_LIMITED = 'rate_limited'   // 429 errors
}

/**
 * Classify error for retry decision
 */
export function classifyError(error: any): ErrorType {
  // HTTP errors
  if (error.response) {
    const status = error.response.status;

    // Rate limited - retriable with longer delay
    if (status === 429) {
      return ErrorType.RATE_LIMITED;
    }

    // Client errors (except 408, 429) - not retriable
    if (status >= 400 && status < 500 && status !== 408) {
      return ErrorType.NON_RETRIABLE;
    }

    // Server errors - retriable
    if (status >= 500) {
      return ErrorType.RETRIABLE;
    }
  }

  // Network errors - retriable
  if (
    error.code === 'ECONNREFUSED' ||
    error.code === 'ECONNRESET' ||
    error.code === 'ETIMEDOUT' ||
    error.code === 'ENOTFOUND' ||
    error.message?.includes('timeout') ||
    error.message?.includes('network')
  ) {
    return ErrorType.RETRIABLE;
  }

  // Blockchain nonce errors - retriable
  if (
    error.code === 'NONCE_EXPIRED' ||
    error.code === 'REPLACEMENT_UNDERPRICED' ||
    error.message?.includes('nonce')
  ) {
    return ErrorType.RETRIABLE;
  }

  // Default: not retriable (validation errors, etc.)
  return ErrorType.NON_RETRIABLE;
}

/**
 * Default retry policy (general purpose)
 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  retries: 3,
  minTimeout: 1000,    // 1 second
  maxTimeout: 30000,   // 30 seconds
  factor: 2,           // Exponential backoff
  randomize: true,     // Add jitter
  shouldRetry: (error: any) => {
    const errorType = classifyError(error);
    return errorType === ErrorType.RETRIABLE || errorType === ErrorType.RATE_LIMITED;
  }
};

/**
 * Retry policy for blockchain operations
 */
export const BLOCKCHAIN_RETRY_CONFIG: RetryConfig = {
  retries: 5,
  minTimeout: 2000,    // 2 seconds
  maxTimeout: 60000,   // 60 seconds
  factor: 2,
  randomize: true,
  shouldRetry: (error: any) => {
    const errorType = classifyError(error);
    // Retry on network issues and nonce errors
    return errorType === ErrorType.RETRIABLE;
  }
};

/**
 * Retry policy for storage operations
 */
export const STORAGE_RETRY_CONFIG: RetryConfig = {
  retries: 3,
  minTimeout: 1000,
  maxTimeout: 10000,
  factor: 2,
  randomize: true,
  shouldRetry: (error: any) => {
    const errorType = classifyError(error);
    return errorType === ErrorType.RETRIABLE || errorType === ErrorType.RATE_LIMITED;
  }
};

/**
 * Retry policy for database operations
 */
export const DATABASE_RETRY_CONFIG: RetryConfig = {
  retries: 3,
  minTimeout: 500,
  maxTimeout: 5000,
  factor: 2,
  randomize: true,
  shouldRetry: (error: any) => {
    // Retry on connection errors, deadlocks
    return (
      error.code === 'ECONNREFUSED' ||
      error.code === '40P01' || // Deadlock
      error.code === '08006' || // Connection failure
      error.message?.includes('connection')
    );
  }
};

/**
 * Execute function with retry logic
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  logger?: CorrelatedLogger
): Promise<T> {
  const options: PRetryOptions = {
    retries: config.retries || 3,
    minTimeout: config.minTimeout || 1000,
    maxTimeout: config.maxTimeout || 30000,
    factor: config.factor || 2,
    randomize: config.randomize !== false,
    onFailedAttempt: (error) => {
      const attempt = error.attemptNumber;
      const retriesLeft = error.retriesLeft;

      if (logger) {
        logger.warn(
          {
            attempt,
            retriesLeft,
            error: error.message
          },
          `Retry attempt ${attempt} failed, ${retriesLeft} retries left`
        );
      }

      if (config.onFailedAttempt) {
        config.onFailedAttempt(error, attempt);
      }

      // Check if should retry
      if (config.shouldRetry && !config.shouldRetry(error)) {
        throw new AbortError(error.message);
      }
    }
  };

  const operation = async () => {
    try {
      return await fn();
    } catch (error: any) {
      // Check if error should not be retried
      if (config.shouldRetry && !config.shouldRetry(error)) {
        throw new AbortError(error.message);
      }
      throw error;
    }
  };

  // Add timeout if configured
  if (config.timeout) {
    return await pTimeout(pRetry(operation, options), {
      milliseconds: config.timeout,
      message: `Operation timed out after ${config.timeout}ms`
    });
  }

  return await pRetry(operation, options);
}

/**
 * Retry decorator for class methods
 */
export function Retry(config: RetryConfig = DEFAULT_RETRY_CONFIG) {
  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      return withRetry(
        () => originalMethod.apply(this, args),
        config,
        (this as any).logger
      );
    };

    return descriptor;
  };
}

/**
 * Retry manager for tracking retry statistics
 */
export class RetryManager {
  private stats: Map<string, {
    attempts: number;
    successes: number;
    failures: number;
    totalRetries: number;
  }> = new Map();

  private logger?: CorrelatedLogger;

  constructor(logger?: CorrelatedLogger) {
    this.logger = logger;
  }

  /**
   * Execute with retry and track statistics
   */
  async execute<T>(
    operationName: string,
    fn: () => Promise<T>,
    config: RetryConfig = DEFAULT_RETRY_CONFIG
  ): Promise<T> {
    // Initialize stats if not exists
    if (!this.stats.has(operationName)) {
      this.stats.set(operationName, {
        attempts: 0,
        successes: 0,
        failures: 0,
        totalRetries: 0
      });
    }

    const stats = this.stats.get(operationName)!;
    stats.attempts++;

    let retryCount = 0;

    const configWithTracking: RetryConfig = {
      ...config,
      onFailedAttempt: (error, attempt) => {
        retryCount++;
        if (config.onFailedAttempt) {
          config.onFailedAttempt(error, attempt);
        }
      }
    };

    try {
      const result = await withRetry(fn, configWithTracking, this.logger);
      stats.successes++;
      stats.totalRetries += retryCount;
      return result;
    } catch (error) {
      stats.failures++;
      stats.totalRetries += retryCount;
      throw error;
    }
  }

  /**
   * Get statistics for an operation
   */
  getStats(operationName: string) {
    return this.stats.get(operationName) || {
      attempts: 0,
      successes: 0,
      failures: 0,
      totalRetries: 0
    };
  }

  /**
   * Get all statistics
   */
  getAllStats() {
    const result: Record<string, any> = {};
    for (const [name, stats] of this.stats) {
      result[name] = {
        ...stats,
        successRate: stats.attempts > 0 ? stats.successes / stats.attempts : 0,
        averageRetries: stats.attempts > 0 ? stats.totalRetries / stats.attempts : 0
      };
    }
    return result;
  }

  /**
   * Reset statistics
   */
  reset(): void {
    this.stats.clear();
  }
}

/**
 * Blockchain-specific retry helpers
 */
export class BlockchainRetry {
  private manager: RetryManager;

  constructor(logger?: CorrelatedLogger) {
    this.manager = new RetryManager(logger);
  }

  /**
   * Retry blockchain query
   */
  async query<T>(
    operationName: string,
    queryFn: () => Promise<T>
  ): Promise<T> {
    return this.manager.execute(
      `blockchain.query.${operationName}`,
      queryFn,
      BLOCKCHAIN_RETRY_CONFIG
    );
  }

  /**
   * Retry blockchain transaction
   */
  async transaction<T>(
    operationName: string,
    txFn: () => Promise<T>
  ): Promise<T> {
    return this.manager.execute(
      `blockchain.tx.${operationName}`,
      txFn,
      {
        ...BLOCKCHAIN_RETRY_CONFIG,
        timeout: 120000 // 2 minute timeout for transactions
      }
    );
  }

  /**
   * Get manager
   */
  getManager(): RetryManager {
    return this.manager;
  }
}

/**
 * Storage-specific retry helpers
 */
export class StorageRetry {
  private manager: RetryManager;

  constructor(logger?: CorrelatedLogger) {
    this.manager = new RetryManager(logger);
  }

  /**
   * Retry storage operation
   */
  async execute<T>(
    operationName: string,
    storageFn: () => Promise<T>
  ): Promise<T> {
    return this.manager.execute(
      `storage.${operationName}`,
      storageFn,
      STORAGE_RETRY_CONFIG
    );
  }

  /**
   * Get manager
   */
  getManager(): RetryManager {
    return this.manager;
  }
}

/**
 * Combine retry with circuit breaker
 */
export async function withRetryAndCircuitBreaker<T>(
  fn: () => Promise<T>,
  retryConfig: RetryConfig,
  circuitBreaker: any,
  logger?: CorrelatedLogger
): Promise<T> {
  return withRetry(
    async () => {
      // Circuit breaker wraps the actual operation
      return await circuitBreaker.fire(fn);
    },
    retryConfig,
    logger
  );
}

/**
 * Idempotency key generator
 */
export function generateIdempotencyKey(
  operation: string,
  ...params: any[]
): string {
  const crypto = require('crypto');
  const data = JSON.stringify({ operation, params });
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Idempotent operation executor
 * Prevents duplicate execution of the same operation
 */
export class IdempotentExecutor {
  private inProgress: Map<string, Promise<any>> = new Map();
  private completed: Map<string, { result: any; timestamp: number }> = new Map();
  private ttl: number;

  constructor(ttl: number = 300000) { // 5 minutes default
    this.ttl = ttl;

    // Cleanup old completed operations periodically
    setInterval(() => this.cleanup(), 60000); // Every minute
  }

  /**
   * Execute operation with idempotency
   */
  async execute<T>(
    idempotencyKey: string,
    fn: () => Promise<T>
  ): Promise<T> {
    // Check if already completed
    const completed = this.completed.get(idempotencyKey);
    if (completed) {
      return completed.result;
    }

    // Check if in progress
    const inProgress = this.inProgress.get(idempotencyKey);
    if (inProgress) {
      return await inProgress;
    }

    // Execute
    const promise = fn();
    this.inProgress.set(idempotencyKey, promise);

    try {
      const result = await promise;

      // Store result
      this.completed.set(idempotencyKey, {
        result,
        timestamp: Date.now()
      });

      return result;
    } finally {
      this.inProgress.delete(idempotencyKey);
    }
  }

  /**
   * Cleanup old completed operations
   */
  private cleanup(): void {
    const now = Date.now();
    for (const [key, value] of this.completed) {
      if (now - value.timestamp > this.ttl) {
        this.completed.delete(key);
      }
    }
  }

  /**
   * Get stats
   */
  getStats() {
    return {
      inProgress: this.inProgress.size,
      completed: this.completed.size
    };
  }

  /**
   * Clear all
   */
  clear(): void {
    this.inProgress.clear();
    this.completed.clear();
  }
}

// Export default instances
let defaultBlockchainRetry: BlockchainRetry | null = null;
let defaultStorageRetry: StorageRetry | null = null;
let defaultIdempotentExecutor: IdempotentExecutor | null = null;

export function getBlockchainRetry(logger?: CorrelatedLogger): BlockchainRetry {
  if (!defaultBlockchainRetry) {
    defaultBlockchainRetry = new BlockchainRetry(logger);
  }
  return defaultBlockchainRetry;
}

export function getStorageRetry(logger?: CorrelatedLogger): StorageRetry {
  if (!defaultStorageRetry) {
    defaultStorageRetry = new StorageRetry(logger);
  }
  return defaultStorageRetry;
}

export function getIdempotentExecutor(): IdempotentExecutor {
  if (!defaultIdempotentExecutor) {
    defaultIdempotentExecutor = new IdempotentExecutor();
  }
  return defaultIdempotentExecutor;
}
