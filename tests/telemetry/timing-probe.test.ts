import { describe, expect, it } from 'vitest';
import type { GenerationStream, GenerationSummary, TokenEvent } from '../../src/backends/backend-adapter.js';
import { deriveTiming, observeGeneration } from '../../src/telemetry/timing-probe.js';

const summaryFor = (startedAt: number, finishedAt: number, output: string): GenerationSummary => ({
  output,
  startedAt,
  finishedAt,
  doneReason: 'stop',
  promptTokenCount: 10,
  outputTokenCount: output.length,
  requestOptions: { model: 'fake' },
});

describe('deriveTiming', () => {
  it('derives ttft, post-first-token rate, and wall time from timestamps', () => {
    const events: TokenEvent[] = [
      { text: 'a', at: 1200 },
      { text: 'b', at: 1300 },
      { text: 'c', at: 1400 },
    ];
    const timing = deriveTiming(1000, 1450, events);
    // First token 200ms after start; 2 further tokens over 200ms = 10/s.
    expect(timing).toEqual({ ttftMs: 200, tokensPerSecond: 10, wallMs: 450, tokenCount: 3 });
  });

  it('reports nulls for a generation that produced no tokens', () => {
    const timing = deriveTiming(1000, 1500, []);
    expect(timing).toEqual({ ttftMs: null, tokensPerSecond: null, wallMs: 500, tokenCount: 0 });
  });

  it('reports a ttft but no rate for a single-token generation', () => {
    const timing = deriveTiming(1000, 1500, [{ text: 'a', at: 1100 }]);
    expect(timing.ttftMs).toBe(100);
    expect(timing.tokensPerSecond).toBeNull();
    expect(timing.tokenCount).toBe(1);
  });

  it('refuses to fabricate a rate when all tokens share one timestamp', () => {
    const events: TokenEvent[] = [
      { text: 'a', at: 1100 },
      { text: 'b', at: 1100 },
    ];
    expect(deriveTiming(1000, 1200, events).tokensPerSecond).toBeNull();
  });
});

describe('observeGeneration', () => {
  function fakeStream(events: readonly TokenEvent[], delayMs = 0): GenerationStream {
    async function* stream(): GenerationStream {
      for (const event of events) {
        if (delayMs > 0) {
          await new Promise((r) => setTimeout(r, delayMs));
        }
        yield event;
      }
      return summaryFor(1000, 2000, events.map((e) => e.text).join(''));
    }
    return stream();
  }

  it('collects every event and the summary from a stream', async () => {
    const events: TokenEvent[] = [
      { text: 'hel', at: 1100 },
      { text: 'lo', at: 1200 },
    ];
    const observed = await observeGeneration(fakeStream(events));
    expect(observed.summary.output).toBe('hello');
    expect(observed.events).toEqual(events);
    expect(observed.timing.ttftMs).toBe(100);
    expect(observed.timing.wallMs).toBe(1000);
  });

  it('handles a slow stream without dropping events', async () => {
    const events: TokenEvent[] = Array.from({ length: 5 }, (_, i) => ({
      text: String(i),
      at: 1000 + i * 10,
    }));
    const observed = await observeGeneration(fakeStream(events, 5));
    expect(observed.events).toHaveLength(5);
    expect(observed.summary.output).toBe('01234');
  });

  it('propagates a mid-stream crash to the caller', async () => {
    async function* crashing(): GenerationStream {
      yield { text: 'a', at: 1100 };
      await Promise.resolve();
      throw new Error('backend died mid-generation');
    }
    await expect(observeGeneration(crashing())).rejects.toThrow(/died mid-generation/);
  });
});
