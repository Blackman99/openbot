import { enqueueSourceRevocations } from '../memories/lifecycle.js';
import { selectCurrentMessageSource } from './message-source.js';
import {
  attachmentCommandHash,
  type AttachmentCommand,
  type AttachmentRow,
} from '../attachments/types.js';
import { createHash, randomUUID } from 'node:crypto';
import type { SqlConnection, SqlPool } from '../auth/postgres-auth-repository.js';
import { GroupAccessError, type GroupRole } from '../groups/service.js';
import { lockAuthorizedGroup } from '../groups/postgres-group-access.js';
import { lockAuthorizedBot } from '../bots/postgres-bot-access.js';
import { BotAccessError, type BotLifecycleState } from '../bots/service.js';
import { currentPage, messageVersion, readMessageEvents } from './projection.js';
import { appendMessageEvent } from './append-event.js';
import { encodeMessageCursor, messageCursor } from './cursor.js';
import {
  ConversationAccessError,
  ConversationConflictError,
  type Conversation,
  type ConversationAccess,
  type ConversationRepository,
  type MessageCommand,
  type MessageReceipt,
  type ConversationPage,
  type ConversationSubject,
  type MessageEditCommand,
  type MessageVersion,
  type MessageTombstoneCommand,
  InvalidConversationInputError,
  type MessageRead,
  conversationUuid,
} from './service.js';

type ConversationRow = {
  id: string;
  workspace_id: string;
  group_id: string | null;
  bot_id: string | null;
  creator_user_id: string;
  created_at: Date;
  last_sequence: number | string;
};
function conversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    subject: row.group_id
      ? { kind: 'group', id: row.group_id }
      : { kind: 'direct-bot', id: row.bot_id! },
    createdAt: row.created_at,
  };
}
async function authorizeSubject(
  connection: SqlConnection,
  actorUserId: string,
  workspaceId: string,
  subject: ConversationSubject,
  permission: 'inspect' | 'use',
): Promise<{ groupRole: GroupRole | null; botLifecycleState?: BotLifecycleState }> {
  try {
    if (subject.kind === 'group')
      return {
        groupRole: (
          await lockAuthorizedGroup(
            connection,
            { actorId: actorUserId, workspaceId, groupId: subject.id },
            'content',
          )
        ).role,
      };
    const bot = await lockAuthorizedBot(
      connection,
      { actorUserId, workspaceId, botId: subject.id },
      permission,
    );
    return { groupRole: null, botLifecycleState: bot.lifecycle_state };
  } catch (error) {
    if (error instanceof GroupAccessError || error instanceof BotAccessError)
      throw new ConversationAccessError();
    throw error;
  }
}

