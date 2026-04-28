/**
 * Circuit Breaker Pattern with opossum
 *
 * Benefits:
 * - Prevents cascading failures
 * - Fast failure when service is down
 * - Automatic recovery testing
 * - Configurable thresholds
 */

import CircuitBreaker from 'opossum';
import { CorrelatedLogger } from './logger';

export interface CircuitBreakerConfig {
  timeout?: number;              // Request timeout (ms)
  errorThresholdPercentage?: number; // % of failures to open circuit
  resetTimeout?: number;         // Time before attempting reset (ms)
  rollingCountTimeout?: number;  // Window for error percentage (ms)
  rollingCountBuckets?: number;  // Number of buckets in window
  name?: string;                 // Circuit breaker name (for logging)
}

export interface CircuitBreakerStats {
  name: string;
  state: 'open' | 'closed' | 'half-open';
  failures: number;
  successes: number;
  fallbacks: number;
  timeouts: number;
  rejects: number;
  fires: number;
}

/**
 * Create a circuit breaker for a function
 */
export function createCircuitBreaker<T>(
  fn: (...args: any[]) => Promise<T>,
  config: CircuitBreakerConfig = {},
  logger?: CorrelatedLogger
): CircuitBreaker<any[], T> {
  const name = config.name || 'circuit-breaker';

  const options: CircuitBreaker.Options = {
    timeout: config.timeout || 30000,                    // 30 seconds
    errorThresholdPercentage: config.errorThresholdPercentage || 50, // 50% errors
    resetTimeout: config.resetTimeout || 30000,          // 30 seconds
    rollingCountTimeout: config.rollingCountTimeout || 10000, // 10 second window
    rollingCountBuckets: config.rollingCountBuckets || 10,    // 10 buckets
    name
  };

  const breaker = new CircuitBreaker(fn, options);

  // Event handlers
  breaker.on('open', () => {
    if (logger) {
      logger.warn({ circuit: name }, `Circuit breaker opened: ${name}`);
    } else {
      console.warn(`[CircuitBreaker] OPEN: ${name}`);
    }
  });

  breaker.on('halfOpen', () => {
    if (logger) {
      logger.info({ circuit: name }, `Circuit breaker half-open: ${name}`);
    } else {
      console.log(`[CircuitBreaker] HALF-OPEN: ${name}`);
    }
  });

  breaker.on('close', () => {
    if (logger) {
      logger.info({ circuit: name }, `Circuit breaker closed: ${name}`);
    } else {
      console.log(`[CircuitBreaker] CLOSED: ${name}`);
    }
  });

  breaker.on('timeout', () => {
    if (logger) {
      logger.warn({ circuit: name }, `Circuit breaker timeout: ${name}`);
    }
  });

  breaker.on('reject', () => {
    if (logger) {
      logger.warn({ circuit: name }, `Circuit breaker rejected: ${name}`);
    }
  });

  breaker.on('failure', (error: Error) => {
    if (logger) {
      logger.error({ circuit: name, error: error.message }, `Circuit breaker failure: ${name}`);
    }
  });

  return breaker;
}

/**
 * Circuit breaker manager for multiple services
 */
export class CircuitBreakerManager {
  private breakers: Map<string, CircuitBreaker<any[], any>> = new Map();
  private logger?: CorrelatedLogger;

  constructor(logger?: CorrelatedLogger) {
    this.logger = logger;
  }

  /**
   * Create and register a circuit breaker
   */
  create<T>(
    name: string,
    fn: (...args: any[]) => Promise<T>,
    config: CircuitBreakerConfig = {}
  ): CircuitBreaker<any[], T> {
    if (this.breakers.has(name)) {
      return this.breakers.get(name)!;
    }

    const breaker = createCircuitBreaker(fn, { ...config, name }, this.logger);
    this.breakers.set(name, breaker);

    return breaker;
  }

  /**
   * Get existing circuit breaker
   */
  get(name: string): CircuitBreaker<any[], any> | undefined {
    return this.breakers.get(name);
  }

  /**
   * Get all circuit breakers
   */
  getAll(): Map<string, CircuitBreaker<any[], any>> {
    return this.breakers;
  }

  /**
   * Get stats for all circuit breakers
   */
  getStats(): CircuitBreakerStats[] {
    const stats: CircuitBreakerStats[] = [];

    for (const [name, breaker] of this.breakers) {
      const state = breaker.opened ? 'open' : breaker.halfOpen ? 'half-open' : 'closed';
      const breakerStats = breaker.stats;

      stats.push({
        name,
        state,
        failures: breakerStats.failures,
        successes: breakerStats.successes,
        fallbacks: breakerStats.fallbacks,
        timeouts: breakerStats.timeouts,
        rejects: breakerStats.rejects,
        fires: breakerStats.fires
      });
    }

    return stats;
  }

