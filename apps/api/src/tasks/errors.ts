export class TaskInputError extends Error {}
export class TaskAccessError extends Error {}
export class TaskConflictError extends Error {
  constructor(readonly code = 'idempotency_conflict') {
    super(code);
  }
}
