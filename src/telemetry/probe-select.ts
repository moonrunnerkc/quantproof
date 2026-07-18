/**
 * Memory telemetry selection: one place decides how a run measures
 * model memory, by checking the hardware, never by assuming. NVIDIA
 * machines use nvidia-smi, Apple Silicon uses the unified-memory
 * probe, API backends measure nothing by design, and every other
 * machine falls back to the system-memory probe so local runs always
 * carry a measured peak. The one exception: an NVIDIA device without
 * nvidia-smi measures nothing, because RSS would misstate VRAM use.
 */

import { existsSync } from 'node:fs';
import { API_BACKEND_VRAM_REASON, apiNoopProbe } from '../backends/backend-select.js';
import { DEFAULT_RAPID_MLX_URL } from '../backends/rapid-mlx-adapter.js';
import type { BackendKind } from '../catalog/run-config.js';
import { startRapidMlxProbe } from './rapid-mlx-probe.js';
import {
  querySystemIdentity, querySystemMemoryOnce, startSystemMemoryProbe,
} from './system-memory-probe.js';
import type { SystemProbeOptions } from './system-memory-probe.js';
import {
  queryUnifiedIdentity, queryUnifiedMemoryOnce, startUnifiedMemoryProbe,
} from './unified-memory-probe.js';
import type { UnifiedProbeOptions } from './unified-memory-probe.js';
import { queryGpuIdentity, queryVramOnce, startVramProbe } from './vram-probe.js';
import type { GpuInfo, VramProbe, VramSnapshot } from './vram-probe.js';

/** Where a run's memory numbers come from. */
export type MemorySource =
  | 'nvidia-smi' | 'unified-memory' | 'system-memory' | 'rapid-mlx-status' | 'api' | 'none';

/** Rendered when no telemetry source works on this machine. */
export const NO_TELEMETRY_REASON =
  'no memory telemetry on this machine (nvidia-smi not found, not Apple Silicon macOS, and /proc/meminfo unreadable), so memory was not measured';

/** Rendered when a GPU is present but its telemetry tool is missing. */
export const NVIDIA_WITHOUT_SMI_REASON =
  'an NVIDIA GPU is present but nvidia-smi is not on PATH; process memory would exclude VRAM-resident weights and misstate the peak, so memory was not measured. Install the NVIDIA driver utilities (nvidia-smi) and rerun';

/** Device nodes whose presence means an NVIDIA GPU exists on this box. */
const NVIDIA_DEVICE_PATHS = ['/dev/nvidia0', '/dev/nvidiactl', '/proc/driver/nvidia'] as const;

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
  /** Paths whose existence signals an NVIDIA GPU; overridable for tests. */
  readonly nvidiaDevicePaths?: readonly string[];
  readonly unified?: UnifiedProbeOptions;
  readonly system?: SystemProbeOptions;
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
  const hints = PROCESS_HINTS[kind] ?? [kind];
  const unified = queryUnifiedIdentity(options.unified);
  if (unified !== null) {
    return {
      source: 'unified-memory',
      gpu: unified,
      unavailableReason: null,
      startProbe: () => startUnifiedMemoryProbe(hints, options.unified),
      sampleOnce: () => queryUnifiedMemoryOnce(hints, options.unified),
    };
  }
  // A GPU without its telemetry tool must not degrade to the RSS
  // fallback: VRAM-resident weights never show in process RSS, so the
  // numbers would look measured while being wrong. Refuse instead.
  const devicePaths = options.nvidiaDevicePaths ?? NVIDIA_DEVICE_PATHS;
  if (devicePaths.some((path) => existsSync(path))) {
    return {
      source: 'none',
      gpu: null,
      unavailableReason: NVIDIA_WITHOUT_SMI_REASON,
      startProbe: () => ({
        gpu: null,
        unavailableReason: NVIDIA_WITHOUT_SMI_REASON,
        stop: () => Promise.resolve({ available: false, reason: NVIDIA_WITHOUT_SMI_REASON }),
      }),
      sampleOnce: () => null,
    };
  }
  const system = querySystemIdentity(options.system);
  if (system !== null) {
    return {
      source: 'system-memory',
      gpu: system,
      unavailableReason: null,
      startProbe: () => startSystemMemoryProbe(hints, options.system),
      sampleOnce: () => querySystemMemoryOnce(options.system),
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
