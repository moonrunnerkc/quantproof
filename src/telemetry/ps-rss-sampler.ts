/**
 * Shared resident-memory sampling over ps: sums the RSS of a backend's
 * processes on an interval and tracks the peak. The unified-memory
 * probe (Apple Silicon) and the system-memory probe (CPU-only fallback)
 * both measure the same thing, a backend's resident footprint, and this
 * module is that measurement; only identity and fit budgets differ per
 * platform, and those stay in the probes.
 */

import { execFile, spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import type { GpuInfo, VramProbe, VramProbeResult, VramSample } from './vram-probe.js';
import { VRAM_TIMELINE_CAP } from './vram-probe.js';

/** Interval, cap, and binary overrides for the sampler. */
export interface RssSamplerOptions {
  readonly ps?: string;
  readonly intervalMs?: number;
  readonly timelineCap?: number;
}

/**
 * Runs a short-lived command and captures stdout.
 *
 * @param binary - Executable to run.
 * @param args - Arguments passed verbatim.
 * @returns Trimmed stdout, or null when the command is missing, fails,
 *   or exits nonzero. Never throws.
 */
export function readCommand(binary: string, args: readonly string[]): string | null {
  const result = spawnSync(binary, [...args], { encoding: 'utf8', timeout: 5000 });
  if (result.error !== undefined || result.status !== 0) {
    return null;
  }
  return result.stdout.trim();
}

/**
 * Sums the RSS of processes whose command matches any hint.
 *
 * @param stdout - Output of `ps -axo rss=,command=`.
 * @param hints - Case-insensitive substrings identifying the backend.
 * @returns Total resident MiB across matching processes.
 */
export function parsePsRss(stdout: string, hints: readonly string[]): number {
  const lower = hints.map((h) => h.toLowerCase());
  let rssKib = 0;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    const space = trimmed.indexOf(' ');
    if (space < 1) {
      continue;
    }
    const rss = Number.parseInt(trimmed.slice(0, space), 10);
    const command = trimmed.slice(space + 1).toLowerCase();
    if (!Number.isNaN(rss) && lower.some((hint) => command.includes(hint))) {
      rssKib += rss;
    }
  }
  return Math.round(rssKib / 1024);
}

/**
 * Starts sampling a backend's resident memory on an interval.
 *
 * Start before model load and stop after unload so the peak covers the
 * whole lifecycle. Sampling spawns ps asynchronously so the event loop
 * (and with it TTFT timing) is never blocked; overlapping ticks are
 * skipped rather than queued.
 *
 * @param identity - Machine identity attached to the probe's result.
 * @param hints - Process substrings identifying the backend.
 * @param options - Binary, interval, and cap overrides.
 * @returns A running probe; stop() resolves unavailable only when no
 *   sample ever landed, with the failure reason.
 */
export function startRssProbe(
  identity: GpuInfo,
  hints: readonly string[],
  options: RssSamplerOptions = {},
): VramProbe {
  const ps = options.ps ?? 'ps';
  const timelineCap = Math.max(2, options.timelineCap ?? VRAM_TIMELINE_CAP);
  let samples: VramSample[] = [];
  let peakMib = 0;
  let inFlight = false;
  let sampleFailure: string | null = null;

  const tick = (): void => {
    if (inFlight) {
      return;
    }
    inFlight = true;
    execFile(ps, ['-axo', 'rss=,command='], { timeout: 5000 }, (error, stdout) => {
      inFlight = false;
      if (error !== null) {
        sampleFailure = `failed to run ${ps}: ${error.message}`;
        return;
      }
      const usedMib = parsePsRss(stdout, hints);
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
            resolvePromise({
              available: false,
              reason: sampleFailure ?? `${ps} produced no samples before the run finished`,
            });
          } else {
            resolvePromise({ available: true, gpu: identity, peakMib, samples: [...samples] });
          }
        };
        // Wait for an in-flight ps to land (bounded) so a short probe
        // window still returns its sample instead of racing to empty.
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
