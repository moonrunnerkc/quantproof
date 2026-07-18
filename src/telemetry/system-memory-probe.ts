/**
 * System-memory probe: the fallback that keeps memory measured on
 * machines with no GPU telemetry at all, CPU-only Linux included. The
 * peak is the backend's summed process RSS (same measurement the
 * unified-memory probe validated against Ollama's own accounting); the
 * fit budget is the kernel's MemAvailable, which already accounts for
 * reclaimable caches and everything else resident. Numbers from this
 * probe are system RAM, never VRAM, and reports label them as such.
 */

import { readFileSync } from 'node:fs';
import { release } from 'node:os';
import { startRssProbe } from './ps-rss-sampler.js';
import type { GpuInfo, VramProbe, VramSnapshot } from './vram-probe.js';

/** Rendered when even system memory cannot be read on this machine. */
export const SYSTEM_UNAVAILABLE_REASON =
  'system-memory telemetry needs a readable /proc/meminfo, so memory was not measured';

/** File and binary overrides so tests can supply fakes. */
export interface SystemProbeOptions {
  readonly meminfoPath?: string;
  readonly osRelease?: string;
  readonly ps?: string;
  readonly intervalMs?: number;
  readonly timelineCap?: number;
}

function meminfoValueMib(content: string, key: string): number | null {
  const match = new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(content);
  if (match === null) {
    return null;
  }
  return Math.round(Number.parseInt(match[1], 10) / 1024);
}

function readMeminfo(options: SystemProbeOptions): string | null {
  try {
    return readFileSync(options.meminfoPath ?? '/proc/meminfo', 'utf8');
  } catch {
    return null;
  }
}

/**
 * Queries the machine's identity for the report environment line.
 *
 * @param options - File and binary overrides, mainly for tests.
 * @returns "system RAM" with the kernel release as the driver field and
 *   total physical memory in MiB; null when /proc/meminfo is missing or
 *   carries no MemTotal. Never throws.
 */
export function querySystemIdentity(options: SystemProbeOptions = {}): GpuInfo | null {
  const meminfo = readMeminfo(options);
  if (meminfo === null) {
    return null;
  }
  const totalMib = meminfoValueMib(meminfo, 'MemTotal');
  if (totalMib === null) {
    return null;
  }
  return {
    name: 'system RAM',
    driverVersion: `kernel ${options.osRelease ?? release()}`,
    totalMib,
  };
}

/**
 * Samples system memory once for fit prediction.
 *
 * @param options - File overrides, mainly for tests.
 * @returns Free MiB from the kernel's MemAvailable and used MiB as the
 *   remainder of MemTotal; null when /proc/meminfo is unreadable or
 *   lacks either field. Never throws.
 */
export function querySystemMemoryOnce(options: SystemProbeOptions = {}): VramSnapshot | null {
  const meminfo = readMeminfo(options);
  if (meminfo === null) {
    return null;
  }
  const totalMib = meminfoValueMib(meminfo, 'MemTotal');
  const availableMib = meminfoValueMib(meminfo, 'MemAvailable');
  if (totalMib === null || availableMib === null) {
    return null;
  }
  return { usedMib: Math.max(0, totalMib - availableMib), freeMib: availableMib };
}

/**
 * Starts sampling the backend's resident memory on an interval.
 *
 * @param hints - Process substrings identifying the backend, e.g.
 *   ["ollama"].
 * @param options - File, binary, interval, and cap overrides.
 * @returns A running probe. Without a readable /proc/meminfo the
 *   returned probe resolves to unavailable with the reason; the run
 *   itself proceeds.
 */
export function startSystemMemoryProbe(
  hints: readonly string[],
  options: SystemProbeOptions = {},
): VramProbe {
  const identity = querySystemIdentity(options);
  if (identity === null) {
    return {
      gpu: null,
      unavailableReason: SYSTEM_UNAVAILABLE_REASON,
      stop: () => Promise.resolve({ available: false, reason: SYSTEM_UNAVAILABLE_REASON }),
    };
  }
  return startRssProbe(identity, hints, options);
}
