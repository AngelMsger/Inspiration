import { applyMigrations, openPool } from "@inspiration/kernel";
import { createTestDatabase, hasStack } from "@inspiration/testkit";
import { describe, expect, onTestFinished, test } from "vitest";
import { MIGRATIONS, PostgresStore } from "../src/index.ts";
import { Sample } from "../src/testing.ts";

describe.skipIf(!hasStack())("kb migrations", () => {
  test("claims stored before slot keys get the key their predicate, qualifiers and subject make", async () => {
    const db = await createTestDatabase();
    const pool = await openPool(db.url);
    onTestFinished(async () => {
      await pool.end();
      await db.drop();
    });
    const store = new PostgresStore(pool);
    const kb = new Sample();
    const [sv, spans] = kb.sourceVersion([
      "The first-tier hotel cap is 600 a night.",
      "The cap for the head office is 900 a night.",
      "Expense claims are due within 30 days.",
    ]);
    const money = (n: number) => ({
      kind: "money" as const,
      number: n,
      unit: "CNY/night",
      normalized: `${n} CNY/night`,
    });
    const [cap, capEvidence] = kb.claim("The first-tier hotel cap is 600 a night", spans[0], {
      predicate: "hotel_cap_per_night",
      qualifiers: ["tier_1", "domestic"],
      value: money(600),
    });
    const [office, officeEvidence] = kb.claim("The head office hotel cap is 900 a night", spans[1], {
      predicate: "hotel_cap_per_night",
      subject_entity_id: "ent_01JC0000000000000HEADOFFICE",
      value: money(900),
    });
    const [loose, looseEvidence] = kb.claim("Expense claims are due within 30 days", spans[2]);
    await store.transaction(async (tx) => {
      await tx.putSourceVersion(sv, spans);
      await tx.upsertClaims([cap, office, loose], [...capEvidence, ...officeEvidence, ...looseEvidence]);
    });

    // The database as it was before 0004: no column, no index, no ledger row.
    await pool.query("DROP INDEX kb.claims_slot");
    await pool.query("ALTER TABLE kb.claims DROP COLUMN slot_key");
    await pool.query("DELETE FROM public.inspiration_migrations WHERE component = 'kb' AND version = '0004_slots'");
    expect(await applyMigrations(db.url, [MIGRATIONS])).toEqual(["kb/0004_slots"]);

    const { rows } = await pool.query<{ id: string; slot_key: string | null }>(
      'SELECT id, slot_key FROM kb.claims ORDER BY id COLLATE "C"',
    );
    expect(Object.fromEntries(rows.map((r) => [r.id, r.slot_key]))).toEqual({
      [cap.id]: "hotel_cap_per_night|domestic|tier_1",
      [office.id]: "ent_01JC0000000000000HEADOFFICE/hotel_cap_per_night",
      [loose.id]: null,
    });
    expect((await store.slot(kb.tenantId, "hotel_cap_per_night|domestic|tier_1"))?.variants).toHaveLength(1);
  });
});
