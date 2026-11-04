// Changing whom the page acts as. The requests that set or read the backend's person go out one
// at a time, in the order they were asked for, so the backend ends on the person picked last.
// Only the latest change reaches the screen: a slow answer, or a failure, for someone picked
// earlier never replaces the person picked last, so the screen shows whom the backend acts as.

/** What a change gave, or nothing when a later change replaced it. */
export type Switched<T> = { value: T } | undefined;

/**
 * A run of changes. Each takes `ask`, the request that sets or reads the backend's person, and
 * `follow`, what the screen reads for that person. Its promise gives the result, or rejects with
 * the failure, only while no later change has been asked for; otherwise it gives nothing.
 */
export function switcher() {
  let latest = 0;
  let line: Promise<unknown> = Promise.resolve();
  return <S, T>(ask: () => Promise<S>, follow: (asked: S) => Promise<T>): Promise<Switched<T>> => {
    const mine = ++latest;
    const asked = line.then(ask);
    line = asked.catch(() => undefined);
    return asked.then(follow).then(
      (value) => (mine === latest ? { value } : undefined),
      (error: unknown) => {
        if (mine === latest) throw error;
        return undefined;
      },
    );
  };
}
