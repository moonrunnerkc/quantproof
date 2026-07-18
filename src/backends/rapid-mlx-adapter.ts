/**
 * Rapid-MLX backend adapter: plain HTTP against a local Rapid-MLX
 * server (OpenAI-compatible, MLX on Apple Silicon), no SDK. Behavior
 * verified against a live 0.6.0 instance: /v1/models lists only the
 * served model, an unknown model gets HTTP 404 with a detail message,
 * streaming chat completions emit SSE data lines ending in [DONE] with
 * usage in the final chunks when stream_options asks for it, and the
 * server holds exactly one resident model for its whole lifetime, so
 * load and unload have nothing to do.
 *
 * The live instance also showed a prompt cache that can replay
 * completions for repeated identical requests; the adapter clears it
 * before every generation so repetition latency measures fresh
 * inference, not cache hits.
 */

import { performance } from 'node:perf_hooks';
import type {
  BackendAdapter,
  GenerationRequest,
  GenerationStream,
  GenerationSummary,
  ModelDescriptor,
  TokenEvent,
} from './backend-adapter.js';

/** Where a stock rapid-mlx serve listens. */
export const DEFAULT_RAPID_MLX_URL = 'http://localhost:8000';

/** Prefix that marks a run as Rapid-MLX-backed in backendVersion. */
export const RAPID_MLX_BACKEND_PREFIX = 'rapid-mlx';

const START_HINT = 'start it with: rapid-mlx serve <model>';

/** Splits a streaming body into SSE data payloads, ending on [DONE]. */
async function* readSseData(body: AsyncIterable<Uint8Array>): AsyncGenerator<string, void, void> {
  const decoder = new TextDecoder();
  let buffered = '';
  for await (const chunk of body) {
    buffered += decoder.decode(chunk, { stream: true });
    let newline = buffered.indexOf('\n');
    while (newline !== -1) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line.startsWith('data: ')) {
        const payload = line.slice(6);
        if (payload === '[DONE]') {
          return;
        }
        yield payload;
      }
      newline = buffered.indexOf('\n');
    }
  }
}

