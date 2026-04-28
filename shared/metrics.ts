/**
 * Metrics Collection with Prometheus (prom-client)
 *
 * Benefits:
 * - Real-time performance monitoring
 * - Integration with Prometheus and Grafana
 * - Track request latency, error rates, throughput
 * - Custom business metrics
 */

import client from 'prom-client';
import { Request, Response, NextFunction } from 'express';

/**
 * Initialize Prometheus metrics registry
 */
export function initializeMetrics(serviceName: string) {
  // Enable default metrics (CPU, memory, event loop, etc.)
  client.collectDefaultMetrics({
    prefix: `${serviceName}_`,
    gcDurationBuckets: [0.001, 0.01, 0.1, 1, 2, 5]
  });

  return client.register;
}

/**
 * HTTP Metrics
 */
export class HttpMetrics {
  private httpRequestDuration: client.Histogram;
  private httpRequestTotal: client.Counter;
  private httpRequestErrors: client.Counter;
  private httpRequestsInProgress: client.Gauge;

  constructor(serviceName: string) {
    // Request duration histogram
    this.httpRequestDuration = new client.Histogram({
      name: `${serviceName}_http_request_duration_seconds`,
      help: 'Duration of HTTP requests in seconds',
      labelNames: ['method', 'route', 'status_code'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
    });

    // Request counter
    this.httpRequestTotal = new client.Counter({
      name: `${serviceName}_http_requests_total`,
      help: 'Total number of HTTP requests',
      labelNames: ['method', 'route', 'status_code']
    });

    // Error counter
    this.httpRequestErrors = new client.Counter({
      name: `${serviceName}_http_request_errors_total`,
      help: 'Total number of HTTP request errors',
      labelNames: ['method', 'route', 'error_type']
    });

    // In-progress gauge
    this.httpRequestsInProgress = new client.Gauge({
      name: `${serviceName}_http_requests_in_progress`,
      help: 'Number of HTTP requests currently in progress',
      labelNames: ['method', 'route']
    });
  }

  /**
   * Express middleware for automatic HTTP metrics
   */
  middleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      const start = Date.now();
      const route = req.route?.path || req.path || 'unknown';

      // Increment in-progress gauge
      this.httpRequestsInProgress.inc({ method: req.method, route });

      // Track response
      res.on('finish', () => {
        const duration = (Date.now() - start) / 1000; // Convert to seconds
        const statusCode = res.statusCode.toString();

        // Record duration
        this.httpRequestDuration.observe(
          { method: req.method, route, status_code: statusCode },
          duration
        );

        // Increment total counter
        this.httpRequestTotal.inc({ method: req.method, route, status_code: statusCode });

        // Track errors (4xx, 5xx)
        if (res.statusCode >= 400) {
          const errorType = res.statusCode >= 500 ? 'server_error' : 'client_error';
          this.httpRequestErrors.inc({ method: req.method, route, error_type: errorType });
        }

        // Decrement in-progress gauge
        this.httpRequestsInProgress.dec({ method: req.method, route });
      });

      next();
    };
  }
}

/**
 * Blockchain Metrics
 */
export class BlockchainMetrics {
  private txDuration: client.Histogram;
  private txTotal: client.Counter;
  private txErrors: client.Counter;
  private blockHeight: client.Gauge;
  private gasUsed: client.Histogram;

  constructor(serviceName: string) {
    // Transaction duration
    this.txDuration = new client.Histogram({
      name: `${serviceName}_blockchain_tx_duration_seconds`,
      help: 'Duration of blockchain transactions in seconds',
      labelNames: ['operation', 'status'],
      buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60]
    });

    // Transaction counter
    this.txTotal = new client.Counter({
      name: `${serviceName}_blockchain_tx_total`,
      help: 'Total number of blockchain transactions',
      labelNames: ['operation', 'status']
    });

    // Transaction errors
    this.txErrors = new client.Counter({
      name: `${serviceName}_blockchain_tx_errors_total`,
      help: 'Total number of blockchain transaction errors',
      labelNames: ['operation', 'error_type']
    });

    // Block height
    this.blockHeight = new client.Gauge({
      name: `${serviceName}_blockchain_block_height`,
      help: 'Current blockchain block height'
    });

    // Gas used
    this.gasUsed = new client.Histogram({
      name: `${serviceName}_blockchain_gas_used`,
      help: 'Gas used by blockchain transactions',
      labelNames: ['operation'],
      buckets: [10000, 50000, 100000, 200000, 500000, 1000000]
    });
  }

  /**
   * Record transaction
   */
  recordTransaction(operation: string, durationMs: number, status: 'success' | 'failure', gasUsed?: number): void {
    const durationSeconds = durationMs / 1000;

    this.txDuration.observe({ operation, status }, durationSeconds);
    this.txTotal.inc({ operation, status });

    if (gasUsed !== undefined) {
      this.gasUsed.observe({ operation }, gasUsed);
    }
  }

  /**
   * Record transaction error
   */
  recordError(operation: string, errorType: string): void {
    this.txErrors.inc({ operation, error_type: errorType });
  }

  /**
   * Update block height
   */
  updateBlockHeight(height: number): void {
    this.blockHeight.set(height);
  }
}

