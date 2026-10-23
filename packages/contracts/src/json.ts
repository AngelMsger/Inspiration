/** Canonical JSON: object keys sorted at every level, undefined fields dropped. Stable input for hashes. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, (v as Record<string, unknown>)[k]]),
    );
  });
}
