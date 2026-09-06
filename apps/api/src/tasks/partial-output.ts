import type { SqlConnection } from '../auth/postgres-auth-repository.js';

export class TaskPartialOutputLimitError extends Error {}

// Caller owns the current Run lock and the delta/progress transaction. This
// checkpoint survives delivery retention; missing older bytes are never guessed.
export async function checkpointTaskPartialOutput(
  connection: SqlConnection,
  delta: { runId: string; text: string; startByte: number; endByte: number },
  occurredAt: Date,
) {
  const previous = (
    await connection.query<{ body: string; end_byte: number }>(
      'SELECT body,end_byte FROM task_run_partial_outputs WHERE run_id=$1',
      [delta.runId],
    )
  ).rows[0];
  if ((previous?.end_byte ?? 0) !== delta.startByte)
    throw new Error('Run partial checkpoint is not contiguous');
  const body = (previous?.body ?? '') + delta.text;
  if (body.length > 32000 || Buffer.byteLength(body) > 128000)
    throw new TaskPartialOutputLimitError();
  if (Buffer.byteLength(body) !== delta.endByte)
    throw new Error('Run partial checkpoint byte offset differs');
  await connection.query(
    previous
      ? 'UPDATE task_run_partial_outputs SET body=$2,end_byte=$3,updated_at=$4 WHERE run_id=$1'
      : 'INSERT INTO task_run_partial_outputs(run_id,body,end_byte,updated_at) VALUES($1,$2,$3,$4)',
    [delta.runId, body, delta.endByte, occurredAt],
  );
}

export interface TaskPartialOutput {
  conversationId: string;
  taskId: string;
  runId: string;
  partial: { text: string; endByte: number; interrupted: true } | null;
}
