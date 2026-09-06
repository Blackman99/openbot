import type { SqlConnection } from '../auth/postgres-auth-repository.js';

type TreeNode = {
  id: string;
  root_task_id: string;
  parent_task_id: string | null;
  depth: number;
  status: string;
};
async function ancestry(connection: SqlConnection, taskId: string): Promise<TreeNode[]> {
  const nodes = (
    await connection.query<TreeNode>(
      'SELECT id,root_task_id,parent_task_id,depth,status FROM tasks WHERE root_task_id=(SELECT root_task_id FROM tasks WHERE id=$1)',
      [taskId],
    )
  ).rows;
  const byId = new Map(nodes.map((node) => [node.id, node])),
    seen = new Set<string>(),
    path: TreeNode[] = [];
  let current = byId.get(taskId);
  if (!current) throw new Error('Retained Task ancestry missing');
  const rootId = current.root_task_id;
  while (current) {
    if (seen.has(current.id) || current.root_task_id !== rootId)
      throw new Error('Invalid retained Task ancestry');
    seen.add(current.id);
    path.push(current);
    if (current.parent_task_id === null) {
      if (current.id !== rootId || current.depth !== 0)
        throw new Error('Invalid retained Task root');
      return path;
    }
    const parent = byId.get(current.parent_task_id);
    if (!parent || parent.depth !== current.depth - 1)
      throw new Error('Invalid retained Task depth');
    current = parent;
  }
  throw new Error('Retained Task root missing');
}
export async function taskAncestryIsActive(
  connection: SqlConnection,
  taskId: string,
): Promise<boolean> {
  return (await ancestry(connection, taskId)).every(
    (node) =>
      node.status !== 'cancelled' &&
      node.status !== 'paused' &&
      node.status !== 'waiting_budget' &&
      node.status !== 'waiting_input' &&
      node.status !== 'waiting_approval',
  );
}
// Scope/conversation locks come first. Root then ordered ancestors precede every
// current Run lock, matching subtree cancellation and native publication fences.
export async function lockTaskAncestry(
  connection: SqlConnection,
  taskId: string,
  options: { allowPausedTarget?: boolean } = {},
): Promise<boolean> {
  const root = (
    await connection.query<{ root_task_id: string }>('SELECT root_task_id FROM tasks WHERE id=$1', [
      taskId,
    ])
  ).rows[0];
  if (!root) throw new Error('Retained Task missing');
  await connection.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE', [root.root_task_id]);
  const path = await ancestry(connection, taskId);
  for (const node of [...path].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)))
    if (node.id !== root.root_task_id)
      await connection.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE', [node.id]);
  return path.every((node) => {
    if (node.status === 'cancelled') return false;
    if (
      node.status === 'paused' ||
      node.status === 'waiting_budget' ||
      node.status === 'waiting_input' ||
      node.status === 'waiting_approval'
    )
      return Boolean(options.allowPausedTarget && node.id === taskId);
    return true;
  });
}
