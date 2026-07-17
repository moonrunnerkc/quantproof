/**
 * pattern scorer: presence checks for constrained generation. Supports
 * plain-substring ("contains") and regex modes, multiple patterns, and
 * all-of or any-of matching.
 */

import { optionalChoice, requireStringArray } from './scorer-params.js';
import type { ScoreRecord, ScorerParams } from './scorer-registry.js';

/**
 * Scores model output by pattern presence.
 *
 * In "contains" mode each pattern is a literal substring; matching is
 * case-sensitive because config keys and code fragments (the intended
 * use) are case-sensitive. In "regex" mode each pattern compiles as a
 * JavaScript regular expression with the unicode flag. `match: all`
 * (the default) requires every pattern; `match: any` requires at least
 * one. Score is the fraction of patterns matched, so a near-miss is
 * visible even when pass is false.
 *
 * @param output - Raw model output.
 * @param _expected - Unused; the patterns define correctness.
 * @param params - Requires `patterns`: non-empty string array. Optional
 *   `mode`: "contains" (default) or "regex". Optional `match`: "all"
 *   (default) or "any".
 * @returns Fraction of matched patterns as score, pass per the match
 *   rule, with per-pattern results in details.
 * @throws Error when params are invalid or a regex pattern does not
 *   compile (pack authoring errors).
 */
export function patternScorer(
  output: string,
  _expected: unknown,
  params: ScorerParams,
): ScoreRecord {
  const patterns = requireStringArray('pattern', params, 'patterns');
  const mode = optionalChoice('pattern', params, 'mode', ['contains', 'regex'], 'contains');
  const match = optionalChoice('pattern', params, 'match', ['all', 'any'], 'all');

  const results = patterns.map((pattern) => {
    if (mode === 'contains') {
      return { pattern, matched: output.includes(pattern) };
    }
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, 'u');
    } catch (err) {
      throw new Error(
        `scorer "pattern" cannot compile regex ${JSON.stringify(pattern)}; fix scorer_params.patterns in task.yaml`,
        { cause: err },
      );
    }
    return { pattern, matched: regex.test(output) };
  });

  const matchedCount = results.filter((r) => r.matched).length;
  const pass = match === 'all' ? matchedCount === patterns.length : matchedCount > 0;

  return {
    score: matchedCount / patterns.length,
    pass,
    details: {
      mode,
      match,
      patterns: results,
      matchedCount,
      patternCount: patterns.length,
    },
  };
}
