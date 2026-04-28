/**
 * Structured Logging with Pino
 *
 * Benefits:
 * - JSON-formatted logs for machine parsing
 * - Correlation IDs for request tracing
 * - Different log levels (debug, info, warn, error)
 * - Performance optimized (faster than console.log)
 * - Integration with log aggregation systems (ELK, Loki)
 */

import pino from 'pino';
import { v4 as uuidv4 } from 'uuid';

/**
 * Log levels:
 * - trace (10): Very detailed debugging
 * - debug (20): Debugging information
 * - info (30): General information (default)
 * - warn (40): Warning messages
 * - error (50): Error messages
 * - fatal (60): Fatal errors (crashes)
 */

export interface LoggerConfig {
  serviceName: string;
  environment?: string;
  logLevel?: string;
  prettyPrint?: boolean;
}

/**
 * Create logger instance with configuration
 */
export function createLogger(config: LoggerConfig) {
  const environment = config.environment || process.env.NODE_ENV || 'development';
  const logLevel = config.logLevel || process.env.LOG_LEVEL || 'info';

  // Pretty print in development, JSON in production
  const prettyPrint = config.prettyPrint ?? (environment === 'development');

  const logger = pino({
    name: config.serviceName,
    level: logLevel,
    base: {
      service: config.serviceName,
      environment,
      pid: process.pid,
      hostname: process.env.HOSTNAME || 'unknown'
    },
    formatters: {
      level: (label) => {
        return { level: label };
      }
    },
    timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
    // Pretty print for development
    ...(prettyPrint && {
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss Z',
          ignore: 'pid,hostname'
        }
      }
    })
  });

  return logger;
}

/**
 * Logger with correlation ID support
 */
export class CorrelatedLogger {
  private logger: pino.Logger;
  private correlationId: string;

  constructor(logger: pino.Logger, correlationId?: string) {
    this.logger = logger;
    this.correlationId = correlationId || uuidv4();
  }

  /**
   * Create child logger with correlation ID
   */
  static fromRequest(logger: pino.Logger, req: any): CorrelatedLogger {
    const correlationId = req.headers['x-correlation-id'] ||
                         req.headers['x-request-id'] ||
                         uuidv4();
    return new CorrelatedLogger(logger, correlationId);
  }

  /**
   * Get correlation ID
   */
  getCorrelationId(): string {
    return this.correlationId;
  }

  /**
   * Create child logger with additional context
   */
  child(bindings: Record<string, any>): CorrelatedLogger {
    const childLogger = this.logger.child({
      ...bindings,
      correlationId: this.correlationId
    });
    return new CorrelatedLogger(childLogger, this.correlationId);
  }

  /**
   * Log trace message
   */
  trace(msg: string, ...args: any[]): void;
  trace(obj: Record<string, any>, msg?: string, ...args: any[]): void;
  trace(objOrMsg: string | Record<string, any>, msg?: string, ...args: any[]): void {
    if (typeof objOrMsg === 'string') {
      this.logger.trace({ correlationId: this.correlationId }, objOrMsg, ...args);
    } else {
      this.logger.trace({ ...objOrMsg, correlationId: this.correlationId }, msg, ...args);
    }
  }

  /**
   * Log debug message
   */
  debug(msg: string, ...args: any[]): void;
  debug(obj: Record<string, any>, msg?: string, ...args: any[]): void;
  debug(objOrMsg: string | Record<string, any>, msg?: string, ...args: any[]): void {
    if (typeof objOrMsg === 'string') {
      this.logger.debug({ correlationId: this.correlationId }, objOrMsg, ...args);
    } else {
      this.logger.debug({ ...objOrMsg, correlationId: this.correlationId }, msg, ...args);
    }
  }

  /**
   * Log info message
   */
  info(msg: string, ...args: any[]): void;
  info(obj: Record<string, any>, msg?: string, ...args: any[]): void;
  info(objOrMsg: string | Record<string, any>, msg?: string, ...args: any[]): void {
    if (typeof objOrMsg === 'string') {
      this.logger.info({ correlationId: this.correlationId }, objOrMsg, ...args);
    } else {
      this.logger.info({ ...objOrMsg, correlationId: this.correlationId }, msg, ...args);
    }
  }

  /**
   * Log warning message
   */
  warn(msg: string, ...args: any[]): void;
  warn(obj: Record<string, any>, msg?: string, ...args: any[]): void;
  warn(objOrMsg: string | Record<string, any>, msg?: string, ...args: any[]): void {
    if (typeof objOrMsg === 'string') {
      this.logger.warn({ correlationId: this.correlationId }, objOrMsg, ...args);
    } else {
      this.logger.warn({ ...objOrMsg, correlationId: this.correlationId }, msg, ...args);
    }
  }

  /**
   * Log error message
   */
  error(msg: string, ...args: any[]): void;
  error(obj: Record<string, any>, msg?: string, ...args: any[]): void;
  error(objOrMsg: string | Record<string, any>, msg?: string, ...args: any[]): void {
    if (typeof objOrMsg === 'string') {
      this.logger.error({ correlationId: this.correlationId }, objOrMsg, ...args);
    } else {
      this.logger.error({ ...objOrMsg, correlationId: this.correlationId }, msg, ...args);
    }
  }

