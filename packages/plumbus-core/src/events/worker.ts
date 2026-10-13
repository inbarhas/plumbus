import { randomUUID } from 'node:crypto';
import {
  resolveRetryPolicy,
  retryDelay,
  isPermanentFailure,
  isDeferredDelivery,
  type RetryPolicy,
} from '../config/index.js';
import { DataValidationError } from '../errors/index.js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { PlumbusMetrics } from '../observability/metrics.js';
import type { AuditService } from '../types/audit.js';
import type { LoggerService } from '../types/context.js';
import type { EventEnvelope } from '../types/event.js';
import { createJobService } from '../jobs/service.js';
import type { JobQueuePayload } from '../jobs/types.js';
import type { ConsumerRegistry } from './consumer-registry.js';
import type { IdempotencyService } from './idempotency.js';
import { deadLetterTable } from './outbox.js';
import { recordPipelineAudit } from './pipeline-audit.js';
import type { EventQueue } from './queue.js';

export interface EventDeadLetterInfo {
  deadLetterId: string;
  eventId: string;
  eventType: string;
  consumerId?: string;
  attempts: number;
  reason: 'exhausted' | 'permanent' | 'unrouted';
  tenantId?: string;
}
export interface EventDeliveryOptions {
  retry?: RetryPolicy;
  unrouted?: 'deadLetter' | 'acknowledge';
  ignoredEventTypes?: string[];
}
export interface WorkerConfig extends EventDeliveryOptions {
  onEventDeadLetter?: (info: EventDeadLetterInfo) => void | Promise<void>;
  db: PostgresJsDatabase;
  queue: EventQueue;
  consumers: ConsumerRegistry;
  idempotency: IdempotencyService;
  audit?: AuditService;
  metrics?: PlumbusMetrics;
  /** Receives audit write failures (default: console) */
  logger?: LoggerService;
  /** Default max retries per consumer (default: 3) */
  defaultMaxRetries?: number;
  /** Base delay in ms for exponential backoff between retries (default: 100) */
  retryBackoffBaseMs?: number;
  /** Max backoff delay in ms (default: 5000) */
  retryBackoffMaxMs?: number;
}

/**
 * Creates an event delivery worker that subscribes to the queue,
 * routes events to registered consumers with idempotency checks,
 * and dead-letters events that exhaust retries.
 *
 * Returns start/stop controls.
 */
