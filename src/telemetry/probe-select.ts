/**
 * Memory telemetry selection: one place decides how a run measures
 * model memory. NVIDIA machines use nvidia-smi, Apple Silicon uses the
 * unified-memory probe, API backends measure nothing by design, and
 * everything else runs unmeasured with the reason stated loudly.
 */

import { API_BACKEND_VRAM_REASON, apiNoopProbe } from '../backends/backend-select.js';
import { DEFAULT_RAPID_MLX_URL } from '../backends/rapid-mlx-adapter.js';
import type { BackendKind } from '../catalog/run-config.js';
import { startRapidMlxProbe } from './rapid-mlx-probe.js';
import {
  queryUnifiedIdentity, queryUnifiedMemoryOnce, startUnifiedMemoryProbe,
} from './unified-memory-probe.js';
import type { UnifiedProbeOptions } from './unified-memory-probe.js';
import { queryGpuIdentity, queryVramOnce, startVramProbe } from './vram-probe.js';
import type { GpuInfo, VramProbe, VramSnapshot } from './vram-probe.js';

/** Where a run's memory numbers come from. */
export type MemorySource = 'nvidia-smi' | 'unified-memory' | 'rapid-mlx-status' | 'api' | 'none';

/** Rendered when no telemetry source works on this machine. */
export const NO_TELEMETRY_REASON =
  'no memory telemetry on this machine (nvidia-smi not found and not Apple Silicon macOS), so memory was not measured';

/** The chosen telemetry: identity plus the probe constructors a sweep needs. */
export interface MemoryProbeSet {
  readonly source: MemorySource;
  /** Device identity for the run record; null when nothing measures. */
  readonly gpu: GpuInfo | null;
  /** Why nothing measures; null when a source is available. */
  readonly unavailableReason: string | null;
  readonly startProbe: () => VramProbe;
  readonly sampleOnce: () => VramSnapshot | null;
}

/** Process-name substrings that identify each local backend in ps. */
const PROCESS_HINTS: Readonly<Partial<Record<BackendKind, readonly string[]>>> = {
  ollama: ['ollama'],
};

/** Test injectables. */
export interface ProbeSelectOptions {
  readonly nvidiaBinary?: string;
  readonly unified?: UnifiedProbeOptions;
  /** Rapid-MLX server URL; the sweep's --base-url when given. */
  readonly rapidMlxUrl?: string;
}

/**
 * Picks the memory telemetry for a backend on this machine.
 *
 * @param kind - The run's backend.
 * @param options - Binary overrides, mainly for tests.
 * @returns The probe set; when no source works it still returns
 *   working no-op constructors plus the reason, so callers never
 *   branch on availability.
 */
export function selectMemoryProbes(kind: BackendKind, options: ProbeSelectOptions = {}): MemoryProbeSet {
  if (kind === 'anthropic') {
    return {
      source: 'api',
      gpu: null,
      unavailableReason: API_BACKEND_VRAM_REASON,
      startProbe: apiNoopProbe,
      sampleOnce: () => null,
    };
  }
  if (kind === 'rapid-mlx') {
    // MLX Metal buffers do not show in process RSS, so the server's
    // own /v1/status accounting is the only honest measurement. The
    // one-shot sampler returns null: fit is unpredictable for this
    // backend and its single resident model never unloads, so neither
    // consumer of the snapshot applies.
    const url = options.rapidMlxUrl ?? DEFAULT_RAPID_MLX_URL;
    return {
      source: 'rapid-mlx-status',
      gpu: queryUnifiedIdentity(options.unified),
      unavailableReason: null,
      startProbe: () => startRapidMlxProbe(url, options.unified === undefined ? {} : { identity: options.unified }),
      sampleOnce: () => null,
    };
  }
  const nvidia = queryGpuIdentity(options.nvidiaBinary ?? 'nvidia-smi');
  if (nvidia !== null) {
    return {
      source: 'nvidia-smi',
      gpu: nvidia,
      unavailableReason: null,
      startProbe: () => startVramProbe({ binary: options.nvidiaBinary ?? 'nvidia-smi' }),
      sampleOnce: () => queryVramOnce(options.nvidiaBinary ?? 'nvidia-smi'),
    };
  }
  const unified = queryUnifiedIdentity(options.unified);
  if (unified !== null) {
    const hints = PROCESS_HINTS[kind] ?? [kind];
    return {
      source: 'unified-memory',
      gpu: unified,
      unavailableReason: null,
      startProbe: () => startUnifiedMemoryProbe(hints, options.unified),
      sampleOnce: () => queryUnifiedMemoryOnce(hints, options.unified),
    };
  }
  return {
    source: 'none',
    gpu: null,
    unavailableReason: NO_TELEMETRY_REASON,
    startProbe: () => ({
      gpu: null,
      unavailableReason: NO_TELEMETRY_REASON,
      stop: () => Promise.resolve({ available: false, reason: NO_TELEMETRY_REASON }),
    }),
    sampleOnce: () => null,
  };
}
