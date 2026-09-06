const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function uuid(value: unknown): string | undefined {
  return typeof value === 'string' && UUID_RE.test(value) ? value.toLowerCase() : undefined;
}

function actionArguments(input: unknown, name: string): Record<string, unknown> | undefined {
  if (!object(input) || input.type !== 'action' || input.name !== name) return undefined;
  if (typeof input.id !== 'string' || !input.id) return undefined;
  const extra = Object.keys(input).filter(
    (key) => !['type', 'id', 'name', 'arguments'].includes(key),
  );
  if (extra.length || !object(input.arguments)) return undefined;
  return input.arguments;
}

export interface CreateRoutineAction {
  groupId: string;
  prompt: string;
  timeZone: string;
  executeAt: string;
  expiresAt: string;
  maxCostMicros: number;
  leadGrantId?: string;
}

export interface EditRoutineAction {
  routineId: string;
  maxCostMicros?: number;
  cron?: string;
  frequency?: string;
  interval?: string;
  prompt?: string;
  timeZone?: string;
  executeAt?: string;
  expiresAt?: string;
}

export function parseCreateRoutineAction(input: unknown): CreateRoutineAction | undefined {
  const args = actionArguments(input, 'create_routine');
  if (!args) return undefined;
  const groupId = uuid(args.groupId);
  const leadGrantId = args.leadGrantId === undefined ? undefined : uuid(args.leadGrantId);
  if (
    !groupId ||
    typeof args.prompt !== 'string' ||
    !args.prompt.trim() ||
    args.prompt.length > 32000 ||
    typeof args.timeZone !== 'string' ||
    !args.timeZone ||
    typeof args.executeAt !== 'string' ||
    typeof args.expiresAt !== 'string' ||
    typeof args.maxCostMicros !== 'number' ||
    !Number.isInteger(args.maxCostMicros) ||
    args.maxCostMicros <= 0 ||
    (args.leadGrantId !== undefined && !leadGrantId)
  )
    return undefined;
  return {
    groupId,
    prompt: args.prompt,
    timeZone: args.timeZone,
    executeAt: args.executeAt,
    expiresAt: args.expiresAt,
    maxCostMicros: args.maxCostMicros,
    ...(leadGrantId ? { leadGrantId } : {}),
  };
}

export function parseEditRoutineAction(input: unknown): EditRoutineAction | undefined {
  const args = actionArguments(input, 'edit_routine');
  if (!args) return undefined;
  const routineId = uuid(args.routineId);
  if (!routineId) return undefined;
  const next: EditRoutineAction = { routineId };
  if (args.maxCostMicros !== undefined) {
    if (
      typeof args.maxCostMicros !== 'number' ||
      !Number.isInteger(args.maxCostMicros) ||
      args.maxCostMicros <= 0
    )
      return undefined;
    next.maxCostMicros = args.maxCostMicros;
  }
  if (args.cron !== undefined) {
    if (typeof args.cron !== 'string' || !args.cron.trim()) return undefined;
    next.cron = args.cron.trim();
  }
  if (args.frequency !== undefined) {
    if (typeof args.frequency !== 'string' || !args.frequency.trim()) return undefined;
    next.frequency = args.frequency.trim();
  }
  if (args.interval !== undefined) {
    if (typeof args.interval !== 'string' || !args.interval.trim()) return undefined;
    next.interval = args.interval.trim();
  }
  if (args.prompt !== undefined) {
    if (typeof args.prompt !== 'string' || !args.prompt.trim()) return undefined;
    next.prompt = args.prompt;
  }
  if (args.timeZone !== undefined) {
    if (typeof args.timeZone !== 'string' || !args.timeZone) return undefined;
    next.timeZone = args.timeZone;
  }
  if (args.executeAt !== undefined) {
    if (typeof args.executeAt !== 'string') return undefined;
    next.executeAt = args.executeAt;
  }
  if (args.expiresAt !== undefined) {
    if (typeof args.expiresAt !== 'string') return undefined;
    next.expiresAt = args.expiresAt;
  }
  return next;
}

/** Bot collaboration actions may not create routines or escalate frequency/budget. */
export function botRoutineCollaborationDenial(input: unknown): 'create' | 'escalate' | undefined {
  if (parseCreateRoutineAction(input)) return 'create';
  const edit = parseEditRoutineAction(input);
  if (!edit) return undefined;
  if (
    edit.maxCostMicros !== undefined ||
    edit.cron !== undefined ||
    edit.frequency !== undefined ||
    edit.interval !== undefined
  )
    return 'escalate';
  return undefined;
}
