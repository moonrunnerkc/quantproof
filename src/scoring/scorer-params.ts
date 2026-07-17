/**
 * Param narrowing helpers shared by all scorers.
 *
 * Scorer params arrive as untyped YAML from task.yaml. Every scorer
 * narrows through these helpers so a bad manifest fails with the same
 * shape of message everywhere: which scorer, which param, what it got,
 * what to write instead.
 */

import type { ScorerParams } from './scorer-registry.js';

/** Builds the common error prefix so messages stay uniform. */
function paramError(scorer: string, key: string, requirement: string): Error {
  return new Error(
    `scorer "${scorer}" param "${key}" ${requirement}; fix scorer_params.${key} in task.yaml`,
  );
}

/**
 * Reads a required non-empty string array param.
 *
 * @param scorer - Scorer name for the error message.
 * @param params - Raw params from the manifest.
 * @param key - Param key to read.
 * @returns The narrowed string array.
 * @throws Error when missing, not an array, empty, or holding non-strings.
 */
export function requireStringArray(
  scorer: string,
  params: ScorerParams,
  key: string,
): readonly string[] {
  const value = params[key];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item): item is string => typeof item === 'string')
  ) {
    throw paramError(scorer, key, 'must be a non-empty array of strings');
  }
  return value;
}

/**
 * Reads a required finite number param.
 *
 * @param scorer - Scorer name for the error message.
 * @param params - Raw params from the manifest.
 * @param key - Param key to read.
 * @returns The narrowed number.
 * @throws Error when missing or not a finite number.
 */
export function requireNumber(
  scorer: string,
  params: ScorerParams,
  key: string,
): number {
  const value = params[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw paramError(scorer, key, 'must be a finite number');
  }
  return value;
}

/**
 * Reads an optional string param constrained to a fixed set of choices.
 *
 * @param scorer - Scorer name for the error message.
 * @param params - Raw params from the manifest.
 * @param key - Param key to read.
 * @param choices - Allowed values.
 * @param fallback - Value used when the param is absent.
 * @returns One of `choices`.
 * @throws Error when present but outside `choices`.
 */
export function optionalChoice<T extends string>(
  scorer: string,
  params: ScorerParams,
  key: string,
  choices: readonly T[],
  fallback: T,
): T {
  const value = params[key];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'string' || !choices.includes(value as T)) {
    throw paramError(scorer, key, `must be one of: ${choices.join(', ')}`);
  }
  return value as T;
}

/**
 * Reads an optional string-to-string record param (e.g. label aliases).
 *
 * @param scorer - Scorer name for the error message.
 * @param params - Raw params from the manifest.
 * @param key - Param key to read.
 * @returns The record, or an empty record when absent.
 * @throws Error when present but not a flat string-to-string object.
 */
export function optionalStringRecord(
  scorer: string,
  params: ScorerParams,
  key: string,
): Readonly<Record<string, string>> {
  const value = params[key];
  if (value === undefined) {
    return {};
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw paramError(scorer, key, 'must be an object mapping strings to strings');
  }
  const record = value as Record<string, unknown>;
  for (const [k, v] of Object.entries(record)) {
    if (typeof v !== 'string') {
      throw paramError(
        scorer,
        key,
        `must map strings to strings, but "${k}" maps to a ${typeof v}`,
      );
    }
  }
  return record as Record<string, string>;
}

/**
 * Reads a required plain-object param (e.g. a JSON Schema).
 *
 * @param scorer - Scorer name for the error message.
 * @param params - Raw params from the manifest.
 * @param key - Param key to read.
 * @returns The object.
 * @throws Error when missing or not a plain object.
 */
export function requireObject(
  scorer: string,
  params: ScorerParams,
  key: string,
): Readonly<Record<string, unknown>> {
  const value = params[key];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw paramError(scorer, key, 'must be an object');
  }
  return value as Record<string, unknown>;
}
