import { describe, expect, it } from 'vitest';
import { detectOffloadSuspects } from '../../src/orchestrator/offload-heuristic.js';
import type { OffloadInputs } from '../../src/orchestrator/offload-heuristic.js';

const candidate = (overrides: Partial<OffloadInputs> & { candidateId: string }): OffloadInputs => ({
  modelName: overrides.candidateId,
  sizeBytes: 4e9,
  predictedPeakMib: 5000,
  measuredPeakMib: 4800,
  tokensPerSecondMedian: 40,
  ...overrides,
});

describe('detectOffloadSuspects', () => {
  it('flags a peak that plateaus well under prediction', () => {
    const suspects = detectOffloadSuspects([
      candidate({ candidateId: 'a', measuredPeakMib: 2500, predictedPeakMib: 5000 }),
    ]);
    expect(suspects).toHaveLength(1);
    expect(suspects[0]?.reason).toContain('plateaued under 60%');
    expect(suspects[0]?.reason).toContain('2500 MiB');
  });

  it('does not flag a peak reasonably close to prediction', () => {
    expect(detectOffloadSuspects([candidate({ candidateId: 'a', measuredPeakMib: 4000 })])).toHaveLength(0);
  });

  it('flags throughput collapse against similar-size candidates', () => {
    const suspects = detectOffloadSuspects([
      candidate({ candidateId: 'fast', tokensPerSecondMedian: 40, measuredPeakMib: null, predictedPeakMib: null }),
      candidate({ candidateId: 'slow', tokensPerSecondMedian: 5, measuredPeakMib: null, predictedPeakMib: null }),
    ]);
    expect(suspects.map((s) => s.candidateId)).toEqual(['slow']);
    expect(suspects[0]?.reason).toContain('5.0 tok/s');
    expect(suspects[0]?.reason).toContain('fast');
  });

  it('does not compare against candidates outside the size band', () => {
    const suspects = detectOffloadSuspects([
      candidate({ candidateId: 'tiny', sizeBytes: 1e9, tokensPerSecondMedian: 200, measuredPeakMib: null, predictedPeakMib: null }),
      candidate({ candidateId: 'big', sizeBytes: 9e9, tokensPerSecondMedian: 8, measuredPeakMib: null, predictedPeakMib: null }),
    ]);
    // A 9 GiB model being slower than a 1 GiB model is expected, not a flag.
    expect(suspects).toHaveLength(0);
  });

  it('never flags without data: missing vram and no peers stays quiet', () => {
    expect(
      detectOffloadSuspects([
        candidate({ candidateId: 'only', measuredPeakMib: null, predictedPeakMib: null, tokensPerSecondMedian: null }),
      ]),
    ).toHaveLength(0);
  });
});