  /**
   * Check if any circuit breakers are open
   */
  hasOpenCircuits(): boolean {
    for (const breaker of this.breakers.values()) {
      if (breaker.opened) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get health status
   */
  getHealth(): {
    healthy: boolean;
    total: number;
    open: number;
    halfOpen: number;
    closed: number;
  } {
    let open = 0;
    let halfOpen = 0;
    let closed = 0;

    for (const breaker of this.breakers.values()) {
      if (breaker.opened) {
        open++;
      } else if (breaker.halfOpen) {
        halfOpen++;
      } else {
        closed++;
      }
    }

    return {
      healthy: open === 0,
      total: this.breakers.size,
      open,
      halfOpen,
      closed
    };
  }

  /**
   * Reset all circuit breakers
   */
  resetAll(): void {
    for (const breaker of this.breakers.values()) {
      breaker.clearCache();
    }
  }

  /**
   * Shutdown all circuit breakers
   */
  shutdown(): void {
    for (const breaker of this.breakers.values()) {
      breaker.shutdown();
    }
    this.breakers.clear();
  }
}

/**
 * Blockchain circuit breakers
 */
export class BlockchainCircuitBreakers {
  private manager: CircuitBreakerManager;

  constructor(logger?: CorrelatedLogger) {
    this.manager = new CircuitBreakerManager(logger);
  }

  /**
   * Create circuit breaker for blockchain queries
   */
  createQueryBreaker<T>(
    name: string,
    queryFn: (...args: any[]) => Promise<T>
  ): CircuitBreaker<any[], T> {
    return this.manager.create(name, queryFn, {
      timeout: 10000,              // 10 second timeout
      errorThresholdPercentage: 50, // 50% errors
      resetTimeout: 30000,          // 30 seconds before retry
      name: `blockchain.query.${name}`
    });
  }

  /**
   * Create circuit breaker for blockchain transactions
   */
  createTxBreaker<T>(
    name: string,
    txFn: (...args: any[]) => Promise<T>
  ): CircuitBreaker<any[], T> {
    return this.manager.create(name, txFn, {
      timeout: 60000,              // 60 second timeout (transactions take longer)
      errorThresholdPercentage: 30, // 30% errors (more sensitive)
      resetTimeout: 60000,          // 60 seconds before retry
      name: `blockchain.tx.${name}`
    });
  }

  /**
   * Get manager
   */
  getManager(): CircuitBreakerManager {
    return this.manager;
  }
}

/**
 * Storage circuit breakers
 */
export class StorageCircuitBreakers {
  private manager: CircuitBreakerManager;

  constructor(logger?: CorrelatedLogger) {
    this.manager = new CircuitBreakerManager(logger);
  }

  /**
   * Create circuit breaker for storage operations
   */
  createStorageBreaker<T>(
    name: string,
    storageFn: (...args: any[]) => Promise<T>
  ): CircuitBreaker<any[], T> {
    return this.manager.create(name, storageFn, {
      timeout: 30000,              // 30 second timeout
      errorThresholdPercentage: 40, // 40% errors
      resetTimeout: 20000,          // 20 seconds before retry
      name: `storage.${name}`
    });
  }

  /**
   * Get manager
   */
  getManager(): CircuitBreakerManager {
    return this.manager;
  }
}

/**
 * Express middleware to add circuit breaker health to /health endpoint
 */
export function circuitBreakerHealthMiddleware(manager: CircuitBreakerManager) {
  return (req: any, res: any, next: any) => {
    if (req.path === '/health') {
      const health = manager.getHealth();
      req.circuitBreakerHealth = health;
    }
    next();
  };
}

/**
 * Express middleware to expose circuit breaker stats endpoint
 */
export function circuitBreakerStatsMiddleware(manager: CircuitBreakerManager) {
  return (req: any, res: any, next: any) => {
    if (req.path === '/circuit-breakers') {
      const stats = manager.getStats();
      res.json({
        health: manager.getHealth(),
        breakers: stats
      });
      return;
    }
    next();
  };
}

/**
 * Circuit breaker error
 */
export class CircuitBreakerError extends Error {
  constructor(message: string, public readonly circuitName: string) {
    super(message);
    this.name = 'CircuitBreakerError';
  }
}

/**
 * Helper to wrap function with circuit breaker and error handling
 */
export async function withCircuitBreaker<T>(
  breaker: CircuitBreaker<any[], T>,
  args: any[],
  fallback?: () => Promise<T>
): Promise<T> {
  try {
    return await breaker.fire(...args);
  } catch (error: any) {
    // Check if circuit is open
    if (breaker.opened) {
      if (fallback) {
        return await fallback();
      }
      throw new CircuitBreakerError(
        `Circuit breaker open: ${breaker.name}`,
        breaker.name
      );
    }
    throw error;
  }
}

// Export default instances for convenience
let defaultBlockchainBreakers: BlockchainCircuitBreakers | null = null;
let defaultStorageBreakers: StorageCircuitBreakers | null = null;

export function getBlockchainBreakers(logger?: CorrelatedLogger): BlockchainCircuitBreakers {
  if (!defaultBlockchainBreakers) {
    defaultBlockchainBreakers = new BlockchainCircuitBreakers(logger);
  }
  return defaultBlockchainBreakers;
}

export function getStorageBreakers(logger?: CorrelatedLogger): StorageCircuitBreakers {
  if (!defaultStorageBreakers) {
    defaultStorageBreakers = new StorageCircuitBreakers(logger);
  }
  return defaultStorageBreakers;
}
