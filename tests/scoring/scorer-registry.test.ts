import { describe, expect, it } from 'vitest';
import { registerBuiltinScorers } from '../../src/scoring/builtin-scorers.js';
import { getScorer, listScorers, registerScorer } from '../../src/scoring/scorer-registry.js';

registerBuiltinScorers();

describe('scorer registry', () => {
  it('registers all five built-in scorers under their manifest names', () => {
    expect(listScorers()).toEqual([
      'exact-label',
      'field-f1',
      'json-schema',
      'numeric-tolerance',
      'pattern',
    ]);
  });

  it('is safe to register built-ins twice', () => {
    expect(() => registerBuiltinScorers()).not.toThrow();
  });

  it('returns a callable scorer for a known name', () => {
    const scorer = getScorer('exact-label');
    const record = scorer('bug', 'bug', { labels: ['bug'] });
    expect(record.pass).toBe(true);
  });

  it('rejects an unknown scorer name and lists the valid ones', () => {
    expect(() => getScorer('vibes')).toThrow(/unknown scorer "vibes".*exact-label.*pattern/s);
  });

  it('rejects duplicate registration under the same name', () => {
    registerScorer('test-dupe', () => ({ score: 1, pass: true, details: {} }));
    expect(() => registerScorer('test-dupe', () => ({ score: 0, pass: false, details: {} }))).toThrow(
      /already registered/,
    );
  });
});