export function createEventWorker(config: WorkerConfig) {
  const {
    db,
    queue,
    consumers,
    idempotency,
    defaultMaxRetries = 3,
    metrics,
    audit,
    logger,
    retryBackoffBaseMs = 100,
    retryBackoffMaxMs = 5000,
  } = config;

  let unsubscribe: (() => void) | null = null;

  if (config.retry?.maxAttempts !== undefined && config.defaultMaxRetries !== undefined)
    throw new DataValidationError('Use retry.maxAttempts or defaultMaxRetries, not both');
  const defaults = resolveRetryPolicy(config.retry, {
    maxAttempts: defaultMaxRetries,
    backoff: 'exponential',
    baseDelayMs: retryBackoffBaseMs,
    maxDelayMs: retryBackoffMaxMs,
  });

  async function deadLetter(
    envelope: EventEnvelope,
    consumerId: string | undefined,
    attempts: number,
    reason: EventDeadLetterInfo['reason'],
    lastError: string,
  ): Promise<void> {
    const deadLetterId = randomUUID();
    await db.insert(deadLetterTable).values({
      id: deadLetterId,
      eventId: envelope.id,
      eventType: envelope.eventType,
      payload: envelope.payload as any,
      consumerId,
      lastError,
      retryCount: String(attempts),
      metadata: {
        correlationId: envelope.correlationId,
        causationId: envelope.causationId,
        actor: envelope.actor,
        tenantId: envelope.tenantId,
        reason,
      },
    });
    const info: EventDeadLetterInfo = {
      deadLetterId,
      eventId: envelope.id,
      eventType: envelope.eventType,
      consumerId,
      attempts,
      reason,
      tenantId: envelope.tenantId,
    };
    metrics?.eventFailed.inc({ consumer: consumerId ?? 'unrouted' });
    await recordPipelineAudit(audit, logger, 'event.consumer.dead_lettered', {
      ...info,
      outcome: 'failure',
    });
    (logger ?? console).error('Event delivery dead-lettered', { ...info });
    try {
      await config.onEventDeadLetter?.(info);
    } catch {
      (logger ?? console).error('Event dead-letter notification failed', {
        deadLetterId,
        eventId: envelope.id,
      });
    }
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function deliver(envelope: EventEnvelope): Promise<void> {
    const matched = consumers.getConsumers(envelope.eventType, envelope.version);
    const deliveryStarted = Date.now();

    if (matched.length === 0) {
      metrics?.eventUnrouted?.inc();
      const ignored = config.ignoredEventTypes?.includes(envelope.eventType) === true;
      await recordPipelineAudit(audit, logger, 'event.consumer.unrouted', {
        eventId: envelope.id,
        eventType: envelope.eventType,
        ignored,
        outcome: 'failure',
      });
      (logger ?? console).warn('Event has no matching local consumer', {
        eventId: envelope.id,
        eventType: envelope.eventType,
        ignored,
      });
      if (!ignored && config.unrouted !== 'acknowledge')
        await deadLetter(envelope, undefined, 0, 'unrouted', 'No matching local consumer');
      return;
    }
    for (const consumer of matched) {
      const policy = resolveRetryPolicy(consumer.retry, {
        ...defaults,
        maxAttempts: consumer.maxRetries ?? defaults.maxAttempts,
      });
      const maxRetries = policy.maxAttempts;

      // Idempotency guard
      const alreadyProcessed = await idempotency.isProcessed(envelope.id, consumer.id);
      if (alreadyProcessed) continue;

      let lastError: string | undefined;
      let attempt = 0;
      let succeeded = false;
      let permanent = false;

      while (attempt < maxRetries && !succeeded) {
        attempt++;
        // No outcome yet: audit outcomes are `success | failure | denied`
        await recordPipelineAudit(audit, logger, 'event.consumer.attempt', {
          eventId: envelope.id,
          eventType: envelope.eventType,
          consumerId: consumer.id,
          attempt,
          tenantId: envelope.tenantId,
        });
        try {
          await consumer.handler(envelope);
          succeeded = true;
        } catch (err) {
          if (isDeferredDelivery(err)) throw err;
          lastError = err instanceof Error ? err.message : String(err);
          permanent = isPermanentFailure(err);
          if (permanent) break;
          if (attempt < maxRetries) await sleep(retryDelay(policy, attempt));
        }
      }

      if (succeeded) {
        await idempotency.markProcessed(envelope.id, consumer.id);
        metrics?.eventDelivered.inc({ consumer: consumer.id });
        metrics?.eventDeliveryDuration.observe(Date.now() - deliveryStarted, {
          consumer: consumer.id,
          outcome: 'delivered',
        });
        await recordPipelineAudit(audit, logger, 'event.consumer.delivered', {
          eventId: envelope.id,
          eventType: envelope.eventType,
          consumerId: consumer.id,
          tenantId: envelope.tenantId,
          outcome: 'success',
        });
      } else {
        await deadLetter(
          envelope,
          consumer.id,
          attempt,
          permanent ? 'permanent' : 'exhausted',
          lastError ?? 'Unknown error',
        );
        metrics?.eventDeliveryDuration.observe(Date.now() - deliveryStarted, {
          consumer: consumer.id,
          outcome: 'failed',
        });

        if (consumer.id.startsWith('job:')) {
          const payload = envelope.payload as JobQueuePayload;
          if (payload.jobExecutionId) {
            const jobs = createJobService(db);
            await jobs.markDeadLettered(payload.jobExecutionId, {
              code: 'delivery_exhausted',
              message: lastError ?? 'Job delivery exhausted retries',
            });
          }
        }
      }
    }
  }

  return {
    /** Process a single envelope (useful for testing) */
    deliver,

    /** Start subscribing to the queue */
    start(): void {
      if (unsubscribe) return;
      unsubscribe = queue.subscribe(deliver);
    },

    /** Stop the worker */
    stop(): void {
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
    },

    get isRunning(): boolean {
      return unsubscribe !== null;
    },
  };
}
