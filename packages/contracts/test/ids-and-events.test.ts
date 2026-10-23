import { describe, expect, test } from "vitest";
import {
  ContractError,
  combineHashes,
  contentHash,
  EVENT_PAYLOAD_TYPES,
  EVENT_TYPES,
  EVENT_VERSIONS,
  isEventType,
  kindOf,
  newEvent,
  newId,
  PREFIXES,
  payloadOf,
  stableId,
  validatorFor,
} from "../src/index.ts";

describe("ids", () => {
  test("new IDs carry their kind's prefix and a ULID", () => {
    const a = newId("claim");
    const b = newId("claim");
    expect(a).toMatch(/^clm_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a).not.toBe(b);
    expect(kindOf(a)).toBe("claim");
  });

  test("IDs from one millisecond sort by time", () => {
    const earlier = newId("event");
    const later = newId("event");
    expect(earlier.slice(0, 14) <= later.slice(0, 14)).toBe(true);
  });

  test("stable IDs are deterministic and separate their parts", () => {
    expect(stableId("span", "sv_x", "blk-1", "0:12")).toBe(stableId("span", "sv_x", "blk-1", "0:12"));
    expect(stableId("span", "a", "bc")).not.toBe(stableId("span", "ab", "c"));
  });

  test("kindOf rejects an unknown prefix", () => {
    expect(() => kindOf("zzz_01JC0000000000000000000001")).toThrow(RangeError);
  });

  test("every prefix is distinct", () => {
    const prefixes = Object.values(PREFIXES);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  test("content hashes", () => {
    expect(contentHash("住宿")).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(contentHash("住宿")).toBe(contentHash(new TextEncoder().encode("住宿")));
    expect(combineHashes("a", "b")).not.toBe(combineHashes("b", "a"));
  });
});

describe("events", () => {
  const tenantId = newId("tenant");
  const fetched = newEvent(
    "document.fetched",
    {
      source_id: newId("source"),
      source_version_id: newId("source_version"),
      external_id: "doxcn123",
      changed: { content: true, metadata: false, acl: false },
      deleted: false,
    },
    { tenantId, producer: "source-sync" },
  );

  test("an event round-trips through its envelope", () => {
    const payload = { origin: "extracted" as const, added: [newId("claim")], updated: [], superseded: [] };
    const event = newEvent("claims.updated", payload, { tenantId, producer: "extraction", causation: fetched });
    expect(event.type).toBe("claims.updated");
    expect(event.version).toBe(EVENT_VERSIONS["claims.updated"]);
    expect(event.causation_id).toBe(fetched.id);
    expect(event.correlation_id).toBe(fetched.id);
    expect(payloadOf(event, "claims.updated")).toEqual(payload);
    expect(() => payloadOf(event, "document.fetched")).toThrow(TypeError);
  });

  test("undefined fields are dropped from the data", () => {
    const event = newEvent(
      "claims.updated",
      { origin: "extracted", added: [], updated: [], superseded: [], source_version_id: undefined },
      { tenantId, producer: "extraction" },
    );
    expect(Object.keys(event.data)).not.toContain("source_version_id");
    expect(JSON.parse(JSON.stringify(event))).toEqual(event);
  });

  test("an invalid payload or producer is refused", () => {
    expect(() =>
      newEvent("claims.updated", { origin: "guessed" } as never, { tenantId, producer: "extraction" }),
    ).toThrow(ContractError);
    expect(() => newEvent("review.due", {} as never, { tenantId, producer: "Freshness" })).toThrow(ContractError);
  });

  test("every event type has a payload schema", () => {
    expect(Object.keys(EVENT_PAYLOAD_TYPES)).toEqual([...EVENT_TYPES]);
    for (const type of EVENT_TYPES) {
      expect(isEventType(type)).toBe(true);
      expect(() => validatorFor(EVENT_PAYLOAD_TYPES[type])).not.toThrow();
    }
    expect(isEventType("claims.deleted")).toBe(false);
  });
});
