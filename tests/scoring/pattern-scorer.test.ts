import { describe, expect, it } from 'vitest';
import { patternScorer } from '../../src/scoring/pattern-scorer.js';

describe('patternScorer', () => {
  it('passes contains mode when every pattern is present (all is the default)', () => {
    const record = patternScorer('server { listen 8080; }', undefined, {
      patterns: ['listen', '8080'],
    });
    expect(record).toMatchObject({ score: 1, pass: true });
    expect(record.details['mode']).toBe('contains');
    expect(record.details['match']).toBe('all');
  });

  it('fails all-of when one pattern is absent, scoring the matched fraction', () => {
    const record = patternScorer('server { listen 8080; }', undefined, {
      patterns: ['listen', 'ssl'],
    });
    expect(record.score).toBe(0.5);
    expect(record.pass).toBe(false);
  });

  it('passes any-of when at least one pattern matches', () => {
    const record = patternScorer('log_level: warn', undefined, {
      patterns: ['debug', 'warn'],
      match: 'any',
    });
    expect(record.pass).toBe(true);
    expect(record.score).toBe(0.5);
  });

  it('fails any-of when nothing matches', () => {
    const record = patternScorer('silence', undefined, {
      patterns: ['debug', 'warn'],
      match: 'any',
    });
    expect(record.pass).toBe(false);
    expect(record.score).toBe(0);
  });

  it('is case-sensitive in contains mode', () => {
    expect(patternScorer('Listen', undefined, { patterns: ['listen'] }).pass).toBe(false);
  });

  it('matches regex patterns in regex mode', () => {
    const record = patternScorer('"port": 8080', undefined, {
      mode: 'regex',
      patterns: ['"port"\\s*:\\s*\\d+'],
    });
    expect(record.pass).toBe(true);
  });

  it('fails regex mode against empty output', () => {
    expect(patternScorer('', undefined, { mode: 'regex', patterns: ['\\d'] }).pass).toBe(false);
  });

  it('records per-pattern match results in details', () => {
    const record = patternScorer('abc', undefined, { patterns: ['a', 'z'] });
    expect(record.details['patterns']).toEqual([
      { pattern: 'a', matched: true },
      { pattern: 'z', matched: false },
    ]);
  });

  it('throws a pack-authoring error for an uncompilable regex', () => {
    expect(() => patternScorer('x', undefined, { mode: 'regex', patterns: ['('] })).toThrow(
      /cannot compile regex/,
    );
  });

  it('throws a pack-authoring error for an invalid mode', () => {
    expect(() => patternScorer('x', undefined, { patterns: ['a'], mode: 'glob' })).toThrow(
      /must be one of: contains, regex/,
    );
  });

  it('throws a pack-authoring error when patterns is empty', () => {
    expect(() => patternScorer('x', undefined, { patterns: [] })).toThrow(/non-empty array/);
  });
});
