/**
 * Memory probe for the Rapid-MLX backend: polls the server's own Metal
 * accounting at /v1/status. Required because MLX allocates Metal
 * buffers outside the process RSS that the unified-memory probe sums;
 * verified live, RSS showed 1.3 GiB while the server's Metal active
 * memory was 26 GiB for a served 30B model. The peak is tracked from
 * active-memory samples over this probe's window, never taken from the
 * server's lifetime peak, so one candidate cannot inherit another's
 * high-water mark.
 */

import { performance } from 'node:perf_hooks';
import { queryUnifiedIdentity } from './unified-memory-probe.js';
import type { UnifiedProbeOptions } from './unified-memory-probe.js';
import type { VramProbe, VramProbeResult, VramSample } from './vram-probe.js';
import { VRAM_TIMELINE_CAP } from './vram-probe.js';

/** Rendered when the status endpoint never yields a sample. */
export const RAPID_MLX_PROBE_UNAVAILABLE =
  'rapid-mlx /v1/status was unreachable during the run, so memory was not measured';

/** Probe tuning; production uses the defaults, tests override. */
export interface RapidMlxProbeOptions {
  readonly intervalMs?: number;
  readonly timelineCap?: number;
  /** Identity overrides for tests, passed to the unified probe. */
  readonly identity?: UnifiedProbeOptions;
}

async function sampleActiveMib(baseUrl: string): Promise<number | null> {
  try {
    const response = await fetch(`${baseUrl}/v1/status`);
    if (!response.ok) {
      return null;
    }
    const body: unknown = await response.json();
    const metal = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['metal'] : undefined;
    const active = typeof metal === 'object' && metal !== null ? (metal as Record<string, unknown>)['active_memory_gb'] : undefined;
    return typeof active === 'number' ? Math.round(active * 1024) : null;
  } catch {
    return null;
  }
}

/**
 * Starts sampling the Rapid-MLX server's Metal active memory.
 *
 * @param baseUrl - The server base URL, e.g. http://localhost:8000.
 * @param options - Interval, cap, and identity overrides for tests.
 * @returns A running probe. When the machine identity or the status
 *   endpoint is unavailable the result reports that state with the
 *   reason; the run itself proceeds.
 */
export function startRapidMlxProbe(baseUrl: string, options: RapidMlxProbeOptions = {}): VramProbe {
  const identity = queryUnifiedIdentity(options.identity);
  if (identity === null) {
    const reason = 'machine identity is unavailable (not Apple Silicon macOS), so memory was not measured';
    return {
      gpu: null,
      unavailableReason: reason,
      stop: () => Promise.resolve({ available: false, reason }),
    };
  }
  const url = baseUrl.replace(/\/$/, '');
  const timelineCap = Math.max(2, options.timelineCap ?? VRAM_TIMELINE_CAP);
  let samples: VramSample[] = [];
  let peakMib = 0;
  let inFlight = false;

  const tick = (): void => {
    if (inFlight) {
      return;
    }
    inFlight = true;
    void sampleActiveMib(url).then((usedMib) => {
      inFlight = false;
      if (usedMib === null) {
        return;
      }
      peakMib = Math.max(peakMib, usedMib);
      samples.push({ at: performance.now(), usedMib });
      if (samples.length >= timelineCap) {
        samples = samples.filter((_, index) => index % 2 === 0);
      }
    });
  };
  const timer = setInterval(tick, options.intervalMs ?? 200);
  timer.unref();
  tick();

  return {
    gpu: identity,
    unavailableReason: null,
    stop: () =>
      new Promise<VramProbeResult>((resolvePromise) => {
        clearInterval(timer);
        const finish = (): void => {
          if (samples.length === 0) {
            resolvePromise({ available: false, reason: RAPID_MLX_PROBE_UNAVAILABLE });
          } else {
            resolvePromise({ available: true, gpu: identity, peakMib, samples: [...samples] });
          }
        };
        let waitedMs = 0;
        const awaitInFlight = (): void => {
          if (!inFlight || waitedMs >= 2000) {
            finish();
            return;
          }
          waitedMs += 10;
          setTimeout(awaitInFlight, 10);
        };
        awaitInFlight();
      }),
  };
}
