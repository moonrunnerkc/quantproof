/**
 * Unified-memory probe for Apple Silicon: samples the resident memory
 * of the backend's processes (server plus model runner) via ps and
 * tracks the peak while a model loads, generates, and unloads. Verified
 * against a live load: the runner's RSS tracks Ollama's own resident
 * model accounting within a few percent, so this is a measurement of
 * the model's footprint, not an estimate. When the machine is not
 * Apple Silicon macOS the probe reports that state explicitly.
 */

import { parsePsRss, readCommand, startRssProbe } from './ps-rss-sampler.js';
import type { GpuInfo, VramProbe, VramSnapshot } from './vram-probe.js';

/**
 * Fraction of physical memory treated as the model budget. Metal caps
 * a process GPU working set near 75% of unified memory on Apple
 * Silicon; the fit predictor compares against this budget rather than
 * pretending all physical memory is available to a model.
 */
export const UNIFIED_BUDGET_FRACTION = 0.75;

/** Rendered when the machine cannot measure unified memory. */
export const UNIFIED_UNAVAILABLE_REASON =
  'unified-memory telemetry needs Apple Silicon macOS, so memory was not measured';

/** Binary and platform overrides so tests can supply fakes. */
export interface UnifiedProbeOptions {
  readonly sysctl?: string;
  readonly swVers?: string;
  readonly ps?: string;
  readonly platform?: NodeJS.Platform;
  readonly intervalMs?: number;
  readonly timelineCap?: number;
}

/**
 * Queries the machine's identity for the report environment line.
 *
 * @param options - Binary and platform overrides, mainly for tests.
 * @returns Chip name, macOS version as the driver field, and total
 *   physical memory in MiB; null off Apple Silicon macOS or when any
 *   query fails. Never throws.
 */
export function queryUnifiedIdentity(options: UnifiedProbeOptions = {}): GpuInfo | null {
  if ((options.platform ?? process.platform) !== 'darwin') {
    return null;
  }
  const sysctl = options.sysctl ?? 'sysctl';
  const brand = readCommand(sysctl, ['-n', 'machdep.cpu.brand_string']);
  const memBytes = Number.parseInt(readCommand(sysctl, ['-n', 'hw.memsize']) ?? '', 10);
  const osVersion = readCommand(options.swVers ?? 'sw_vers', ['-productVersion']);
  if (brand === null || brand === '' || Number.isNaN(memBytes) || osVersion === null) {
    return null;
  }
  return {
    name: `${brand} unified memory`,
    driverVersion: `macOS ${osVersion}`,
    totalMib: Math.round(memBytes / (1024 * 1024)),
  };
}

/**
 * Samples the backend's resident memory once and derives the free
 * model budget.
 *
 * @param hints - Case-insensitive substrings identifying the backend's
 *   processes, e.g. ["ollama"].
 * @param options - Binary and platform overrides, mainly for tests.
 * @returns Used MiB (summed RSS of matching processes) and free MiB
 *   (the 75% budget minus used, floored at zero); null when the
 *   machine has no unified-memory identity or ps fails. Never throws.
 */
export function queryUnifiedMemoryOnce(
  hints: readonly string[],
  options: UnifiedProbeOptions = {},
): VramSnapshot | null {
  const identity = queryUnifiedIdentity(options);
  if (identity === null) {
    return null;
  }
  const stdout = readCommand(options.ps ?? 'ps', ['-axo', 'rss=,command=']);
  if (stdout === null) {
    return null;
  }
  const usedMib = parsePsRss(stdout, hints);
  const budgetMib = Math.floor(identity.totalMib * UNIFIED_BUDGET_FRACTION);
  return { usedMib, freeMib: Math.max(0, budgetMib - usedMib) };
}

/**
 * Starts sampling the backend's resident memory on an interval.
 *
 * @param hints - Process substrings identifying the backend.
 * @param options - Binary, platform, interval, and cap overrides.
 * @returns A running probe. Off Apple Silicon macOS the returned probe
 *   resolves to unavailable with the reason; the run itself proceeds.
 */
export function startUnifiedMemoryProbe(
  hints: readonly string[],
  options: UnifiedProbeOptions = {},
): VramProbe {
  const identity = queryUnifiedIdentity(options);
  if (identity === null) {
    return {
      gpu: null,
      unavailableReason: UNIFIED_UNAVAILABLE_REASON,
      stop: () => Promise.resolve({ available: false, reason: UNIFIED_UNAVAILABLE_REASON }),
    };
  }
  return startRssProbe(identity, hints, options);
}