/**
 * Database Metrics
 */
export class DatabaseMetrics {
  private queryDuration: client.Histogram;
  private queryTotal: client.Counter;
  private queryErrors: client.Counter;
  private connectionPoolSize: client.Gauge;
  private connectionPoolUsed: client.Gauge;

  constructor(serviceName: string) {
    // Query duration
    this.queryDuration = new client.Histogram({
      name: `${serviceName}_db_query_duration_seconds`,
      help: 'Duration of database queries in seconds',
      labelNames: ['operation'],
      buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5]
    });

    // Query counter
    this.queryTotal = new client.Counter({
      name: `${serviceName}_db_queries_total`,
      help: 'Total number of database queries',
      labelNames: ['operation', 'status']
    });

    // Query errors
    this.queryErrors = new client.Counter({
      name: `${serviceName}_db_query_errors_total`,
      help: 'Total number of database query errors',
      labelNames: ['operation', 'error_type']
    });

    // Connection pool size
    this.connectionPoolSize = new client.Gauge({
      name: `${serviceName}_db_connection_pool_size`,
      help: 'Total size of database connection pool'
    });

    // Connection pool used
    this.connectionPoolUsed = new client.Gauge({
      name: `${serviceName}_db_connection_pool_used`,
      help: 'Number of database connections currently in use'
    });
  }

  /**
   * Record query
   */
  recordQuery(operation: string, durationMs: number, status: 'success' | 'failure'): void {
    const durationSeconds = durationMs / 1000;
    this.queryDuration.observe({ operation }, durationSeconds);
    this.queryTotal.inc({ operation, status });
  }

  /**
   * Record query error
   */
  recordError(operation: string, errorType: string): void {
    this.queryErrors.inc({ operation, error_type: errorType });
  }

  /**
   * Update connection pool stats
   */
  updateConnectionPool(total: number, used: number): void {
    this.connectionPoolSize.set(total);
    this.connectionPoolUsed.set(used);
  }
}

/**
 * Storage Metrics (MinIO/S3)
 */
export class StorageMetrics {
  private operationDuration: client.Histogram;
  private operationTotal: client.Counter;
  private operationErrors: client.Counter;
  private objectSize: client.Histogram;

  constructor(serviceName: string) {
    // Operation duration
    this.operationDuration = new client.Histogram({
      name: `${serviceName}_storage_operation_duration_seconds`,
      help: 'Duration of storage operations in seconds',
      labelNames: ['operation', 'status'],
      buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10]
    });

    // Operation counter
    this.operationTotal = new client.Counter({
      name: `${serviceName}_storage_operations_total`,
      help: 'Total number of storage operations',
      labelNames: ['operation', 'status']
    });

    // Operation errors
    this.operationErrors = new client.Counter({
      name: `${serviceName}_storage_operation_errors_total`,
      help: 'Total number of storage operation errors',
      labelNames: ['operation', 'error_type']
    });

    // Object size
    this.objectSize = new client.Histogram({
      name: `${serviceName}_storage_object_size_bytes`,
      help: 'Size of storage objects in bytes',
      labelNames: ['operation'],
      buckets: [1024, 10240, 102400, 1048576, 10485760, 104857600] // 1KB to 100MB
    });
  }

  /**
   * Record storage operation
   */
  recordOperation(operation: string, durationMs: number, status: 'success' | 'failure', sizeBytes?: number): void {
    const durationSeconds = durationMs / 1000;
    this.operationDuration.observe({ operation, status }, durationSeconds);
    this.operationTotal.inc({ operation, status });

    if (sizeBytes !== undefined) {
      this.objectSize.observe({ operation }, sizeBytes);
    }
  }

  /**
   * Record storage error
   */
  recordError(operation: string, errorType: string): void {
    this.operationErrors.inc({ operation, error_type: errorType });
  }
}

/**
 * Cache Metrics
 */
export class CacheMetrics {
  private hits: client.Counter;
  private misses: client.Counter;
  private size: client.Gauge;
  private evictions: client.Counter;

