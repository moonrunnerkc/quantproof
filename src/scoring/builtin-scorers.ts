/**
 * Registers the five built-in scorers under the names task manifests
 * use. Idempotent so every entry point (CLI, tests, loaders) can call
 * it without coordinating who goes first.
 */

import { exactLabelScorer } from './exact-label-scorer.js';
import { fieldF1Scorer } from './field-f1-scorer.js';
import { jsonSchemaScorer } from './json-schema-scorer.js';
import { numericToleranceScorer } from './numeric-tolerance-scorer.js';
import { patternScorer } from './pattern-scorer.js';
import { registerScorer } from './scorer-registry.js';

let registered = false;

/**
 * Registers all built-in scorers. Safe to call more than once; repeat
 * calls are no-ops.
 */
export function registerBuiltinScorers(): void {
  if (registered) {
    return;
  }
  registerScorer('json-schema', jsonSchemaScorer);
  registerScorer('field-f1', fieldF1Scorer);
  registerScorer('exact-label', exactLabelScorer);
  registerScorer('pattern', patternScorer);
  registerScorer('numeric-tolerance', numericToleranceScorer);
  registered = true;
}
