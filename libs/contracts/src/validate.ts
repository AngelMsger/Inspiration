/**
 * Runtime validation against the contracts and against ad-hoc JSON Schemas (structured
 * model output, tool arguments). Types are erased at runtime, so data that crosses a
 * process boundary (HTTP bodies, event envelopes, stored documents from another version)
 * is checked here before it is trusted.
 */

import { readFileSync } from "node:fs";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { ContractError } from "./errors.ts";

export interface SchemaBundle {
  $id: string;
  $defs: Record<string, Record<string, unknown>>;
  "x-events": Record<string, { payload: string; version: number; description?: string }>;
  "x-files": Record<string, string[]>;
}

/** The bundled schema (dist/inspiration.schema.json). */
export const BUNDLE: SchemaBundle = JSON.parse(
  readFileSync(new URL("../dist/inspiration.schema.json", import.meta.url), "utf8"),
);

function newAjv(): Ajv2020 {
  // Not strict: the bundle carries annotation keywords (discriminator, x-events) that a
  // strict validator would reject, and caller schemas are written by people and models.
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats.default(ajv);
  return ajv;
}

const contracts = newAjv();
contracts.addSchema(BUNDLE);
const adHoc = newAjv();
const adHocCache = new Map<string, ValidateFunction>();
const AD_HOC_CACHE_SIZE = 500;

function format(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((e) => `${e.instancePath || "(root)"}: ${e.message ?? "is invalid"}`);
}

/** The compiled validator of one contract type, for example validatorFor("Claim"). */
export function validatorFor(typeName: string): ValidateFunction {
  if (!(typeName in BUNDLE.$defs)) throw new RangeError(`no contract type ${typeName}`);
  const fn = contracts.getSchema(`${BUNDLE.$id}#/$defs/${typeName}`);
  if (fn === undefined) throw new RangeError(`no contract type ${typeName}`);
  return fn;
}

/** Problems with a value as an instance of a contract type; empty when it is valid. */
export function contractErrors(typeName: string, value: unknown): string[] {
  const fn = validatorFor(typeName);
  return fn(value) ? [] : format(fn.errors);
}

/** The value, typed, when it is a valid instance of the contract type. Throws ContractError otherwise. */
export function parseAs<T>(typeName: string, value: unknown): T {
  const errors = contractErrors(typeName, value);
  if (errors.length) throw new ContractError(typeName, errors);
  return value as T;
}

/** A standalone JSON Schema for one contract type, with every definition it may reference. */
export function schemaOf(typeName: string): Record<string, unknown> {
  validatorFor(typeName);
  return { $schema: "https://json-schema.org/draft/2020-12/schema", $defs: BUNDLE.$defs, $ref: `#/$defs/${typeName}` };
}

/** Problems with a value against an arbitrary JSON Schema (draft 2020-12); empty when it is valid. */
export function schemaErrors(schema: object, value: unknown): string[] {
  const key = JSON.stringify(schema);
  let fn = adHocCache.get(key);
  if (fn === undefined) {
    fn = adHoc.compile(schema);
    if (adHocCache.size >= AD_HOC_CACHE_SIZE) adHocCache.delete(adHocCache.keys().next().value as string);
    adHocCache.set(key, fn);
  }
  return fn(value) ? [] : format(fn.errors);
}
