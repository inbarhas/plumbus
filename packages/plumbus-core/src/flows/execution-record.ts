import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DataValidationError } from '../errors/index.js';
import type { AuthContext } from '../types/security.js';
import type { FlowDefinition } from '../types/flow.js';
import { flowExecutionsTable } from './schema.js';

export const flowAuthSchema = z.object({
  userId: z.string().min(1).optional(),
  tenantId: z.string().min(1).optional(),
  roles: z.array(z.string()),
  scopes: z.array(z.string()),
  provider: z.string().min(1),
  providerId: z.string().optional(),
  internal: z.boolean().optional(),
});
export interface FlowStartOptions {
  executionId?: string;
  correlationId?: string;
  triggerEventId?: string;
  scheduleId?: string;
  scheduleTickId?: string;
}
/** Persist only. Callers own transaction boundaries and post-commit notifications. */
export async function createFlowExecutionRecord(
  db: PostgresJsDatabase,
  flow: FlowDefinition,
  input: unknown,
  auth: AuthContext,
  options: FlowStartOptions = {},
) {
  const parsed = flow.input.safeParse(input);
  if (!parsed.success)
    throw new DataValidationError(`Flow "${flow.name}": invalid input`, { flowName: flow.name });
  const state = flow.state?.safeParse({});
  const id = options.executionId ?? randomUUID();
  await db.insert(flowExecutionsTable).values({
    id,
    flowName: flow.name,
    domain: flow.domain,
    status: 'created',
    input: parsed.data,
    state: state?.success ? state.data : flow.state ? {} : null,
    currentStep: flow.steps[0]?.name ?? null,
    stepHistory: [],
    retryCount: 0,
    actor: auth.userId ?? 'system',
    tenantId: auth.tenantId ?? null,
    authSnapshotJson: flowAuthSchema.parse(auth),
    correlationId: options.correlationId ?? null,
    triggerEventId: options.triggerEventId ?? null,
    scheduleId: options.scheduleId,
    scheduleTickId: options.scheduleTickId,
  });
  return { id, flowName: flow.name, status: 'created' };
}
