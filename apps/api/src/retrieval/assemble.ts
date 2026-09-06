export const CONTEXT_BUDGET_BYTES = 1048576;
// Documented RET-01 drop order. System rules are always kept complete; later
// kinds are omitted rather than truncated when the shared byte budget is full.
export const CONTEXT_PRIORITY = ['system', 'memory', 'knowledge', 'ledger'] as const;
export type ContextKind = (typeof CONTEXT_PRIORITY)[number];

export interface ContextItem {
  readonly kind: ContextKind;
  readonly id: string;
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
  readonly sourceId?: string;
  readonly scope?: string;
  readonly version?: number;
  readonly locator?: string;
}

export interface AssembledContext {
  readonly items: readonly ContextItem[];
  readonly messages: ReadonlyArray<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  readonly bytes: number;
  readonly dropped: readonly ContextKind[];
}

function itemBytes(item: ContextItem): number {
  return Buffer.byteLength(item.content);
}

export function assembleRunContext(
  items: readonly ContextItem[],
  budgetBytes = CONTEXT_BUDGET_BYTES,
): AssembledContext {
  const ordered = items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const kind =
        CONTEXT_PRIORITY.indexOf(left.item.kind) - CONTEXT_PRIORITY.indexOf(right.item.kind);
      return kind !== 0 ? kind : left.index - right.index;
    })
    .map(({ item }) => item);
  const selected: ContextItem[] = [];
  const dropped: ContextKind[] = [];
  let bytes = 0;
  for (const item of ordered) {
    const size = itemBytes(item);
    if (item.kind === 'system') {
      selected.push(item);
      bytes += size;
      continue;
    }
    if (bytes + size > budgetBytes) {
      if (!dropped.includes(item.kind)) dropped.push(item.kind);
      continue;
    }
    selected.push(item);
    bytes += size;
  }
  return {
    items: selected,
    messages: selected.map((item) => ({ role: item.role, content: item.content })),
    bytes,
    dropped,
  };
}
