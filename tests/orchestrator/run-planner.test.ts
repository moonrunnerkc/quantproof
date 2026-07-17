import { describe, expect, it } from 'vitest';
import type { ModelDescriptor } from '../../src/backends/backend-adapter.js';
import { predictFit } from '../../src/catalog/fit-predictor.js';
import type { ModelArchitecture, ModelInfoSource } from '../../src/catalog/gguf-metadata.js';
import {
  assessCandidates,
  buildRunPlan,
  estimateSeconds,
  renderRunPlan,
} from '../../src/orchestrator/run-planner.js';
import { descriptor } from './sweep-helpers.js';

const arch: ModelArchitecture = {
  architecture: 'qwen3', blockCount: 36, kvHeadCount: 8, keyLength: 128, valueLength: 128, maxContext: 262144,
};

function assessment(d: ModelDescriptor, freeVramMib: number | null) {
  return { descriptor: d, architecture: arch, fit: predictFit(d.sizeBytes, arch, 4096, freeVramMib) };
}

describe('buildRunPlan', () => {
  it('filters does-not-fit candidates and orders the rest largest first', () => {
    // 12227 MiB free: the 17 GiB model cannot fit; 1 GiB and 9 GiB can.
    const plan = buildRunPlan(
      [
        assessment(descriptor('small:1b', 1e9), 12227),
        assessment(descriptor('huge:27b', 17e9), 12227),
        assessment(descriptor('mid:9b', 9e9), 12227),
      ],
      { force: false, unitsPerCandidate: 6, maxTokens: 512 },
    );
    expect(plan.included.map((a) => a.descriptor.name)).toEqual(['mid:9b', 'small:1b']);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0]?.assessment.descriptor.name).toBe('huge:27b');
    expect(plan.skipped[0]?.reason).toContain('--force');
  });

  it('includes does-not-fit candidates when forced, still largest first', () => {
    const plan = buildRunPlan(
      [assessment(descriptor('small:1b', 1e9), 12227), assessment(descriptor('huge:27b', 17e9), 12227)],
      { force: true, unitsPerCandidate: 6, maxTokens: 512 },
    );
    expect(plan.included.map((a) => a.descriptor.name)).toEqual(['huge:27b', 'small:1b']);
    expect(plan.skipped).toHaveLength(0);
  });

  it('lets unknown-fit candidates run so measurement can decide', () => {
    const plan = buildRunPlan(
      [assessment(descriptor('mystery:4b', 4e9), null)],
      { force: false, unitsPerCandidate: 6, maxTokens: 512 },
    );
    expect(plan.included).toHaveLength(1);
    expect(plan.included[0]?.fit.verdict).toBe('unknown');
  });
});

describe('estimateSeconds', () => {
  it('uses the fixed pre-measurement guess by default', () => {
    // 6 units x (512/20 + 2) + 30 = 6 x 27.6 + 30 = 195.6, rounded 196.
    expect(estimateSeconds(6, 512)).toBe(196);
  });
  it('refines with a measured rate when one exists', () => {
    // 6 x (512/64 + 2) + 30 = 6 x 10 + 30 = 90.
    expect(estimateSeconds(6, 512, 64)).toBe(90);
  });
});

describe('renderRunPlan', () => {
  it('prints what runs, what was skipped and why, and the estimate', () => {
    const plan = buildRunPlan(
      [assessment(descriptor('huge:27b', 17e9), 12227), assessment(descriptor('small:1b', 1e9), 12227)],
      { force: false, unitsPerCandidate: 6, maxTokens: 512 },
    );
    const text = renderRunPlan(plan, 'invoice-extraction');
    expect(text).toContain('plan: invoice-extraction, 1 candidate, 6 units each');
    expect(text).toContain('run  small:1b');
    expect(text).toContain('fit: fits');
    expect(text).toContain('skip huge:27b');
    expect(text).toContain('estimate: ~3 min total');
    expect(text).toContain('refined after the first model completes');
    expect(text).not.toContain('over an hour');
  });

  it('warns up front when the estimate crosses an hour', () => {
    // 100 units x (2048/20 + 2) + 30 = 10470s per candidate.
    const plan = buildRunPlan(
      [assessment(descriptor('small:1b', 1e9), 12227)],
      { force: false, unitsPerCandidate: 100, maxTokens: 2048 },
    );
    const text = renderRunPlan(plan, 'big-sweep');
    expect(text).toContain('over an hour of sequential inference');
    expect(text).toContain('--limit');
    expect(text).toContain('quantproof resume');
  });
});

describe('assessCandidates', () => {
  it('resolves architecture per candidate and predicts fit with it', async () => {
    const source: ModelInfoSource = {
      showModelInfo: () =>
        Promise.resolve({
          'general.architecture': 'qwen3',
          'qwen3.block_count': 36,
          'qwen3.attention.head_count_kv': 8,
          'qwen3.attention.head_count': 32,
          'qwen3.attention.key_length': 128,
          'qwen3.attention.value_length': 128,
          'qwen3.embedding_length': 2560,
          'qwen3.context_length': 262144,
        }),
    };
    const assessments = await assessCandidates(source, [descriptor('qwen3:4b', 2497293931)], 4096, 12227);
    expect(assessments[0]?.architecture?.blockCount).toBe(36);
    expect(assessments[0]?.fit.kvCacheMib).toBe(576);
    expect(assessments[0]?.fit.verdict).toBe('fits');
  });
});