// The caller owns BEGIN/COMMIT/ROLLBACK. Holding this admission keeps the shared
// workspace -> group -> conversation locks through any dependent write/audit.
export class ConversationTransaction {
  private readonly botLifecycleState: BotLifecycleState | undefined;
  private readonly subject: Readonly<ConversationSubject>;
  private readonly createdAt: number;
  private constructor(
    private readonly connection: SqlConnection,
    private readonly access: Readonly<ConversationAccess>,
    metadata: Conversation,
    readonly groupRole: GroupRole | null,
    private readonly now: () => Date,
    private readonly permission: 'inspect' | 'use',
  ) {
    this.subject = Object.freeze({ ...metadata.subject });
    this.botLifecycleState = metadata.botLifecycleState;
    this.createdAt = metadata.createdAt.getTime();
  }
  get metadata(): Conversation {
    // Public response objects never carry the identity used by admitted SQL.
    // Copy Date too: freezing a Date does not prevent its mutating methods.
    return Object.freeze({
      id: this.access.conversationId,
      workspaceId: this.access.workspaceId,
      subject: Object.freeze({ ...this.subject }),
      ...(this.botLifecycleState ? { botLifecycleState: this.botLifecycleState } : {}),
      createdAt: new Date(this.createdAt),
    });
  }
  static async lock(
    connection: SqlConnection,
    access: ConversationAccess,
    now: () => Date = () => new Date(),
    permission: 'inspect' | 'use' = 'use',
  ): Promise<ConversationTransaction> {
    access = Object.freeze({
      actorUserId: conversationUuid(access.actorUserId),
      workspaceId: conversationUuid(access.workspaceId),
      conversationId: conversationUuid(access.conversationId),
    });
    const subject = (
      await connection.query<ConversationRow>(
        'SELECT * FROM conversations WHERE workspace_id=$1 AND id=$2',
        [access.workspaceId, access.conversationId],
      )
    ).rows[0];
    if (!subject) throw new ConversationAccessError();
    if (subject.bot_id && subject.creator_user_id !== access.actorUserId)
      throw new ConversationAccessError();
    const authority = await authorizeSubject(
      connection,
      access.actorUserId,
      access.workspaceId,
      conversation(subject).subject,
      permission,
    );
    const row = (
      await connection.query<ConversationRow>(
        'SELECT * FROM conversations WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
        [access.workspaceId, access.conversationId],
      )
    ).rows[0];
    if (!row) throw new ConversationAccessError();
    return new ConversationTransaction(
      connection,
      access,
      {
        ...conversation(row),
        ...(authority.botLifecycleState ? { botLifecycleState: authority.botLifecycleState } : {}),
      },
      authority.groupRole,
      now,
      permission,
    );
  }
  async attachmentReplay(command: AttachmentCommand) {
    if (this.permission !== 'use') throw new ConversationAccessError();
    const prior = (
      await this.connection.query<{
        id: string;
        message_id: string;
        sequence: number | string;
        command_hash: string;
      }>(
        'SELECT id,message_id,sequence,command_hash FROM conversation_events WHERE conversation_id=$1 AND actor_user_id=$2 AND idempotency_key=$3',
        [this.access.conversationId, this.access.actorUserId, command.idempotencyKey],
      )
    ).rows[0];
    if (!prior) return undefined;
    if (prior.command_hash !== attachmentCommandHash(command))
      throw new ConversationConflictError('idempotency_conflict');
    return { messageId: prior.message_id, eventId: prior.id, sequence: Number(prior.sequence) };
  }
  async appendAttachment(command: AttachmentCommand, objectId: string) {
    const prior = await this.attachmentReplay(command);
    if (prior) return prior;
    const row = (
      await this.connection.query<AttachmentRow>(
        'SELECT * FROM attachment_objects WHERE workspace_id=$1 AND conversation_id=$2 AND id=$3 AND actor_user_id=$4 FOR UPDATE',
        [
          this.access.workspaceId,
          this.access.conversationId,
          conversationUuid(objectId),
          this.access.actorUserId,
        ],
      )
    ).rows[0];
    if (
      !row ||
      row.state !== 'staged' ||
      row.lease_until <= this.now() ||
      row.filename !== command.filename ||
      row.media_type !== command.mediaType ||
      row.bytes !== command.bytes ||
      row.sha256 !== command.sha256
    )
      throw new ConversationAccessError();
    const messageId = randomUUID();
    const receipt = await appendMessageEvent(
      this.connection,
      this.access,
      {
        messageId,
        type: 'message.created',
        body: command.body,
        idempotencyKey: command.idempotencyKey,
        hash: attachmentCommandHash(command),
        version: 1,
        reason: null,
        attachmentId: row.id,
      },
      this.now,
    );
    await this.connection.query(
      "UPDATE attachment_objects SET state='live',message_id=$2,cleanup_after=NULL WHERE id=$1",
      [row.id, messageId],
    );
    return receipt;
  }
  async requestMessagePurge(messageId: string) {
    if (this.permission !== 'use') throw new ConversationAccessError();
    messageId = conversationUuid(messageId);
    const chain = await readMessageEvents(this.connection, this.access.conversationId, messageId);
    const original = chain[0],
      current = chain.at(-1);
    const author =
      original?.event_type === 'message.created' &&
      original.actor_user_id === this.access.actorUserId;
    const moderator = this.groupRole === 'owner' || this.groupRole === 'admin';
    if (!original || original.event_type !== 'message.created' || (!author && !moderator))
      throw new ConversationAccessError();
    const attached = (
      await this.connection.query(
        'SELECT id FROM attachment_objects WHERE workspace_id=$1 AND conversation_id=$2 AND message_id=$3 AND original_id IS NULL',
        [this.access.workspaceId, this.access.conversationId, messageId],
      )
    ).rows[0];
    if (!attached) throw new ConversationAccessError();
    const prior = (
      await this.connection.query<{ state: 'purging' | 'complete' }>(
        'SELECT state FROM message_purges WHERE workspace_id=$1 AND conversation_id=$2 AND message_id=$3',
        [this.access.workspaceId, this.access.conversationId, messageId],
      )
    ).rows[0];
    if (prior) return prior;
    if (current!.event_type !== 'message.deleted')
      await this.tombstone(messageId, {
        idempotencyKey: 'purge-' + randomUUID(),
        expectedVersion: current!.message_version,
        reason: 'Message purged',
      });
    await this.connection.query(
      "INSERT INTO message_purges(workspace_id,conversation_id,message_id,actor_user_id,state,requested_at) VALUES($1,$2,$3,$4,'purging',$5)",
      [
        this.access.workspaceId,
        this.access.conversationId,
        messageId,
        this.access.actorUserId,
        this.now(),
      ],
    );
    await enqueueSourceRevocations(this.connection, {
      workspaceId: this.access.workspaceId,
      conversationId: this.access.conversationId,
      messageId,
      reason: 'source_purged',
      createdAt: this.now(),
    });
    await this.connection.query(
      `UPDATE attachment_objects SET state='purging',
        cleanup_after=CASE WHEN state='staged' THEN lease_until ELSE $4 END,
        lease_until=CASE WHEN state='staged' THEN lease_until ELSE $4 END
        WHERE workspace_id=$1 AND conversation_id=$2 AND message_id=$3 AND state IN ('staged','live')`,
      [this.access.workspaceId, this.access.conversationId, messageId, this.now()],
    );
    await this.connection.query(
      'INSERT INTO audit_events(id,event_type,actor_user_id,occurred_at,metadata) VALUES($1,$2,$3,$4,$5::jsonb)',
      [
        randomUUID(),
        'conversation.message_purge_requested',
        this.access.actorUserId,
        this.now(),
        JSON.stringify({
          workspaceId: this.access.workspaceId,
          conversationId: this.access.conversationId,
          messageId,
        }),
      ],
    );
    return { state: 'purging' as const };
  }
  async messageEligibility(messageId: string) {
    const chain = await readMessageEvents(
      this.connection,
      this.access.conversationId,
      conversationUuid(messageId),
    );
    if (!chain[0] || chain.at(-1)!.event_type === 'message.deleted')
      throw new ConversationAccessError();
    return { creationSequence: Number(chain[0].sequence) };
  }
  async sourceForMemory(messageId: string) {
    if (this.subject.kind !== 'group') throw new ConversationAccessError();
    return selectCurrentMessageSource(
      this.connection,
      {
        workspaceId: this.access.workspaceId,
        conversationId: this.access.conversationId,
        groupId: this.subject.id,
      },
      messageId,
    );
  }
  async attachmentMetadata(messageId: string) {
    await this.messageEligibility(messageId);
    const row = (
      await this.connection.query<AttachmentRow>(
        "SELECT * FROM attachment_objects WHERE workspace_id=$1 AND conversation_id=$2 AND message_id=$3 AND original_id IS NULL AND state='live'",
        [this.access.workspaceId, this.access.conversationId, messageId],
      )
    ).rows[0];
    if (!row) throw new ConversationAccessError();
    return row;
  }
  append(command: MessageCommand) {
    return this.write({ ...command });
  }
  appendTaskTrigger(command: MessageCommand & { groupGrantId: string | null }) {
    return this.write(
      { idempotencyKey: command.idempotencyKey, body: command.body },
      undefined,
      undefined,
      null,
      {
        type: 'task.submit',
        grantId: command.groupGrantId === null ? null : conversationUuid(command.groupGrantId),
      },
    );
  }
  edit(messageId: string, command: MessageEditCommand) {
    return this.write({ ...command }, conversationUuid(messageId), command.expectedVersion);
  }
  tombstone(messageId: string, command: MessageTombstoneCommand) {
    return this.write(
      { idempotencyKey: command.idempotencyKey, body: null },
      conversationUuid(messageId),
      command.expectedVersion,
      command.reason,
    );
  }
  private async write(
    command: { idempotencyKey: string; body: string | null },
    messageId?: string,
    expectedVersion?: number,
    reason: string | null = null,
    taskIntent?: { type: 'task.submit'; grantId: string | null },
  ): Promise<{ receipt: MessageReceipt; replayed: boolean }> {
    if (this.permission !== 'use') throw new ConversationAccessError();
    const chain = messageId
      ? await readMessageEvents(this.connection, this.access.conversationId, messageId)
      : [];
    const original = chain[0],
      current = chain.at(-1);
    const deleting = command.body === null;
    const author = original?.actor_user_id === this.access.actorUserId;
    const moderator = this.groupRole === 'owner' || this.groupRole === 'admin';
    if (
      messageId &&
      (!original ||
        original.event_type !== 'message.created' ||
        (!author && !(deleting && moderator)))
    )
      throw new ConversationAccessError();
    if (deleting && !reason) {
      if (!author) throw new InvalidConversationInputError();
      reason = 'Deleted by author';
    }
    const type = deleting ? 'message.deleted' : messageId ? 'message.edited' : 'message.created';
    const hash = createHash('sha256')
      .update(
        JSON.stringify(
          taskIntent
            ? {
                type: taskIntent.type,
                body: command.body,
                grantId: taskIntent.grantId,
              }
            : {
                type,
                target: messageId ?? null,
                expectedVersion: expectedVersion ?? null,
                body: command.body,
                reason,
              },
        ),
      )
      .digest('hex');
    const prior = (
      await this.connection.query<{
        id: string;
        message_id: string;
        sequence: number | string;
        command_hash: string;
      }>(
        'SELECT id,message_id,sequence,command_hash FROM conversation_events WHERE conversation_id=$1 AND actor_user_id=$2 AND idempotency_key=$3',
        [this.access.conversationId, this.access.actorUserId, command.idempotencyKey],
      )
    ).rows[0];
    if (prior) {
      if (prior.command_hash !== hash) throw new ConversationConflictError('idempotency_conflict');
      return {
        receipt: {
          messageId: prior.message_id,
          eventId: prior.id,
          sequence: Number(prior.sequence),
        },
        replayed: true,
      };
    }
    if (
      current &&
      (current.message_version !== expectedVersion || current.event_type === 'message.deleted')
    )
      throw new ConversationConflictError('message_version_conflict');
    const receipt = await appendMessageEvent(
      this.connection,
      this.access,
      {
        messageId: messageId ?? randomUUID(),
        type,
        body: command.body,
        idempotencyKey: command.idempotencyKey,
        hash,
        version: current ? current.message_version + 1 : 1,
        reason,
      },
      this.now,
    );
    if (type === 'message.deleted' && messageId)
      await enqueueSourceRevocations(this.connection, {
        workspaceId: this.access.workspaceId,
        conversationId: this.access.conversationId,
        messageId,
        reason: 'source_tombstoned',
        createdAt: this.now(),
      });
    return { receipt, replayed: false };
  }
  async read(read: MessageRead): Promise<ConversationPage> {
    if (read.messageId !== undefined && read.cursor !== undefined)
      throw new InvalidConversationInputError();
    const last = (
      await this.connection.query<{ last_sequence: string | number }>(
        'SELECT last_sequence FROM conversations WHERE id=$1',
        [this.access.conversationId],
      )
    ).rows[0]!;
    const cursor = messageCursor(
      read.cursor,
      this.access.conversationId,
      Number(last.last_sequence),
    );
    if (read.messageId !== undefined) {
      const target = (
        await this.connection.query<{ sequence: string | number }>(
          "SELECT sequence FROM conversation_events WHERE conversation_id=$1 AND message_id=$2 AND event_type IN ('message.created','bot.message.created') LIMIT 1",
          [this.access.conversationId, conversationUuid(read.messageId)],
        )
      ).rows[0];
      if (!target) throw new ConversationAccessError();
      // A sequence window contains at most limit message creations, so the
      // requested message is present without scanning earlier pages. The
      // existing projection still returns its current edit/tombstone state.
      cursor.after = Math.max(0, Number(target.sequence) - read.limit);
    }
    const moderator = this.groupRole === 'owner' || this.groupRole === 'admin';
    const page = await currentPage(
      this.connection,
      this.access.conversationId,
      cursor.after,
      cursor.horizon,
      read.limit,
      this.access.actorUserId,
      moderator,
    );
    const canWrite = this.botLifecycleState === undefined || this.botLifecycleState === 'active';
    return {
      conversation: this.metadata,
      canWrite,
      messages: canWrite
        ? page.messages
        : page.messages.map((message) => ({ ...message, canEdit: false, canDelete: false })),
      nextCursor: page.hasMore
        ? encodeMessageCursor({ ...cursor, after: page.messages.at(-1)!.creationSequence })
        : null,
    };
  }
  async versions(messageId: string): Promise<MessageVersion[]> {
    const chain = await readMessageEvents(this.connection, this.access.conversationId, messageId);
    if (
      !chain[0] ||
      chain[0].event_type !== 'message.created' ||
      (chain[0].actor_user_id !== this.access.actorUserId &&
        this.groupRole !== 'owner' &&
        this.groupRole !== 'admin')
    )
      throw new ConversationAccessError();
    const purge = (
      await this.connection.query(
        'SELECT state FROM message_purges WHERE workspace_id=$1 AND conversation_id=$2 AND message_id=$3',
        [this.access.workspaceId, this.access.conversationId, messageId],
      )
    ).rows[0];
    if (purge) throw new ConversationAccessError();
    return chain.map(messageVersion);
  }
}

