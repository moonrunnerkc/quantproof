import { describe, expect, it } from 'vitest';
import { kvCacheMib, predictFit } from '../../src/catalog/fit-predictor.js';
import type { ModelArchitecture } from '../../src/catalog/gguf-metadata.js';

// Real architectures from the captured /api/show fixtures.
const gemma1b: ModelArchitecture = {
  architecture: 'gemma3', blockCount: 26, kvHeadCount: 1, keyLength: 256, valueLength: 256, maxContext: 32768,
};
const qwen4b: ModelArchitecture = {
  architecture: 'qwen3', blockCount: 36, kvHeadCount: 8, keyLength: 128, valueLength: 128, maxContext: 262144,
};
const qwen14b: ModelArchitecture = {
  architecture: 'qwen3', blockCount: 40, kvHeadCount: 8, keyLength: 128, valueLength: 128, maxContext: 40960,
};

describe('kvCacheMib hand-computed cases', () => {
  it('gemma3:1b at 2048 ctx: 26 x 1 x 512 x 2048 x 2 bytes = 52 MiB', () => {
    expect(kvCacheMib(gemma1b, 2048)).toBe(52);
  });
  it('qwen3:4b at 4096 ctx: 36 x 8 x 256 x 4096 x 2 bytes = 576 MiB', () => {
    expect(kvCacheMib(qwen4b, 4096)).toBe(576);
  });
  it('qwen3:14b at 8192 ctx: 40 x 8 x 256 x 8192 x 2 bytes = 1280 MiB', () => {
    expect(kvCacheMib(qwen14b, 8192)).toBe(1280);
  });
});

describe('predictFit', () => {
  const QWEN14B_BYTES = 9276198565;
  const WEIGHTS_14B_MIB = QWEN14B_BYTES / (1024 * 1024); // 8846.53...

  it('says fits when predicted peak is inside 95% of free VRAM', () => {
    // Predicted: 8846.53 + 1280 + 1024 = 11150.53; budget 0.95 x 12227 = 11615.65.
    const fit = predictFit(QWEN14B_BYTES, qwen14b, 8192, 12227);
    expect(fit.verdict).toBe('fits');
    expect(fit.predictedPeakMib).toBeCloseTo(WEIGHTS_14B_MIB + 1280 + 1024, 5);
    expect(fit.kvCacheMib).toBe(1280);
    expect(fit.reason).toContain('within');
  });

  it('says does-not-fit when the same model faces 8 GiB free', () => {
    const fit = predictFit(QWEN14B_BYTES, qwen14b, 8192, 8192);
    expect(fit.verdict).toBe('does-not-fit');
    expect(fit.reason).toContain('exceeds');
  });

  it('is conservative at the margin: a peak just over the 95% budget does not fit', () => {
    // gemma3:1b at 2048: weights 777.55 + 52 + 1024 = 1853.55 MiB.
    // Free 1900: budget 1805 < peak, so conservative bias says no.
    const fit = predictFit(815319791, gemma1b, 2048, 1900);
    expect(fit.verdict).toBe('does-not-fit');
  });

  it('returns unknown with the computed peak when free VRAM is unmeasurable', () => {
    const fit = predictFit(QWEN14B_BYTES, qwen14b, 8192, null);
    expect(fit.verdict).toBe('unknown');
    expect(fit.predictedPeakMib).toBeCloseTo(WEIGHTS_14B_MIB + 2304, 5);
    expect(fit.reason).toContain('free VRAM could not be sampled');
  });

  it('returns unknown without a peak when the architecture is unknown, and never throws', () => {
    const fit = predictFit(QWEN14B_BYTES, null, 8192, 12227);
    expect(fit.verdict).toBe('unknown');
    expect(fit.predictedPeakMib).toBeNull();
    expect(fit.kvCacheMib).toBeNull();
    expect(fit.reason).toContain('--force');
    expect(fit.weightsMib).toBeCloseTo(WEIGHTS_14B_MIB, 5);
  });
});
