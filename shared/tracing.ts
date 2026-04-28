/**
 * Distributed Tracing with OpenTelemetry
 *
 * Benefits:
 * - End-to-end request tracing across services
 * - Performance bottleneck identification
 * - Dependency visualization
 * - Integration with Jaeger/Zipkin
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import {
  trace,
  Span,
  SpanStatusCode,
  context,
  propagation,
  Context
} from '@opentelemetry/api';
import { JaegerExporter } from '@opentelemetry/exporter-jaeger';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { Request, Response, NextFunction } from 'express';

export interface TracingConfig {
  serviceName: string;
  serviceVersion?: string;
  environment?: string;
  jaegerEndpoint?: string;
  enabled?: boolean;
}

let sdk: NodeSDK | null = null;

/**
 * Initialize OpenTelemetry tracing
 */
export function initializeTracing(config: TracingConfig): NodeSDK | null {
  const enabled = config.enabled ?? (process.env.TRACING_ENABLED === 'true' || process.env.NODE_ENV === 'production');

  if (!enabled) {
    console.log('[Tracing] Disabled (set TRACING_ENABLED=true to enable)');
    return null;
  }

  const jaegerEndpoint = config.jaegerEndpoint ||
                        process.env.JAEGER_ENDPOINT ||
                        'http://localhost:14268/api/traces';

  try {
    // Create Jaeger exporter
    const jaegerExporter = new JaegerExporter({
      endpoint: jaegerEndpoint
    });

    // Create SDK
    sdk = new NodeSDK({
      resource: new Resource({
        [SemanticResourceAttributes.SERVICE_NAME]: config.serviceName,
        [SemanticResourceAttributes.SERVICE_VERSION]: config.serviceVersion || '1.0.0',
        [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: config.environment || process.env.NODE_ENV || 'development'
      }),
      spanProcessor: new BatchSpanProcessor(jaegerExporter),
      instrumentations: [
        getNodeAutoInstrumentations({
          // Enable specific instrumentations
          '@opentelemetry/instrumentation-http': {
            enabled: true,
            ignoreIncomingPaths: ['/health', '/metrics']
          },
          '@opentelemetry/instrumentation-express': {
            enabled: true
          },
          '@opentelemetry/instrumentation-pg': {
            enabled: true
          },
          '@opentelemetry/instrumentation-fs': {
            enabled: false // Too noisy
          }
        })
      ]
    });

    // Start SDK
    sdk.start();

    console.log(`[Tracing] Initialized: ${config.serviceName} -> ${jaegerEndpoint}`);

    // Graceful shutdown
    process.on('SIGTERM', () => {
      sdk?.shutdown()
        .then(() => console.log('[Tracing] Shutdown complete'))
        .catch((err) => console.error('[Tracing] Shutdown error:', err))
        .finally(() => process.exit(0));
    });

    return sdk;
  } catch (error) {
    console.error('[Tracing] Initialization failed:', error);
    return null;
  }
}

/**
 * Get current tracer
 */
export function getTracer(name: string) {
  return trace.getTracer(name);
}

/**
 * Create a span for an operation
 */
export async function withSpan<T>(
  spanName: string,
  operation: (span: Span) => Promise<T>,
  attributes?: Record<string, any>
): Promise<T> {
  const tracer = getTracer('biopassport');
  return tracer.startActiveSpan(spanName, async (span) => {
    try {
      // Add attributes if provided
      if (attributes) {
        Object.entries(attributes).forEach(([key, value]) => {
          span.setAttribute(key, value);
        });
      }

      const result = await operation(span);

      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error: any) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error.message
      });
      span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Express middleware for tracing
 */
export function tracingMiddleware(serviceName: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const tracer = getTracer(serviceName);

    // Extract context from incoming request
    const ctx = propagation.extract(context.active(), req.headers);

    const span = tracer.startSpan(
      `${req.method} ${req.route?.path || req.path}`,
      {
        attributes: {
          'http.method': req.method,
          'http.url': req.url,
          'http.target': req.path,
          'http.host': req.hostname,
          'http.user_agent': req.headers['user-agent'] || 'unknown'
        }
      },
      ctx
    );

    // Store span in request for later use
    (req as any).span = span;
    (req as any).traceContext = context.active();

    // Add trace ID to response headers
    res.setHeader('X-Trace-ID', span.spanContext().traceId);

    // End span when response finishes
    res.on('finish', () => {
      span.setAttribute('http.status_code', res.statusCode);

      if (res.statusCode >= 500) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: `HTTP ${res.statusCode}`
        });
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
      }

      span.end();
    });

    next();
  };
}

/**
 * Trace blockchain operations
 */
