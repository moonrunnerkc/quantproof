/**
 * Acceptance gate: identical inputs produce byte-identical score
 * records across 1000 repeated invocations, for every scorer, against
 * every starter-pack example.
 *
 * The pack-declared compositions cover json-schema, field-f1,
 * exact-label, and pattern; extra pairings below run numeric-tolerance
 * and pattern against every example of a compatible pack so all five
 * scorers face all the data they can type-check against.
 */

import { describe, expect, it } from 'vitest';
import { scoreWithGates } from '../../src/scoring/gate-composition.js';
import { getScorer } from '../../src/scoring/scorer-registry.js';
import type { ScoreRecord } from '../../src/scoring/scorer-registry.js';
import { loadAllStarterPacks, loadStarterPack, perfectOutput } from '../helpers/starter-packs.js';

const RUNS = 1000;

function assertStable(label: string, produce: () => ScoreRecord): void {
  const baseline = JSON.stringify(produce());
  for (let i = 0; i < RUNS; i += 1) {
    const run = JSON.stringify(produce());
    if (run !== baseline) {
      expect.fail(`${label}: run ${String(i + 1)} diverged from the first run`);
    }
  }
}

describe('scoring determinism across 1000 invocations', () => {
  const packs = loadAllStarterPacks();

  for (const { name, pack, primary, gates } of packs) {
    it(`${name}: declared scorer composition is byte-stable on every example`, () => {
      for (const example of pack.examples) {
        const output = perfectOutput(name, example.expected);
        assertStable(`${name}/${example.id}`, () =>
          scoreWithGates(output, example.expected, primary, gates),
        );
      }
    });

    it(`${name}: declared composition is byte-stable on adversarial fenced and prose outputs`, () => {
      for (const example of pack.examples) {
        const fenced = '```json\n' + perfectOutput(name, example.expected) + '\n```';
        assertStable(`${name}/${example.id}/fenced`, () =>
          scoreWithGates(fenced, example.expected, primary, gates),
        );
        assertStable(`${name}/${example.id}/refusal`, () =>
          scoreWithGates('I cannot help with that.', example.expected, primary, gates),
        );
      }
    });
  }

  it('numeric-tolerance is byte-stable against every invoice total', () => {
    const { pack } = loadStarterPack('invoice-extraction');
    const scorer = getScorer('numeric-tolerance');
    for (const example of pack.examples) {
      const expected = example.expected as { total: number };
      assertStable(`numeric-tolerance/${example.id}`, () =>
        scorer(`The total due is $${expected.total.toFixed(2)}`, expected.total, { tolerance: 0 }),
      );
    }
  });

  it('pattern is byte-stable against every ticket label output', () => {
    const { pack } = loadStarterPack('ticket-classification');
    const scorer = getScorer('pattern');
    for (const example of pack.examples) {
      const label = example.expected as string;
      assertStable(`pattern/${example.id}`, () =>
        scorer(label, undefined, { patterns: [label, 'nonexistent-marker'], match: 'any' }),
      );
    }
  });

  it('field-f1 is byte-stable against every config example', () => {
    const { pack } = loadStarterPack('config-generation');
    const scorer = getScorer('field-f1');
    for (const example of pack.examples) {
      assertStable(`field-f1/${example.id}`, () =>
        scorer(JSON.stringify(example.expected), example.expected, {
          key_fields: ['name', 'port', 'replicas', 'log_level'],
        }),
      );
    }
  });
});