export class PostgresConversationRepository implements ConversationRepository {
  constructor(
    private readonly pool: SqlPool,
    private readonly now: () => Date = () => new Date(),
  ) {}
  private async transaction<T>(operation: (connection: SqlConnection) => Promise<T>): Promise<T> {
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      const result = await operation(connection);
      await connection.query('COMMIT');
      return result;
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }
  open(
    actorUserId: string,
    workspaceId: string,
    subject: ConversationSubject,
  ): Promise<Conversation> {
    return this.transaction(async (connection) => {
      const authority = await authorizeSubject(
        connection,
        actorUserId,
        workspaceId,
        subject,
        'inspect',
      );
      const opened = await openAdmittedConversation(
        connection,
        actorUserId,
        workspaceId,
        subject,
        this.now,
      );
      return {
        ...opened,
        ...(authority.botLifecycleState ? { botLifecycleState: authority.botLifecycleState } : {}),
      };
    });
  }
  append(access: ConversationAccess, command: MessageCommand): Promise<MessageReceipt> {
    return this.transaction(async (connection) => {
      const admission = await ConversationTransaction.lock(connection, access, this.now);
      return (await admission.append(command)).receipt;
    });
  }
  get(access: ConversationAccess, read: MessageRead): Promise<ConversationPage> {
    return this.transaction(async (connection) =>
      (await ConversationTransaction.lock(connection, access, this.now, 'inspect')).read(read),
    );
  }
  edit(
    access: ConversationAccess,
    messageId: string,
    command: MessageEditCommand,
  ): Promise<MessageReceipt> {
    return this.transaction(
      async (connection) =>
        (
          await (
            await ConversationTransaction.lock(connection, access, this.now)
          ).edit(messageId, command)
        ).receipt,
    );
  }
  versions(access: ConversationAccess, messageId: string): Promise<MessageVersion[]> {
    return this.transaction(async (connection) =>
      (await ConversationTransaction.lock(connection, access, this.now, 'inspect')).versions(
        messageId,
      ),
    );
  }
  tombstone(
    access: ConversationAccess,
    messageId: string,
    command: MessageTombstoneCommand,
  ): Promise<MessageReceipt> {
    return this.transaction(
      async (connection) =>
        (
          await (
            await ConversationTransaction.lock(connection, access, this.now)
          ).tombstone(messageId, command)
        ).receipt,
    );
  }
}

