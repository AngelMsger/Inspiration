// Changing whom the page acts as, or the company it works in. The requests that set or read the
// backend's person go out one at a time, in the order they were asked for, so the backend ends
// on the person picked last. Only the latest change reaches the screen: a slow answer, or a
// failure, for someone picked earlier never replaces the person picked last, so the screen shows
// whom the backend acts as. While a change is on its way the page is busy, and the frame still on
// screen takes no clicks: the backend may already act for the next company, so nothing done there
// would go to the company it shows.

/** What a change gave, or nothing when a later change replaced it. */
export type Switched<T> = { value: T } | undefined;

/**
 * A run of changes. Each takes `ask`, the request that sets or reads the backend's person, and
 * `follow`, what the screen reads for that person. Its promise gives the result, or rejects with
 * the failure, only while no later change has been asked for; otherwise it gives nothing.
 * `busy` hears true when a change is asked for and false once the latest one has settled.
 */
export function switcher(busy: (on: boolean) => void = () => {}) {
  let latest = 0;
  let line: Promise<unknown> = Promise.resolve();
  return <S, T>(ask: () => Promise<S>, follow: (asked: S) => Promise<T>): Promise<Switched<T>> => {
    const mine = ++latest;
    busy(true);
    const asked = line.then(ask);
    line = asked.catch(() => undefined);
    return asked.then(follow).then(
      (value) => {
        if (mine !== latest) return undefined;
        busy(false);
        return { value };
      },
      (error: unknown) => {
        if (mine !== latest) return undefined;
        busy(false);
        throw error;
      },
    );
  };
}

/** Who something was read for: a member of one company. */
export interface ReadFor {
  tenant: string;
  member: string;
}

/**
 * What was read ahead for the frame of `current`, when it was read for that member of that
 * company. A member ID names a member within a company, so the member alone does not do.
 */
export function keptFor<T extends ReadFor>(
  kept: T | undefined,
  current: { tenant_id: string; member_id: string } | undefined,
): T | undefined {
  return kept && current && kept.tenant === current.tenant_id && kept.member === current.member_id ? kept : undefined;
}
