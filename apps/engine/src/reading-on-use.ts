/** Answer-time reading uses the same extraction and idempotent governance handlers as background delivery. */
import type { Citation, Principal } from "@inspiration/contracts";
import type { Extraction } from "@inspiration/extraction";
import type { Freshness } from "@inspiration/freshness";
import type { Governance } from "@inspiration/governance";

const CITATIONS_PER_READ = 12;

export async function readForAnswer(
  components: { extraction: Extraction; governance: Governance; freshness: Freshness },
  citations: readonly Citation[],
  who: Principal,
): Promise<boolean> {
  const results = await components.extraction.extractCitations(
    who.tenant_id,
    citations.slice(0, CITATIONS_PER_READ),
    async (event) => {
      await components.governance.onClaimsUpdated(event);
      await components.freshness.onClaimsUpdated(event);
    },
  );
  // Another reader may have committed the same claims while this one waited for the document.
  return results.some((result) => result.windows > 0);
}
