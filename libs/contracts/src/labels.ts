/** Sensitivity label order. Every component compares labels through these helpers. */

import type { SensitivityLabel } from "./generated.ts";

export const SENSITIVITY_ORDER: Readonly<Record<SensitivityLabel, number>> = {
  public: 0,
  internal: 1,
  confidential: 2,
  secret: 3,
};

export function rank(label: SensitivityLabel): number {
  return SENSITIVITY_ORDER[label];
}

/** True when something cleared for `clearance` may see content labelled `content`. */
export function allows(clearance: SensitivityLabel, content: SensitivityLabel): boolean {
  return SENSITIVITY_ORDER[content] <= SENSITIVITY_ORDER[clearance];
}

export function maxLabel(first: SensitivityLabel, ...rest: SensitivityLabel[]): SensitivityLabel {
  return rest.reduce((a, b) => (SENSITIVITY_ORDER[b] > SENSITIVITY_ORDER[a] ? b : a), first);
}
