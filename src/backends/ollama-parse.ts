/**
 * Pure parsers for Ollama HTTP response bodies, verified against
 * captured responses from a live 0.23.1 instance (tests/fixtures/
 * ollama). Kept free of I/O so the shapes are testable without a
 * server.
 */

import type { ModelDescriptor } from './backend-adapter.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Extracts the error message from an Ollama error body, which is
 * always `{"error": "..."}` on non-2xx responses.
 *
 * @param body - Raw response body text.
 * @returns The error message, or the raw body when it does not match
 *   the error envelope (never throws; this runs inside error paths).
 */
export function parseErrorBody(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed) && typeof parsed['error'] === 'string') {
      return parsed['error'];
    }
  } catch {
    // Not JSON; fall through to the raw body.
  }
  return body.trim() === '' ? 'empty error response' : body.trim();
}

function descriptorFromEntry(entry: Record<string, unknown>): ModelDescriptor | null {
  if (typeof entry['name'] !== 'string') {
    return null;
  }
  const details = isRecord(entry['details']) ? entry['details'] : {};
  return {
    name: entry['name'],
    digest: typeof entry['digest'] === 'string' ? entry['digest'] : '',
    sizeBytes: typeof entry['size'] === 'number' ? entry['size'] : 0,
    quantization:
      typeof details['quantization_level'] === 'string' && details['quantization_level'] !== ''
        ? details['quantization_level']
        : null,
    parameterSize:
      typeof details['parameter_size'] === 'string' && details['parameter_size'] !== ''
        ? details['parameter_size']
        : null,
    remote: typeof entry['remote_host'] === 'string' && entry['remote_host'] !== '',
  };
}

/**
 * Maps every entry of an /api/tags response to a descriptor, skipping
 * malformed entries.
 *
 * @param tagsBody - Parsed /api/tags JSON.
 * @returns All descriptors; empty for a malformed body.
 */
export function allDescriptorsFromTags(tagsBody: unknown): ModelDescriptor[] {
  if (!isRecord(tagsBody) || !Array.isArray(tagsBody['models'])) {
    return [];
  }
  return (tagsBody['models'] as unknown[])
    .filter(isRecord)
    .map(descriptorFromEntry)
    .filter((d): d is ModelDescriptor => d !== null);
}

/**
 * Finds a model in an /api/tags response and maps it to a descriptor.
 *
 * @param tagsBody - Parsed /api/tags JSON.
 * @param model - Model name to look up; "name" matches exactly, and a
 *   bare name like "gemma3" also matches "gemma3:latest".
 * @returns The descriptor, or null when the model is not in the list.
 */
export function descriptorFromTags(tagsBody: unknown, model: string): ModelDescriptor | null {
  return (
    allDescriptorsFromTags(tagsBody).find(
      (d) => d.name === model || d.name === `${model}:latest`,
    ) ?? null
  );
}

/** One parsed line of a streaming /api/generate response. */
export type GenerateLine =
  | { readonly kind: 'token'; readonly text: string }
  | {
      readonly kind: 'done';
      readonly doneReason: string;
      readonly promptTokenCount: number | null;
      readonly outputTokenCount: number | null;
    }
  | { readonly kind: 'error'; readonly message: string };

/**
 * Parses one JSONL line of a streaming generate response. Live shape:
 * token lines carry `response` with `done: false`; the final line has
 * `done: true` plus `done_reason` and eval counts. Some error paths
 * stream an `{"error": ...}` line instead.
 *
 * @param line - One line of the response body.
 * @returns The parsed line.
 * @throws Error when the line is not JSON or matches no known shape;
 *   that means the API changed and the adapter must not guess.
 */
export function parseGenerateLine(line: string): GenerateLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    throw new Error(
      `Ollama sent an unparseable stream line: ${JSON.stringify(line.slice(0, 200))}; check that http://localhost:11434 is really Ollama`,
      { cause: err },
    );
  }
  if (!isRecord(parsed)) {
    throw new Error(`Ollama stream line is not an object: ${JSON.stringify(line.slice(0, 200))}`);
  }
  if (typeof parsed['error'] === 'string') {
    return { kind: 'error', message: parsed['error'] };
  }
  if (parsed['done'] === true) {
    return {
      kind: 'done',
      doneReason: typeof parsed['done_reason'] === 'string' ? parsed['done_reason'] : 'unknown',
      promptTokenCount:
        typeof parsed['prompt_eval_count'] === 'number' ? parsed['prompt_eval_count'] : null,
      outputTokenCount: typeof parsed['eval_count'] === 'number' ? parsed['eval_count'] : null,
    };
  }
  if (typeof parsed['response'] === 'string') {
    return { kind: 'token', text: parsed['response'] };
  }
  throw new Error(
    `Ollama stream line matches no known shape: ${JSON.stringify(line.slice(0, 200))}`,
  );
}

/**
 * Parses one JSONL line of a streaming /api/pull response: status
 * lines during download, `{"status":"success"}` at the end, or an
 * error envelope.
 *
 * @param line - One line of the pull response body.
 * @returns The status text, or throws on an error line.
 * @throws Error carrying the backend's message when the line is an
 *   error envelope (e.g. unknown model).
 */
export function parsePullLine(line: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return line.trim();
  }
  if (isRecord(parsed) && typeof parsed['error'] === 'string') {
    throw new Error(parsed['error']);
  }
  if (isRecord(parsed) && typeof parsed['status'] === 'string') {
    return parsed['status'];
  }
  return line.trim();
}
