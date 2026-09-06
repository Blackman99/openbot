import type { ExecutionLimitPolicy, ResolvedExecutionLimits } from './execution-limits.js';

export const DELEGATE_TOOL_NAME = 'delegate';

export const DELEGATE_TOOL = Object.freeze({
  name: DELEGATE_TOOL_NAME,
  description: 'Create one bounded child Task for an active Bot in the current group.',
  parameters: Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: Object.freeze(['grantId', 'body']),
    properties: Object.freeze({
      grantId: Object.freeze({ type: 'string', format: 'uuid' }),
      body: Object.freeze({ type: 'string', minLength: 1, maxLength: 8000 }),
    }),
  }),
});

export function inheritChildLimits(input: {
  parent: ResolvedExecutionLimits;
  parentRemainingDurationMs?: number;
  bot: ExecutionLimitPolicy;
}): ResolvedExecutionLimits | undefined {
  if (!input.parent.duration || !input.parent.turns || !input.parent.delegationDepth)
    return undefined;
  const remainingSeconds = Math.max(
    0,
    Math.floor((input.parentRemainingDurationMs ?? input.parent.duration.maxDurationMs) / 1000),
  );
  const durationSeconds = minimum([remainingSeconds, input.bot.maxDurationSeconds]);
  const maxTurns = minimum([input.parent.turns.maxTurns, input.bot.maxTurns]);
  const maxDelegationDepth = minimum([
    input.parent.delegationDepth.maxDelegationDepth,
    input.bot.maxDelegationDepth,
  ]);
  if (durationSeconds === undefined || durationSeconds < 1 || maxTurns === undefined)
    return undefined;
  if (maxDelegationDepth === undefined) return undefined;
  return {
    duration: { maxDurationMs: durationSeconds * 1000, source: 'task' },
    turns: { maxTurns, source: 'task' },
    delegationDepth: { maxDelegationDepth, source: 'task' },
    ...(input.parent.handoffs
      ? { handoffs: { maxHandoffs: input.parent.handoffs.maxHandoffs, source: 'task' } }
      : {}),
  };
}

export type ChildResultOutcome =
  | { status: 'completed'; body: string }
  | { status: 'failed'; error: string }
  | { status: 'cancelled' };

export type ChildResultInput = {
  childTaskId: string;
  botName: string;
  outcome: ChildResultOutcome;
};

export type JoinableChildResult = ChildResultInput & { createdAt: string };

export const CHILD_RESULT_DISAGREEMENT =
  'These results disagree or are incomplete. State the disagreement; do not present them as consensus.';

export function attributedChildResult(input: ChildResultInput): string {
  const header = `Delegated child ${input.childTaskId} (${input.botName})`;
  if (input.outcome.status === 'completed') return `${header} completed:\n${input.outcome.body}`;
  if (input.outcome.status === 'failed') return `${header} failed: ${input.outcome.error}`;
  return `${header} was cancelled.`;
}

export function joinChildResults(children: readonly JoinableChildResult[]): string {
  const ordered = [...children].sort((left, right) => {
    if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
    return left.childTaskId < right.childTaskId ? -1 : left.childTaskId > right.childTaskId ? 1 : 0;
  });
  const parts = ordered.map((child) => attributedChildResult(child));
  if (ordered.length < 2) return parts[0] ?? '';
  const completed = ordered.filter((child) => child.outcome.status === 'completed');
  const bodies = new Set(
    completed.map((child) => (child.outcome.status === 'completed' ? child.outcome.body : '')),
  );
  const agreed = completed.length === ordered.length && bodies.size === 1;
  const joined = parts.join('\n\n');
  return agreed ? joined : `${joined}\n\n${CHILD_RESULT_DISAGREEMENT}`;
}

function minimum(values: Array<number | undefined>): number | undefined {
  let selected: number | undefined;
  for (const value of values) {
    if (value === undefined) continue;
    selected = selected === undefined ? value : Math.min(selected, value);
  }
  return selected;
}