  constructor(serviceName: string) {
    // Cache hits
    this.hits = new client.Counter({
      name: `${serviceName}_cache_hits_total`,
      help: 'Total number of cache hits',
      labelNames: ['cache_type']
    });

    // Cache misses
    this.misses = new client.Counter({
      name: `${serviceName}_cache_misses_total`,
      help: 'Total number of cache misses',
      labelNames: ['cache_type']
    });

    // Cache size
    this.size = new client.Gauge({
      name: `${serviceName}_cache_size`,
      help: 'Current size of cache',
      labelNames: ['cache_type']
    });

    // Cache evictions
    this.evictions = new client.Counter({
      name: `${serviceName}_cache_evictions_total`,
      help: 'Total number of cache evictions',
      labelNames: ['cache_type']
    });
  }

  /**
   * Record cache hit
   */
  recordHit(cacheType: string): void {
    this.hits.inc({ cache_type: cacheType });
  }

  /**
   * Record cache miss
   */
  recordMiss(cacheType: string): void {
    this.misses.inc({ cache_type: cacheType });
  }

  /**
   * Update cache size
   */
  updateSize(cacheType: string, size: number): void {
    this.size.set({ cache_type: cacheType }, size);
  }

  /**
   * Record cache eviction
   */
  recordEviction(cacheType: string): void {
    this.evictions.inc({ cache_type: cacheType });
  }
}

/**
 * Business Metrics (BioPassport-specific)
 */
export class BusinessMetrics {
  private materialsRegistered: client.Counter;
  private credentialsIssued: client.Counter;
  private verificationsPerformed: client.Counter;
  private transfersInitiated: client.Counter;
  private verificationLatency: client.Histogram;

  constructor(serviceName: string) {
    // Materials registered
    this.materialsRegistered = new client.Counter({
      name: `${serviceName}_materials_registered_total`,
      help: 'Total number of materials registered',
      labelNames: ['material_type', 'org']
    });

    // Credentials issued
    this.credentialsIssued = new client.Counter({
      name: `${serviceName}_credentials_issued_total`,
      help: 'Total number of credentials issued',
      labelNames: ['credential_type', 'issuer']
    });

    // Verifications performed
    this.verificationsPerformed = new client.Counter({
      name: `${serviceName}_verifications_performed_total`,
      help: 'Total number of verifications performed',
      labelNames: ['result']
    });

    // Transfers initiated
    this.transfersInitiated = new client.Counter({
      name: `${serviceName}_transfers_initiated_total`,
      help: 'Total number of transfers initiated',
      labelNames: ['from_org', 'to_org']
    });

    // Verification latency
    this.verificationLatency = new client.Histogram({
      name: `${serviceName}_verification_latency_seconds`,
      help: 'Latency of material verifications',
      labelNames: ['cache_hit'],
      buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5]
    });
  }

  /**
   * Record material registration
   */
  recordMaterialRegistration(materialType: string, org: string): void {
    this.materialsRegistered.inc({ material_type: materialType, org });
  }

  /**
   * Record credential issuance
   */
  recordCredentialIssuance(credentialType: string, issuer: string): void {
    this.credentialsIssued.inc({ credential_type: credentialType, issuer });
  }

  /**
   * Record verification
   */
  recordVerification(passed: boolean, latencySeconds: number, cacheHit: boolean): void {
    const result = passed ? 'pass' : 'fail';
    this.verificationsPerformed.inc({ result });
    this.verificationLatency.observe({ cache_hit: cacheHit.toString() }, latencySeconds);
  }

  /**
   * Record transfer
   */
  recordTransfer(fromOrg: string, toOrg: string): void {
    this.transfersInitiated.inc({ from_org: fromOrg, to_org: toOrg });
  }
}

/**
 * Unified metrics collector
 */
export class MetricsCollector {
  public http: HttpMetrics;
  public blockchain: BlockchainMetrics;
  public database: DatabaseMetrics;
  public storage: StorageMetrics;
  public cache: CacheMetrics;
  public business: BusinessMetrics;
  public registry: client.Registry;

  constructor(serviceName: string) {
    this.registry = new client.Registry();
    client.register.setDefaultLabels({ service: serviceName });

    this.http = new HttpMetrics(serviceName);
    this.blockchain = new BlockchainMetrics(serviceName);
    this.database = new DatabaseMetrics(serviceName);
    this.storage = new StorageMetrics(serviceName);
    this.cache = new CacheMetrics(serviceName);
    this.business = new BusinessMetrics(serviceName);

    // Initialize default metrics
    initializeMetrics(serviceName);
  }

  /**
   * Get metrics endpoint handler for Express
   */
  metricsEndpoint() {
    return async (_req: Request, res: Response) => {
      res.set('Content-Type', client.register.contentType);
      res.end(await client.register.metrics());
    };
  }

  /**
   * Reset all metrics (for testing)
   */
  reset(): void {
    client.register.clear();
  }
}

/**
 * Create metrics collector instance
 */
export function createMetrics(serviceName: string): MetricsCollector {
  return new MetricsCollector(serviceName);
}