  /**
   * Log fatal error message
   */
  fatal(msg: string, ...args: any[]): void;
  fatal(obj: Record<string, any>, msg?: string, ...args: any[]): void;
  fatal(objOrMsg: string | Record<string, any>, msg?: string, ...args: any[]): void {
    if (typeof objOrMsg === 'string') {
      this.logger.fatal({ correlationId: this.correlationId }, objOrMsg, ...args);
    } else {
      this.logger.fatal({ ...objOrMsg, correlationId: this.correlationId }, msg, ...args);
    }
  }
}

/**
 * Express middleware for request logging
 */
export function requestLoggingMiddleware(logger: pino.Logger) {
  return (req: any, res: any, next: any) => {
    const start = Date.now();
    const correlatedLogger = CorrelatedLogger.fromRequest(logger, req);

    // Add logger to request
    req.log = correlatedLogger;
    req.correlationId = correlatedLogger.getCorrelationId();

    // Add correlation ID to response headers
    res.setHeader('X-Correlation-ID', req.correlationId);

    // Log request
    correlatedLogger.info({
      method: req.method,
      url: req.url,
      ip: req.ip,
      userAgent: req.headers['user-agent']
    }, 'Incoming request');

    // Log response
    res.on('finish', () => {
      const duration = Date.now() - start;
      const level = res.statusCode >= 500 ? 'error' :
                    res.statusCode >= 400 ? 'warn' : 'info';

      correlatedLogger[level]({
        method: req.method,
        url: req.url,
        statusCode: res.statusCode,
        duration: `${duration}ms`
      }, 'Request completed');
    });

    next();
  };
}

/**
 * Error logging middleware (should be last)
 */
export function errorLoggingMiddleware(logger: pino.Logger) {
  return (err: any, req: any, res: any, next: any) => {
    const correlatedLogger = req.log || new CorrelatedLogger(logger);

    correlatedLogger.error({
      error: {
        message: err.message,
        stack: err.stack,
        code: err.code
      },
      method: req.method,
      url: req.url
    }, 'Request error');

    next(err);
  };
}

/**
 * Blockchain operation logger
 */
export function logBlockchainOperation(
  logger: CorrelatedLogger,
  operation: string,
  params: Record<string, any>,
  result?: any,
  error?: Error
): void {
  if (error) {
    logger.error({
      blockchain: {
        operation,
        params,
        error: {
          message: error.message,
          stack: error.stack
        }
      }
    }, `Blockchain operation failed: ${operation}`);
  } else {
    logger.info({
      blockchain: {
        operation,
        params,
        result
      }
    }, `Blockchain operation succeeded: ${operation}`);
  }
}

/**
 * Storage operation logger
 */
export function logStorageOperation(
  logger: CorrelatedLogger,
  operation: string,
  params: Record<string, any>,
  result?: any,
  error?: Error
): void {
  if (error) {
    logger.error({
      storage: {
        operation,
        params,
        error: {
          message: error.message,
          stack: error.stack
        }
      }
    }, `Storage operation failed: ${operation}`);
  } else {
    logger.debug({
      storage: {
        operation,
        params,
        result
      }
    }, `Storage operation succeeded: ${operation}`);
  }
}

/**
 * Performance logger
 */
export class PerformanceLogger {
  private logger: CorrelatedLogger;
  private operation: string;
  private start: number;
  private metadata: Record<string, any>;

  constructor(logger: CorrelatedLogger, operation: string, metadata: Record<string, any> = {}) {
    this.logger = logger;
    this.operation = operation;
    this.start = Date.now();
    this.metadata = metadata;

    this.logger.debug({ operation, ...metadata }, `Starting: ${operation}`);
  }

  /**
   * Mark operation as complete and log duration
   */
  complete(additionalMetadata: Record<string, any> = {}): void {
    const duration = Date.now() - this.start;
    this.logger.info({
      operation: this.operation,
      duration: `${duration}ms`,
      ...this.metadata,
      ...additionalMetadata
    }, `Completed: ${this.operation} (${duration}ms)`);
  }

  /**
   * Mark operation as failed and log error
   */
  fail(error: Error, additionalMetadata: Record<string, any> = {}): void {
    const duration = Date.now() - this.start;
    this.logger.error({
      operation: this.operation,
      duration: `${duration}ms`,
      error: {
        message: error.message,
        stack: error.stack
      },
      ...this.metadata,
      ...additionalMetadata
    }, `Failed: ${this.operation} (${duration}ms)`);
  }
}

// Export default logger for quick usage
let defaultLogger: pino.Logger | null = null;

export function getDefaultLogger(): pino.Logger {
  if (!defaultLogger) {
    defaultLogger = createLogger({
      serviceName: 'biopassport',
      environment: process.env.NODE_ENV || 'development'
    });
  }
  return defaultLogger;
}

export function setDefaultLogger(logger: pino.Logger): void {
  defaultLogger = logger;
}
