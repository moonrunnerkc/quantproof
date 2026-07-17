/**
 * json-schema scorer: output must parse as JSON and satisfy the pack's
 * declared JSON Schema. Binary score. Details carry every violation and
 * whether the JSON had to be extracted from fences or prose.
 */

import { Ajv } from 'ajv';
import type { ValidateFunction } from 'ajv';
import { extractJson } from './extract-json.js';
import { requireObject } from './scorer-params.js';
import type { ScoreRecord, ScorerParams } from './scorer-registry.js';

const ajv = new Ajv({ allErrors: true, strict: false });

// Schemas come from pack files that are parsed once per load but scored
// thousands of times; cache compiled validators per schema object.
const compiled = new WeakMap<object, ValidateFunction>();

function compileSchema(schema: Readonly<Record<string, unknown>>): ValidateFunction {
  const cached = compiled.get(schema);
  if (cached !== undefined) {
    return cached;
  }
  let validate: ValidateFunction;
  try {
    validate = ajv.compile(schema);
  } catch (err) {
    throw new Error(
      `scorer "json-schema" param "schema" is not a valid JSON Schema; fix the schema file referenced by task.yaml`,
      { cause: err },
    );
  }
  compiled.set(schema, validate);
  return validate;
}

/**
 * Scores model output against a JSON Schema.
 *
 * @param output - Raw model output.
 * @param _expected - Unused; conformance is defined by the schema alone.
 * @param params - Requires `schema`: the JSON Schema object (the task
 *   loader resolves the manifest's schema path into this object).
 * @returns Score 1 with pass true when the extracted JSON validates;
 *   otherwise score 0 with every violation listed in details. Details
 *   always include `extractionNeeded`.
 * @throws Error only when `params.schema` is missing or not compilable.
 */
export function jsonSchemaScorer(
  output: string,
  _expected: unknown,
  params: ScorerParams,
): ScoreRecord {
  const schema = requireObject('json-schema', params, 'schema');
  const validate = compileSchema(schema);

  const extraction = extractJson(output);
  if (!extraction.ok) {
    return {
      score: 0,
      pass: false,
      details: {
        extractionNeeded: extraction.extractionNeeded,
        violations: [`output is not JSON: ${extraction.error ?? 'unknown parse failure'}`],
      },
    };
  }

  const valid = validate(extraction.value);
  const violations = valid
    ? []
    : (validate.errors ?? []).map(
        (err) => `${err.instancePath === '' ? '(root)' : err.instancePath} ${err.message ?? 'violates schema'}`,
      );
  return {
    score: valid ? 1 : 0,
    pass: valid === true,
    details: {
      extractionNeeded: extraction.extractionNeeded,
      violations,
    },
  };
}
