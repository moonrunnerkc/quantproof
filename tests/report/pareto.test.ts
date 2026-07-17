import { describe, expect, it } from 'vitest';
import { dominates, paretoFrontier } from '../../src/report/pareto.js';
import { makeAggregate } from './report-fixtures.js';

const names = (points: readonly { aggregate: { candidate: { modelName: string } } }[]): string[] =>
  points.map((p) => p.aggregate.candidate.modelName);

describe('paretoFrontier', () => {
  it('keeps a strictly dominated candidate off the frontier', () => {
    const result = paretoFrontier([
      makeAggregate('better', { quality: 0.9, vram: 4000, tps: 40 }),
      makeAggregate('worse', { quality: 0.8, vram: 5000, tps: 30 }),
    ]);
    expect(names(result.frontier)).toEqual(['better']);
    expect(names(result.dominated)).toEqual(['worse']);
  });

  it('keeps both candidates when each wins a different axis', () => {
    const result = paretoFrontier([
      makeAggregate('high-quality', { quality: 0.95, vram: 8000, tps: 20 }),
      makeAggregate('small-fast', { quality: 0.9, vram: 3000, tps: 60 }),
    ]);
    expect(names(result.frontier)).toEqual(['high-quality', 'small-fast']);
    expect(result.dominated).toEqual([]);
  });

  it('keeps exact ties on the frontier together', () => {
    const result = paretoFrontier([
      makeAggregate('twin-a', { quality: 0.9, vram: 4000, tps: 40 }),
      makeAggregate('twin-b', { quality: 0.9, vram: 4000, tps: 40 }),
    ]);
    expect(names(result.frontier)).toEqual(['twin-a', 'twin-b']);
  });

  it('drops a candidate tied on two axes and beaten on the third', () => {
    const result = paretoFrontier([
      makeAggregate('tied-winner', { quality: 0.9, vram: 4000, tps: 50 }),
      makeAggregate('tied-loser', { quality: 0.9, vram: 4000, tps: 40 }),
    ]);
    expect(names(result.frontier)).toEqual(['tied-winner']);
    expect(names(result.dominated)).toEqual(['tied-loser']);
  });

  it('treats unmeasured vram as incomparable rather than inventing an order', () => {
    // Without VRAM data the smaller-quality candidate still survives on
    // no axis, but the unmeasured one cannot be dominated through vram.
    const result = paretoFrontier([
      makeAggregate('measured', { quality: 0.9, vram: 4000, tps: 40 }),
      makeAggregate('unmeasured', { quality: 0.9, vram: null, tps: 40 }),
    ]);
    expect(names(result.frontier)).toEqual(['measured', 'unmeasured']);
  });

  it('excludes gate-failers with the failing gates in the reason', () => {
    const result = paretoFrontier([
      makeAggregate('clean', { quality: 0.8 }),
      makeAggregate('leaky', {
        quality: 0.9,
        gatesPassed: false,
        gateFailureCounts: { 'json-schema': 4 },
      }),
    ]);
    expect(names(result.frontier)).toEqual(['clean']);
    expect(result.excluded).toHaveLength(1);
    expect(result.excluded[0]?.reason).toContain('json-schema (4 units)');
  });

  it('excludes oom candidates as results, never as competitors', () => {
    const result = paretoFrontier([
      makeAggregate('runs', { quality: 0.8 }),
      makeAggregate('too-big', {
        quality: null, vram: null, tps: null, status: 'oom',
        statusReason: 'oom-suspect during load at context 4096',
      }),
    ]);
    expect(names(result.frontier)).toEqual(['runs']);
    expect(result.excluded[0]?.reason).toContain('oom-suspect during load');
  });

  it('returns an empty frontier when every candidate fails its gates', () => {
    const result = paretoFrontier([
      makeAggregate('a', { gatesPassed: false, gateFailureCounts: { 'json-schema': 6 } }),
      makeAggregate('b', { gatesPassed: false, gateFailureCounts: { regex: 2 } }),
    ]);
    expect(result.frontier).toEqual([]);
    expect(result.dominated).toEqual([]);
    expect(result.excluded).toHaveLength(2);
  });
});

describe('dominates', () => {
  it('requires strict improvement on at least one axis', () => {
    const a = { aggregate: makeAggregate('a'), quality: 0.9, vramMib: 4000, tokensPerSecond: 40 };
    const b = { aggregate: makeAggregate('b'), quality: 0.9, vramMib: 4000, tokensPerSecond: 40 };
    expect(dominates(a, b)).toBe(false);
    expect(dominates({ ...a, quality: 0.91 }, b)).toBe(true);
  });

  it('never dominates through a missing measurement', () => {
    const measured = { aggregate: makeAggregate('a'), quality: 0.9, vramMib: 1, tokensPerSecond: 40 };
    const missing = { aggregate: makeAggregate('b'), quality: 0.9, vramMib: null, tokensPerSecond: 40 };
    expect(dominates(measured, missing)).toBe(false);
    expect(dominates(missing, measured)).toBe(false);
  });
});