// Membership callers already hold fresh workspace/group/Bot admission in their
// existing transaction. This only opens that group's ledger, never content access.
export function openGroupMembershipConversation(
  connection: SqlConnection,
  actorUserId: string,
  workspaceId: string,
  groupId: string,
  now: () => Date,
) {
  return openAdmittedConversation(
    connection,
    actorUserId,
    workspaceId,
    { kind: 'group', id: groupId },
    now,
  );
}
async function openAdmittedConversation(
  connection: SqlConnection,
  actorUserId: string,
  workspaceId: string,
  subject: ConversationSubject,
  now: () => Date,
): Promise<Conversation> {
  const existing = (
    await connection.query<ConversationRow>(
      subject.kind === 'group'
        ? 'SELECT * FROM conversations WHERE workspace_id=$1 AND group_id=$2'
        : 'SELECT * FROM conversations WHERE workspace_id=$1 AND bot_id=$2 AND creator_user_id=$3',
      subject.kind === 'group' ? [workspaceId, subject.id] : [workspaceId, subject.id, actorUserId],
    )
  ).rows[0];
  if (existing) return conversation(existing);
  if (subject.kind === 'direct-bot')
    await authorizeSubject(connection, actorUserId, workspaceId, subject, 'use');
  const id = randomUUID(),
    occurredAt = now();
  await connection.query(
    'INSERT INTO conversations (id,workspace_id,group_id,bot_id,creator_user_id,created_at) VALUES ($1,$2,$3,$4,$5,$6)',
    [
      id,
      workspaceId,
      subject.kind === 'group' ? subject.id : null,
      subject.kind === 'direct-bot' ? subject.id : null,
      actorUserId,
      occurredAt,
    ],
  );
  await connection.query(
    "INSERT INTO audit_events (id,event_type,actor_user_id,occurred_at,metadata) VALUES ($1,'conversation.created',$2,$3,$4::jsonb)",
    [
      randomUUID(),
      actorUserId,
      occurredAt,
      JSON.stringify({ workspaceId, conversationId: id, subject }),
    ],
  );
  return { id, workspaceId, subject, createdAt: occurredAt };
}
