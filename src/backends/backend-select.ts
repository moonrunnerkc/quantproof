/**
 * Backend selection shared by the CLI commands and the report layer.
 * The backend kind is chosen in the run config; a stored run carries
 * it forward through its backendVersion string, which is how resume
 * picks the right adapter and how renderers label API-backed runs so
 * they can never be mistaken for local measurements.
 */

import { ANTHROPIC_BACKEND_PREFIX, AnthropicAdapter } from './anthropic-adapter.js';
import type { BackendAdapter } from './backend-adapter.js';
import { OllamaAdapter } from './ollama-adapter.js';
import type { BackendKind } from '../catalog/run-config.js';
import type { VramProbe } from '../telemetry/vram-probe.js';

/** Rendered wherever an API-backed run would otherwise show VRAM. */
export const API_BACKEND_VRAM_REASON =
  'API backend: inference runs on Anthropic hardware, so local VRAM does not apply';

/**
 * Whether a backend version string identifies the Anthropic API
 * backend.
 *
 * @param backendVersion - RunRecord.backendVersion or an adapter's
 *   version() result.
 * @returns True for API-backed runs.
 */
export function isApiBackend(backendVersion: string): boolean {
  return backendVersion.startsWith(ANTHROPIC_BACKEND_PREFIX);
}

/**
 * Constructs the adapter for a backend kind.
 *
 * @param kind - Backend from the run config.
 * @param baseUrl - Endpoint override, mainly for tests.
 * @returns The adapter.
 */
export function createAdapter(kind: BackendKind, baseUrl?: string): BackendAdapter {
  return kind === 'anthropic' ? new AnthropicAdapter(baseUrl) : new OllamaAdapter(baseUrl);
}

/**
 * Resolves the backend kind a stored run was created with, so resume
 * reconnects to the same backend.
 *
 * @param backendVersion - RunRecord.backendVersion.
 * @returns The backend kind.
 */
export function backendKindOf(backendVersion: string): BackendKind {
  return isApiBackend(backendVersion) ? 'anthropic' : 'ollama';
}

/**
 * A probe that measures nothing, for backends with no local process.
 * The reason renders loudly in every report instead of a bare "n/a".
 *
 * @returns A probe whose result is unavailable with the API reason.
 */
export function apiNoopProbe(): VramProbe {
  return {
    gpu: null,
    unavailableReason: API_BACKEND_VRAM_REASON,
    stop: () => Promise.resolve({ available: false, reason: API_BACKEND_VRAM_REASON }),
  };
}
