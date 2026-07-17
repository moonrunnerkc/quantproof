/**
 * Model architecture metadata for fit prediction. Primary source is
 * the metadata Ollama exposes over /api/show (model_info); the GGUF
 * header in the blob store is read only when the API lacks a needed
 * field. Unknown or exotic architectures degrade to null, never throw.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readGgufMetadata } from './gguf-reader.js';
import type { GgufScalar } from './gguf-reader.js';

/** The fields the fit predictor needs, per candidate. */
export interface ModelArchitecture {
  /** e.g. "gemma3", "qwen3". */
  readonly architecture: string;
  /** Transformer layer count. */
  readonly blockCount: number;
  /** KV heads per layer (GQA-aware). */
  readonly kvHeadCount: number;
  /** Per-head key size in elements. */
  readonly keyLength: number;
  /** Per-head value size in elements. */
  readonly valueLength: number;
  /** Training context length declared by the model. */
  readonly maxContext: number;
}

/** Provides raw show metadata; the Ollama adapter implements this. */
export interface ModelInfoSource {
  /** Returns model_info key/values, or null when unavailable. */
  showModelInfo(model: string): Promise<Readonly<Record<string, unknown>> | null>;
}

function numberField(info: Readonly<Record<string, unknown>>, key: string): number | null {
  const value = info[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Extracts architecture fields from a model_info record (the shape
 * /api/show returns, or GGUF header entries converted to a record).
 *
 * @param info - Flat metadata record with `<arch>.*` keys.
 * @returns The architecture, or null when any required field is
 *   missing or malformed. Never throws.
 */
export function architectureFromInfo(
  info: Readonly<Record<string, unknown>>,
): ModelArchitecture | null {
  const architecture = info['general.architecture'];
  if (typeof architecture !== 'string' || architecture === '') {
    return null;
  }
  const blockCount = numberField(info, `${architecture}.block_count`);
  const kvHeadCount =
    numberField(info, `${architecture}.attention.head_count_kv`) ??
    numberField(info, `${architecture}.attention.head_count`);
  const headCount = numberField(info, `${architecture}.attention.head_count`);
  const embedding = numberField(info, `${architecture}.embedding_length`);
  const derivedHeadDim = headCount !== null && embedding !== null ? embedding / headCount : null;
  const keyLength = numberField(info, `${architecture}.attention.key_length`) ?? derivedHeadDim;
  const valueLength = numberField(info, `${architecture}.attention.value_length`) ?? derivedHeadDim;
  const maxContext = numberField(info, `${architecture}.context_length`);
  if (blockCount === null || kvHeadCount === null || keyLength === null || valueLength === null || maxContext === null) {
    return null;
  }
  return { architecture, blockCount, kvHeadCount, keyLength, valueLength, maxContext };
}

/**
 * Candidate store locations, most specific first: the OLLAMA_MODELS
 * override, a user-mode install, then the systemd service default.
 */
function defaultModelsDirs(): string[] {
  const dirs: string[] = [];
  const override = process.env['OLLAMA_MODELS'];
  if (override !== undefined && override !== '') {
    dirs.push(override);
  }
  dirs.push(join(homedir(), '.ollama', 'models'));
  dirs.push('/usr/share/ollama/.ollama/models');
  return dirs;
}

/**
 * Locates the GGUF weights blob for a model in the local Ollama store
 * by walking the manifest, and reads its header metadata.
 *
 * @param model - Model name like "gemma3:1b".
 * @param modelsDir - Ollama models directory; when omitted, the first
 *   of $OLLAMA_MODELS, ~/.ollama/models, or the systemd default that
 *   holds the model's manifest is used.
 * @returns Header metadata as a flat record, or null when the
 *   manifest or blob cannot be found or parsed. Never throws.
 */
export function readBlobMetadata(
  model: string,
  modelsDir?: string,
): Readonly<Record<string, GgufScalar>> | null {
  try {
    const [repo, tag = 'latest'] = model.split(':');
    const relative = join('manifests', 'registry.ollama.ai', 'library', repo ?? '', tag);
    const storeDir = (modelsDir === undefined ? defaultModelsDirs() : [modelsDir]).find((dir) =>
      existsSync(join(dir, relative)),
    );
    if (storeDir === undefined) {
      return null;
    }
    const manifestPath = join(storeDir, relative);
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (typeof manifest !== 'object' || manifest === null) {
      return null;
    }
    const layers = (manifest as Record<string, unknown>)['layers'];
    if (!Array.isArray(layers)) {
      return null;
    }
    const modelLayer = layers.find(
      (layer): layer is Record<string, unknown> =>
        typeof layer === 'object' && layer !== null &&
        (layer as Record<string, unknown>)['mediaType'] === 'application/vnd.ollama.image.model',
    );
    const digest = modelLayer?.['digest'];
    if (typeof digest !== 'string') {
      return null;
    }
    const blobPath = join(storeDir, 'blobs', digest.replace(':', '-'));
    return Object.fromEntries(readGgufMetadata(blobPath));
  } catch {
    return null;
  }
}

/**
 * Resolves a model's architecture: API metadata first, GGUF blob
 * header as the fallback when the API answer is incomplete.
 *
 * @param source - Show-metadata source (the Ollama adapter).
 * @param model - Model name.
 * @returns The architecture, or null when neither source has the
 *   needed fields; fit prediction then reports unknown. Never throws.
 */
export async function resolveArchitecture(
  source: ModelInfoSource,
  model: string,
): Promise<ModelArchitecture | null> {
  let info: Readonly<Record<string, unknown>> | null;
  try {
    info = await source.showModelInfo(model);
  } catch {
    info = null;
  }
  if (info !== null) {
    const fromApi = architectureFromInfo(info);
    if (fromApi !== null) {
      return fromApi;
    }
  }
  const fromBlob = readBlobMetadata(model);
  return fromBlob === null ? null : architectureFromInfo(fromBlob);
}
