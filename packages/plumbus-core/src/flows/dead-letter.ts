import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DataValidationError } from '../errors/index.js';
import type { FlowRegistry } from './registry.js';
import { createFlowExecutionRecord, flowAuthSchema } from './execution-record.js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { flowDeadLetterTable, flowExecutionsTable } from './schema.js';
import { FlowStatus } from './state-machine.js';

/**
 * Moves failed flow executions to the dead-letter table.
 * Call this after a flow has exhausted retries and entered Failed status.
 */
export async function deadLetterFlow(db: PostgresJsDatabase, executionId: string): Promise<void> {
  const rows = await db
    .select()
    .from(flowExecutionsTable)
    .where(eq(flowExecutionsTable.id, executionId))
    .limit(1);

  const row = rows[0];
  if (!row) throw new Error(`Flow execution "${executionId}" not found`);

  if (row.status !== FlowStatus.Failed) {
    throw new Error(
      `Cannot dead-letter flow "${executionId}" — status is "${row.status}", expected "failed"`,
    );
  }

  await db
    .insert(flowDeadLetterTable)
    .values({
      executionId: row.id,
      flowName: row.flowName,
      input: row.input as any,
      state: row.state as any,
      stepHistory: row.stepHistory as any,
      lastError: row.lastError,
      retryCount: row.retryCount,
      metadata: {
        actor: row.actor,
        tenantId: row.tenantId,
        correlationId: row.correlationId,
        triggerEventId: row.triggerEventId,
        createdAt: row.createdAt?.toISOString(),
        failedAt: row.completedAt?.toISOString(),
      },
    })
    .onConflictDoNothing({ target: flowDeadLetterTable.executionId });
}

/**
 * Scans for failed flow executions and moves them to dead-letter.
 * Returns the number of executions moved.
 */
export async function sweepFailedFlows(db: PostgresJsDatabase, limit = 100): Promise<number> {
  const failedRows = await db
    .select({ id: flowExecutionsTable.id })
    .from(flowExecutionsTable)
    .where(
      and(
        eq(flowExecutionsTable.status, FlowStatus.Failed),
        sql`NOT EXISTS (SELECT 1 FROM ${flowDeadLetterTable} WHERE ${flowDeadLetterTable.executionId} = ${flowExecutionsTable.id}::text)`,
      ),
    )
    .limit(limit);

  let moved = 0;
  for (const row of failedRows) {
    try {
      await deadLetterFlow(db, row.id);
      moved++;
    } catch {
      // Skip rows that fail to move — will be retried next sweep
    }
  }

  return moved;
}

/** Replay the failed step as a new execution; the original remains terminal. */
export async function replayDeadLetterFlow(
  db: PostgresJsDatabase,
  registry: FlowRegistry,
  executionId: string,
): Promise<string> {
  return db.transaction(async (tx) => {
    const [deadLetter] = await tx
      .select()
      .from(flowDeadLetterTable)
      .where(eq(flowDeadLetterTable.executionId, executionId))
      .for('update');
    if (!deadLetter) throw new DataValidationError('Flow dead letter not found', { executionId });
    const metadata = z.record(z.unknown()).parse(deadLetter.metadata ?? {});
    const previous = z.string().uuid().safeParse(metadata.replayExecutionId);
    if (previous.success) return previous.data;
    const [row] = await tx
      .select()
      .from(flowExecutionsTable)
      .where(eq(flowExecutionsTable.id, executionId));
    if (!row || row.status !== FlowStatus.Failed)
      throw new DataValidationError('Replay requires a failed source execution');
    const auth = flowAuthSchema.safeParse(row.authSnapshotJson);
    if (
      !auth.success ||
      (auth.data.tenantId ?? null) !== row.tenantId ||
      (auth.data.userId != null && auth.data.userId !== row.actor)
    ) {
      throw new DataValidationError('Replay requires the original verified caller identity');
    }
    const flow = registry.get(row.flowName);
    if (!flow || !flow.steps.some((step) => step.name === row.currentStep))
      throw new DataValidationError('Failed step is absent from the current flow definition');
    if (flow.state && !flow.state.safeParse(row.state).success)
      throw new DataValidationError(
        'Stored state is incompatible with the current flow definition',
      );
    const replay = await createFlowExecutionRecord(
      tx as unknown as PostgresJsDatabase,
      flow,
      row.input,
      auth.data,
      {
        correlationId: row.correlationId ?? undefined,
        triggerEventId: executionId,
        scheduleId: row.scheduleId ?? undefined,
      },
    );
    await tx
      .update(flowExecutionsTable)
      .set({ currentStep: row.currentStep, state: row.state, replayOf: row.id })
      .where(eq(flowExecutionsTable.id, replay.id));
    await tx
      .update(flowDeadLetterTable)
      .set({
        metadata: {
          ...metadata,
          replayExecutionId: replay.id,
          replayedAt: new Date().toISOString(),
          replaySource: 'operator',
        },
      })
      .where(eq(flowDeadLetterTable.id, deadLetter.id));
    return replay.id;
  });
}
