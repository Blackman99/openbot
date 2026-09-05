export interface TaskPartialOutput {
  conversationId: string;
  taskId: string;
  runId: string;
  partial: { text: string; endByte: number; interrupted: true } | null;
}
function keys(value: unknown, expected: string): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === expected
  );
}
function sameId(value: unknown, expected: string): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value) &&
    value.toLowerCase() === expected.toLowerCase()
  );
}
export function parseTaskPartialOutput(
  value: unknown,
  scope: { conversationId: string; taskId: string; runId: string },
): TaskPartialOutput | undefined {
  if (
    !keys(value, 'conversationId,partial,runId,taskId') ||
    !sameId(value.conversationId, scope.conversationId) ||
    !sameId(value.taskId, scope.taskId) ||
    !sameId(value.runId, scope.runId)
  )
    return undefined;
  let partial: TaskPartialOutput['partial'] = null;
  if (value.partial !== null) {
    const item = value.partial;
    if (
      !keys(item, 'endByte,interrupted,text') ||
      typeof item.text !== 'string' ||
      item.text.length < 1 ||
      item.text.length > 32000 ||
      item.interrupted !== true ||
      typeof item.endByte !== 'number' ||
      !Number.isSafeInteger(item.endByte) ||
      item.endByte < 1 ||
      item.endByte > 128000
    )
      return undefined;
    const bytes = new TextEncoder().encode(item.text);
    if (
      bytes.byteLength !== item.endByte ||
      new TextDecoder('utf-8', { fatal: true }).decode(bytes) !== item.text
    )
      return undefined;
    partial = { text: item.text, endByte: item.endByte, interrupted: true };
  }
  return {
    conversationId: value.conversationId.toLowerCase(),
    taskId: value.taskId.toLowerCase(),
    runId: value.runId.toLowerCase(),
    partial,
  };
}
