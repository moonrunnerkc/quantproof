/**
 * Shared access to the three starter packs for determinism and
 * expectation tests: loads each pack once and binds its declared
 * scorers from the registry.
 */

import { resolve } from 'node:path';
import { registerBuiltinScorers } from '../../src/scoring/builtin-scorers.js';
import type { BoundScorer } from '../../src/scoring/gate-composition.js';
import { getScorer, listScorers } from '../../src/scoring/scorer-registry.js';
import { loadTaskPack } from '../../src/tasks/task-loader.js';
import type { LoadedTaskPack } from '../../src/tasks/task-loader.js';

registerBuiltinScorers();

const PACKS_ROOT = resolve(import.meta.dirname, '../../examples');

/** A starter pack with its scorers bound and ready to run. */
export interface BoundPack {
  readonly name: string;
  readonly pack: LoadedTaskPack;
  readonly primary: BoundScorer;
  readonly gates: readonly BoundScorer[];
}

/**
 * Loads a starter pack by directory name and binds its scorers.
 */
export function loadStarterPack(name: string): BoundPack {
  const pack = loadTaskPack(resolve(PACKS_ROOT, name), listScorers());
  return {
    name,
    pack,
    primary: {
      name: pack.manifest.scorer,
      scorer: getScorer(pack.manifest.scorer),
      params: pack.scorerParams,
    },
    gates: pack.gates.map((gate) => ({
      name: gate.scorer,
      scorer: getScorer(gate.scorer),
      params: gate.scorerParams,
    })),
  };
}

/** All three starter packs, loaded once per test file. */
export function loadAllStarterPacks(): readonly BoundPack[] {
  return ['invoice-extraction', 'ticket-classification', 'config-generation'].map(loadStarterPack);
}

/**
 * Builds the byte-exact output a perfect model would produce for an
 * example: the expected label for classification packs, the expected
 * object serialized as JSON for extraction and generation packs.
 */
export function perfectOutput(packName: string, expected: unknown): string {
  if (packName === 'ticket-classification') {
    if (typeof expected !== 'string') {
      throw new Error(`ticket example expected value must be a string, got ${JSON.stringify(expected)}`);
    }
    return expected;
  }
  return JSON.stringify(expected);
}