function fieldOf(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

/** Adapter for a local Rapid-MLX server. */
export class RapidMlxAdapter implements BackendAdapter {
  private readonly baseUrl: string;

  constructor(baseUrl: string = DEFAULT_RAPID_MLX_URL) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, init);
    } catch (err) {
      throw new Error(`cannot reach Rapid-MLX at ${this.baseUrl}; ${START_HINT}`, { cause: err });
    }
    if (!response.ok) {
      let detail = await response.text();
      try {
        const parsed: unknown = JSON.parse(detail);
        const message = fieldOf(parsed, 'detail');
        detail = typeof message === 'string' ? message : detail;
      } catch {
        // Non-JSON error bodies render as-is.
      }
      throw new Error(`Rapid-MLX ${path} failed (HTTP ${String(response.status)}): ${detail}`);
    }
    return response;
  }

  private async requestJson(path: string, init?: RequestInit): Promise<unknown> {
    const response = await this.request(path, init);
    return response.json();
  }

  /** @inheritdoc */
  async version(): Promise<string> {
    const body = await this.requestJson('/openapi.json');
    const version = fieldOf(fieldOf(body, 'info'), 'version');
    return `${RAPID_MLX_BACKEND_PREFIX} ${typeof version === 'string' ? version : 'unknown'}`;
  }

  /**
   * Maps a served model id onto the descriptor shape. Rapid-MLX does
   * not expose weight files, quant tags, or digests over the API, so
   * sizeBytes is 0, quant and params are null, and the served name
   * doubles as the digest; memory is measured during the run instead
   * of predicted.
   */
  private describe(id: string): ModelDescriptor {
    return { name: id, digest: id, sizeBytes: 0, quantization: null, parameterSize: null, remote: false };
  }

  /** @inheritdoc */
  async listModels(): Promise<readonly ModelDescriptor[]> {
    const body = await this.requestJson('/v1/models');
    const data = fieldOf(body, 'data');
    if (!Array.isArray(data)) {
      return [];
    }
    return data
      .map((entry) => fieldOf(entry, 'id'))
      .filter((id): id is string => typeof id === 'string')
      .map((id) => this.describe(id));
  }

  /**
   * @inheritdoc
   * Rapid-MLX cannot pull models at runtime; the served set is fixed
   * when the server starts, so an absent model is a restart, not a
   * download.
   */
  async ensureModelAvailable(model: string): Promise<ModelDescriptor> {
    const served = await this.listModels();
    const found = served.find((m) => m.name === model);
    if (found === undefined) {
      const names = served.map((m) => m.name).join(', ');
      throw new Error(
        `model "${model}" is not served by Rapid-MLX (serving: ${names === '' ? 'nothing' : names}); restart it with: rapid-mlx serve ${model}`,
      );
    }
    return found;
  }

  /**
   * The served model is resident for the server's whole lifetime and
   * context length is fixed at server start, so load only verifies the
   * server reports itself ready.
   */
  async load(_model: string, _context: number): Promise<void> {
    const health = await this.requestJson('/health');
    if (fieldOf(health, 'model_loaded') !== true) {
      throw new Error(`Rapid-MLX at ${this.baseUrl} reports no model loaded; ${START_HINT}`);
    }
  }

  /** @inheritdoc */
  generate(model: string, request: GenerationRequest): GenerationStream {
    const requestBody = {
      model,
      messages: [{ role: 'user', content: request.prompt }],
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      seed: request.seed,
      stream: true,
      stream_options: { include_usage: true },
    };
    const baseRequest = this.request.bind(this);

    async function* stream(): AsyncGenerator<TokenEvent, GenerationSummary, void> {
      // Fresh-inference latency: without this, the server's prompt
      // cache replays repeated identical requests at ~0 TTFT.
      let promptCache = 'cleared before request';
      try {
        await baseRequest('/v1/cache/clear', { method: 'POST' });
      } catch (err) {
        promptCache = `clear failed (${err instanceof Error ? err.message : String(err)}); latency may include cache hits`;
      }
      const startedAt = performance.now();
      const response = await baseRequest('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });
      if (response.body === null) {
        throw new Error('Rapid-MLX /v1/chat/completions returned no body; check the server logs');
      }

      let output = '';
      let doneReason: string | null = null;
      let promptTokenCount: number | null = null;
      let outputTokenCount: number | null = null;
      for await (const payload of readSseData(response.body)) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue;
        }
        const choice: unknown = Array.isArray(fieldOf(parsed, 'choices')) ? (fieldOf(parsed, 'choices') as unknown[])[0] : undefined;
        const text = fieldOf(fieldOf(choice, 'delta'), 'content');
        if (typeof text === 'string' && text !== '') {
          output += text;
          yield { text, at: performance.now() };
        }
        const finish = fieldOf(choice, 'finish_reason');
        if (typeof finish === 'string') {
          doneReason = finish;
        }
        const usage = fieldOf(parsed, 'usage');
        const prompt = fieldOf(usage, 'prompt_tokens');
        const completion = fieldOf(usage, 'completion_tokens');
        promptTokenCount = typeof prompt === 'number' ? prompt : promptTokenCount;
        outputTokenCount = typeof completion === 'number' ? completion : outputTokenCount;
      }
      if (doneReason === null) {
        throw new Error('Rapid-MLX stream ended without a finish_reason; the server likely dropped the request');
      }
      return {
        output,
        startedAt,
        finishedAt: performance.now(),
        doneReason,
        promptTokenCount,
        outputTokenCount,
        requestOptions: {
          model,
          max_tokens: request.maxTokens,
          temperature: request.temperature,
          seed: request.seed,
          context: 'not-applicable (context is fixed when the rapid-mlx server starts)',
          prompt_cache: promptCache,
        },
      };
    }
    return stream();
  }

  /**
   * The server keeps its one model resident by design; there is
   * nothing to unload, and the next candidate needs its own server.
   */
  unload(_model: string): Promise<void> {
    return Promise.resolve();
  }
}
