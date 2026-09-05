import { randomUUID } from 'node:crypto';
import type { SqlConnection, SqlPool } from '../auth/postgres-auth-repository.js';
import { LOCAL_EXTRACTOR_VERSION } from './extraction-schema.js';
import { extractLocalMarkedLines, type LocalExtraction } from './local-extractor.js';

const LEASE_MS = 15000;
const MAX_ATTEMPTS = 3;

type ClaimedJob = {
  runId: string;
  claimToken: string;
  outputEventId: string;
  manifestDigest: string;
  outputBody: string;
  workspaceId: string;
  taskId: string;
  botId: string;
  botVersionId: string;
  groupId: string | null;
  attemptCount: number;
};

export class ExtractionWorker {
  constructor(
    private readonly pool: SqlPool,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async runOnce(): Promise<boolean> {
    const claimed = await this.claim();
    if (!claimed) return false;
    const extracted = extractLocalMarkedLines(claimed.outputBody ?? '');
    await this.finish(claimed, extracted);
    return true;
  }

  private async transaction<T>(action: (connection: SqlConnection) => Promise<T>): Promise<T> {
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      const result = await action(connection);
      await connection.query('COMMIT');
      return result;
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }

  private async claim(): Promise<ClaimedJob | undefined> {
    return this.transaction(async (connection) => {
      const now = this.now();
      const row = (
        await connection.query<{
          run_id: string;
          output_event_id: string;
          manifest_digest: string;
          attempt_count: number;
        }>(
          `SELECT run_id,output_event_id,manifest_digest,attempt_count FROM memory_extraction_jobs
           WHERE available_at<=$1 AND attempt_count<$2
             AND (status='queued' OR (status='running' AND lease_expires_at<=$1))
           ORDER BY available_at,run_id LIMIT 1`,
          [now, MAX_ATTEMPTS],
        )
      ).rows[0];
      if (!row) return;
      const claimToken = randomUUID();
      const updated = await connection.query(
        `UPDATE memory_extraction_jobs SET status='running',claim_token=$2,lease_expires_at=$3,attempt_count=attempt_count+1,updated_at=$4
         WHERE run_id=$1 AND available_at<=$4 AND attempt_count<$5
           AND (status='queued' OR (status='running' AND lease_expires_at<=$4))
         RETURNING attempt_count`,
        [row.run_id, claimToken, new Date(now.getTime() + LEASE_MS), now, MAX_ATTEMPTS],
      );
      if (!updated.rows.length) return;
      const context = (
        await connection.query<{
          body: string | null;
          workspace_id: string;
          task_id: string;
          bot_id: string;
          bot_version_id: string;
          group_id: string | null;
        }>(
          `SELECT e.body,t.workspace_id,t.id AS task_id,t.bot_id,t.bot_version_id,c.group_id
           FROM memory_extraction_jobs j
           JOIN task_runs r ON r.id=j.run_id
           JOIN tasks t ON t.id=r.task_id
           JOIN conversations c ON c.id=t.conversation_id
           JOIN conversation_events e ON e.id=j.output_event_id
           WHERE j.run_id=$1 AND j.claim_token=$2 AND j.status='running'`,
          [row.run_id, claimToken],
        )
      ).rows[0];
      if (!context) return;
      return {
        runId: row.run_id,
        claimToken,
        outputEventId: row.output_event_id,
        manifestDigest: row.manifest_digest,
        outputBody: context.body ?? '',
        workspaceId: context.workspace_id,
        taskId: context.task_id,
        botId: context.bot_id,
        botVersionId: context.bot_version_id,
        groupId: context.group_id,
        attemptCount: Number(updated.rows[0]!.attempt_count),
      };
    });
  }

  private async finish(claimed: ClaimedJob, extracted: LocalExtraction) {
    await this.transaction(async (connection) => {
      const owned = (
        await connection.query(
          `SELECT run_id FROM memory_extraction_jobs WHERE run_id=$1 AND claim_token=$2 AND status='running' AND lease_expires_at>$3`,
          [claimed.runId, claimed.claimToken, this.now()],
        )
      ).rows[0];
      if (!owned) return;
      if (!extracted.ok) {
        await connection.query(
          `UPDATE memory_extraction_jobs SET status='failed',last_error_code=$2,claim_token=NULL,lease_expires_at=NULL,updated_at=$3 WHERE run_id=$1 AND claim_token=$4`,
          [claimed.runId, extracted.error, this.now(), claimed.claimToken],
        );
        return;
      }
      const sourceIds = (
        await connection.query<{ event_id: string }>(
          `SELECT DISTINCT event_id FROM (
             SELECT $2 AS event_id
             UNION
             SELECT creation_event_id FROM run_source_manifest_items WHERE run_id=$1 AND creation_event_id IS NOT NULL
             UNION
             SELECT version_event_id FROM run_source_manifest_items WHERE run_id=$1 AND version_event_id IS NOT NULL
             UNION
             SELECT source_event_id FROM run_source_manifest_items WHERE run_id=$1 AND source_event_id IS NOT NULL
           ) sources`,
          [claimed.runId, claimed.outputEventId],
        )
      ).rows.map((row) => row.event_id);
      const proposed =
        claimed.groupId != null
          ? { kind: 'group' as const, id: claimed.groupId }
          : { kind: 'bot' as const, id: claimed.botId };
      const now = this.now();
      for (const candidate of extracted.candidates) {
        const id = randomUUID();
        await connection.query(
          `INSERT INTO memory_candidates(
             id,run_id,workspace_id,normalized_fingerprint,proposed_scope_kind,proposed_scope_id,status,confidence,confidence_source,extractor_version,origin_task_id,origin_bot_version_id,output_event_id,manifest_digest,current_revision,created_at
           ) VALUES($1,$2,$3,$4,$5,$6,'pending',0.5,'local_rule',$7,$8,$9,$10,$11,1,$12)`,
          [
            id,
            claimed.runId,
            claimed.workspaceId,
            candidate.fingerprint,
            proposed.kind,
            proposed.id,
            LOCAL_EXTRACTOR_VERSION,
            claimed.taskId,
            claimed.botVersionId,
            claimed.outputEventId,
            claimed.manifestDigest,
            now,
          ],
        );
        await connection.query(
          'INSERT INTO memory_candidate_revisions(candidate_id,revision,body,author_user_id,created_at) VALUES($1,1,$2,NULL,$3)',
          [id, candidate.text, now],
        );
        for (const eventId of sourceIds) {
          await connection.query(
            'INSERT INTO memory_candidate_sources(candidate_id,event_id) VALUES($1,$2)',
            [id, eventId],
          );
        }
      }
      await connection.query(
        `UPDATE memory_extraction_jobs SET status='completed',claim_token=NULL,lease_expires_at=NULL,last_error_code=NULL,updated_at=$2 WHERE run_id=$1 AND claim_token=$3`,
        [claimed.runId, now, claimed.claimToken],
      );
    });
  }
}