export async function traceBlockchainOperation<T>(
  operation: string,
  params: Record<string, any>,
  fn: () => Promise<T>
): Promise<T> {
  return withSpan(
    `blockchain.${operation}`,
    async (span) => {
      span.setAttribute('blockchain.operation', operation);
      Object.entries(params).forEach(([key, value]) => {
        span.setAttribute(`blockchain.${key}`, value);
      });

      const result = await fn();

      return result;
    }
  );
}

/**
 * Trace storage operations
 */
export async function traceStorageOperation<T>(
  operation: string,
  params: Record<string, any>,
  fn: () => Promise<T>
): Promise<T> {
  return withSpan(
    `storage.${operation}`,
    async (span) => {
      span.setAttribute('storage.operation', operation);
      Object.entries(params).forEach(([key, value]) => {
        span.setAttribute(`storage.${key}`, value);
      });

      const result = await fn();

      return result;
    }
  );
}

/**
 * Trace database operations
 */
export async function traceDatabaseOperation<T>(
  operation: string,
  query: string,
  fn: () => Promise<T>
): Promise<T> {
  return withSpan(
    `db.${operation}`,
    async (span) => {
      span.setAttribute('db.system', 'postgresql');
      span.setAttribute('db.statement', query);
      span.setAttribute('db.operation', operation);

      const result = await fn();

      return result;
    }
  );
}

/**
 * Add event to current span
 */
export function addSpanEvent(name: string, attributes?: Record<string, any>): void {
  const span = trace.getActiveSpan();
  if (span) {
    span.addEvent(name, attributes);
  }
}

/**
 * Set attribute on current span
 */
export function setSpanAttribute(key: string, value: any): void {
  const span = trace.getActiveSpan();
  if (span) {
    span.setAttribute(key, value);
  }
}

/**
 * Create child span from current context
 */
export function createChildSpan(name: string, attributes?: Record<string, any>): Span {
  const tracer = getTracer('biopassport');
  const span = tracer.startSpan(name);

  if (attributes) {
    Object.entries(attributes).forEach(([key, value]) => {
      span.setAttribute(key, value);
    });
  }

  return span;
}

/**
 * Extract trace context from headers (for cross-service calls)
 */
export function extractTraceContext(headers: Record<string, any>): Context {
  return propagation.extract(context.active(), headers);
}

/**
 * Inject trace context into headers (for cross-service calls)
 */
export function injectTraceContext(headers: Record<string, string>): void {
  propagation.inject(context.active(), headers);
}

/**
 * Get current trace ID
 */
export function getCurrentTraceId(): string | undefined {
  const span = trace.getActiveSpan();
  return span?.spanContext().traceId;
}

/**
 * Get current span ID
 */
export function getCurrentSpanId(): string | undefined {
  const span = trace.getActiveSpan();
  return span?.spanContext().spanId;
}

/**
 * Tracer for specific operations
 */
export class OperationTracer {
  private tracer = getTracer('biopassport');

  /**
   * Trace a function call
   */
  async trace<T>(
    name: string,
    attributes: Record<string, any>,
    fn: () => Promise<T>
  ): Promise<T> {
    return this.tracer.startActiveSpan(name, async (span) => {
      try {
        // Set attributes
        Object.entries(attributes).forEach(([key, value]) => {
          span.setAttribute(key, value);
        });

        const result = await fn();
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error: any) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error.message
        });
        span.recordException(error);
        throw error;
      } finally {
        span.end();
      }
    });
  }

  /**
   * Trace blockchain transaction
   */
  async traceTransaction<T>(
    operation: string,
    materialId: string,
    fn: () => Promise<T>
  ): Promise<T> {
    return this.trace(
      `blockchain.${operation}`,
      {
        'blockchain.operation': operation,
        'blockchain.materialId': materialId
      },
      fn
    );
  }

  /**
   * Trace credential verification
   */
  async traceVerification<T>(
    materialId: string,
    verifyArtifacts: boolean,
    fn: () => Promise<T>
  ): Promise<T> {
    return this.trace(
      'verification.verify',
      {
        'verification.materialId': materialId,
        'verification.verifyArtifacts': verifyArtifacts
      },
      fn
    );
  }

  /**
   * Trace cache operation
   */
  async traceCache<T>(
    operation: 'get' | 'set',
    cacheType: string,
    key: string,
    fn: () => Promise<T>
  ): Promise<T> {
    return this.trace(
      `cache.${operation}`,
      {
        'cache.operation': operation,
        'cache.type': cacheType,
        'cache.key': key
      },
      fn
    );
  }
}

/**
 * Create operation tracer instance
 */
export function createOperationTracer(): OperationTracer {
  return new OperationTracer();
}

/**
 * Shutdown tracing
 */
export async function shutdownTracing(): Promise<void> {
  if (sdk) {
    await sdk.shutdown();
    console.log('[Tracing] Shutdown complete');
  }
}

// Export singleton instance
export const operationTracer = createOperationTracer();
