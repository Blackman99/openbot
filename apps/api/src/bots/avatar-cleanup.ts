/** At most one batch per minute; shutdown drains the bounded in-flight batch. */
export function startAvatarCleanup(
  cleanup: () => Promise<unknown>,
  onError: () => void,
): () => Promise<void> {
  let active: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (active) return;
    active = Promise.resolve()
      .then(cleanup)
      .then(
        () => {},
        () => onError(),
      )
      .finally(() => {
        active = undefined;
      });
  }, 60_000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await active;
  };
}
