/**
 * VRAM probe: spawns nvidia-smi in loop mode and tracks peak GPU
 * memory plus a timeline while a model loads, generates, and unloads.
 * When nvidia-smi is absent or unusable the probe reports that state
 * explicitly; it never fabricates and never silently omits.
 */

import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { performance } from 'node:perf_hooks';

/** One VRAM reading. */
export interface VramSample {
  /** Monotonic ms when the sample arrived. */
  readonly at: number;
  readonly usedMib: number;
}

/** Static GPU identity for the report's environment line. */
export interface GpuInfo {
  readonly name: string;
  readonly driverVersion: string;
  readonly totalMib: number;
}

/** Outcome of a probe session. */
export type VramProbeResult =
  | {
      readonly available: true;
      readonly gpu: GpuInfo;
      readonly peakMib: number;
      readonly samples: readonly VramSample[];
    }
  | { readonly available: false; readonly reason: string };

/** A running probe; stop() ends sampling and returns the result. */
export interface VramProbe {
  /** GPU identity, known at start; null when the probe is unavailable. */
  readonly gpu: GpuInfo | null;
  /** Why the probe is unavailable; null when it is running. */
  readonly unavailableReason: string | null;
  stop(): Promise<VramProbeResult>;
}

export interface VramProbeOptions {
  /** Binary to invoke; overridable so tests can supply a fake. */
  readonly binary?: string;
  /** Sampling interval passed to -lms. */
  readonly intervalMs?: number;
}

/** A one-shot VRAM reading for plan-time and isolation checks. */
export interface VramSnapshot {
  readonly freeMib: number;
  readonly usedMib: number;
}

/**
 * Samples free and used GPU memory once.
 *
 * @param binary - nvidia-smi or a test fake.
 * @returns The snapshot, or null when the binary is missing or its
 *   output is unparseable. Never throws.
 */
export function queryVramOnce(binary = 'nvidia-smi'): VramSnapshot | null {
  const probe = spawnSync(binary, ['--query-gpu=memory.free,memory.used', '--format=csv,noheader,nounits'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  if (probe.error !== undefined || probe.status !== 0) {
    return null;
  }
  const parts = (probe.stdout.trim().split('\n')[0] ?? '').split(',').map((p) => Number.parseInt(p.trim(), 10));
  const [freeMib, usedMib] = parts;
  if (parts.length < 2 || freeMib === undefined || usedMib === undefined || Number.isNaN(freeMib) || Number.isNaN(usedMib)) {
    return null;
  }
  return { freeMib, usedMib };
}

/** Queries GPU identity once. Returns null when the binary is unusable. */
function queryGpuInfo(binary: string): GpuInfo | null {
  const probe = spawnSync(binary, ['--query-gpu=name,driver_version,memory.total', '--format=csv,noheader,nounits'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  if (probe.error !== undefined || probe.status !== 0) {
    return null;
  }
  const line = probe.stdout.trim().split('\n')[0] ?? '';
  const parts = line.split(',').map((p) => p.trim());
  const totalMib = Number.parseInt(parts[2] ?? '', 10);
  if (parts.length < 3 || parts[0] === '' || Number.isNaN(totalMib)) {
    return null;
  }
  return { name: parts[0] ?? '', driverVersion: parts[1] ?? '', totalMib };
}

/**
 * Starts sampling GPU memory.
 *
 * Runs `nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits
 * -lms <interval>` and records each reading. Start this before model
 * load and stop it after unload so the peak covers the whole lifecycle.
 *
 * @param options - Binary override (for tests) and sampling interval.
 * @returns A running probe. When nvidia-smi is missing or malfunctions
 *   the returned probe resolves to `{ available: false }` with the
 *   reason; the run itself proceeds.
 */
export function startVramProbe(options: VramProbeOptions = {}): VramProbe {
  const binary = options.binary ?? 'nvidia-smi';
  const intervalMs = options.intervalMs ?? 200;

  const gpu = queryGpuInfo(binary);
  if (gpu === null) {
    const reason = `${binary} is not available on this machine, so VRAM was not measured`;
    return {
      gpu: null,
      unavailableReason: reason,
      stop: () => Promise.resolve({ available: false, reason }),
    };
  }

  let child: ChildProcessByStdio<null, Readable, null>;
  try {
    child = spawn(binary, ['--query-gpu=memory.used', '--format=csv,noheader,nounits', '-lms', String(intervalMs)], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    const reason = `failed to start ${binary}: ${err instanceof Error ? err.message : String(err)}`;
    return { gpu: null, unavailableReason: reason, stop: () => Promise.resolve({ available: false, reason }) };
  }

  const samples: VramSample[] = [];
  let spawnFailure: string | null = null;
  let buffered = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffered += chunk;
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      const usedMib = Number.parseInt(line.trim(), 10);
      if (!Number.isNaN(usedMib)) {
        samples.push({ at: performance.now(), usedMib });
      }
    }
  });
  child.on('error', (err) => {
    spawnFailure = `failed to start ${binary}: ${err.message}`;
  });

  return {
    gpu,
    unavailableReason: null,
    stop: () =>
      new Promise<VramProbeResult>((resolvePromise) => {
        const finish = (): void => {
          if (spawnFailure !== null) {
            resolvePromise({ available: false, reason: spawnFailure });
          } else if (samples.length === 0) {
            resolvePromise({
              available: false,
              reason: `${binary} produced no samples before the run finished`,
            });
          } else {
            resolvePromise({
              available: true,
              gpu,
              peakMib: Math.max(...samples.map((s) => s.usedMib)),
              samples,
            });
          }
        };
        if (child.exitCode !== null) {
          finish();
          return;
        }
        // 'exit' rather than 'close': close waits for the stdout pipe,
        // which a child the sampler spawned could hold open forever.
        child.once('exit', finish);
        child.kill('SIGTERM');
      }),
  };
}
