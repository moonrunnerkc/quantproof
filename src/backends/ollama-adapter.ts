/**
 * Ollama backend adapter: plain HTTP against a local Ollama server, no
 * SDK. Endpoint behavior verified against a live 0.23.1 instance:
 * empty-prompt generate loads a model (done_reason "load"), the same
 * request with keep_alive 0 unloads it (done_reason "unload"), and
 * streaming generate emits JSONL token lines ending in a done line
 * with eval counts.
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
import { descriptorFromTags, parseErrorBody, parseGenerateLine, parsePullLine } from './ollama-parse.js';

export const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

/** Splits a streaming HTTP body into complete lines. */
async function* readLines(body: AsyncIterable<Uint8Array>): AsyncGenerator<string, void, void> {
  const decoder = new TextDecoder();
  let buffered = '';
  for await (const chunk of body) {
    buffered += decoder.decode(chunk, { stream: true });
    let newline = buffered.indexOf('\n');
    while (newline !== -1) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line.trim() !== '') {
        yield line;
      }
      newline = buffered.indexOf('\n');
    }
  }
  if (buffered.trim() !== '') {
    yield buffered;
  }
}

/** Adapter for a local Ollama server. */
export class OllamaAdapter implements BackendAdapter {
  private readonly baseUrl: string;

  constructor(baseUrl: string = DEFAULT_OLLAMA_URL) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, init);
    } catch (err) {
      throw new Error(
        `cannot reach Ollama at ${this.baseUrl}; start it with: ollama serve`,
        { cause: err },
      );
    }
    if (!response.ok) {
      const message = parseErrorBody(await response.text());
      throw new Error(`Ollama ${path} failed (HTTP ${String(response.status)}): ${message}`);
    }
    return response;
  }

  private async requestJson(path: string, init?: RequestInit): Promise<unknown> {
    const response = await this.request(path, init);
    return response.json();
  }

  /** @inheritdoc */
  async version(): Promise<string> {
    const body = await this.requestJson('/api/version');
    const version =
      typeof body === 'object' && body !== null && 'version' in body
        ? String((body as Record<string, unknown>)['version'])
        : 'unknown';
    return `ollama ${version}`;
  }

  /** @inheritdoc */
  async ensureModelAvailable(model: string): Promise<ModelDescriptor> {
    const listed = descriptorFromTags(await this.requestJson('/api/tags'), model);
    if (listed !== null) {
      return listed;
    }
    await this.pull(model);
    const pulled = descriptorFromTags(await this.requestJson('/api/tags'), model);
    if (pulled === null) {
      throw new Error(
        `model "${model}" is still not in the local Ollama store after a pull; check the name with: ollama list`,
      );
    }
    return pulled;
  }

  private async pull(model: string): Promise<void> {
    const response = await this.request('/api/pull', {
      method: 'POST',
      body: JSON.stringify({ model, stream: true }),
    });
    if (response.body === null) {
      throw new Error(`Ollama /api/pull returned no body for "${model}"; retry with: ollama pull ${model}`);
    }
    try {
      for await (const line of readLines(response.body)) {
        parsePullLine(line);
      }
    } catch (err) {
      throw new Error(
        `pulling "${model}" failed: ${err instanceof Error ? err.message : String(err)}; verify the name and retry with: ollama pull ${model}`,
        { cause: err },
      );
    }
  }

  /** @inheritdoc */
  async load(model: string, context: number): Promise<void> {
    await this.requestJson('/api/generate', {
      method: 'POST',
      body: JSON.stringify({ model, prompt: '', stream: false, options: { num_ctx: context } }),
    });
  }

  /** @inheritdoc */
  generate(model: string, request: GenerationRequest): GenerationStream {
    const options = {
      temperature: request.temperature,
      seed: request.seed,
      num_predict: request.maxTokens,
      num_ctx: request.context,
    };
    const requestOptions = { model, options };
    const baseRequest = this.request.bind(this);

    async function* stream(): AsyncGenerator<TokenEvent, GenerationSummary, void> {
      const startedAt = performance.now();
      const response = await baseRequest('/api/generate', {
        method: 'POST',
        body: JSON.stringify({ model, prompt: request.prompt, stream: true, options }),
      });
      if (response.body === null) {
        throw new Error('Ollama /api/generate returned no body; check the server logs (journalctl -u ollama)');
      }

      let output = '';
      let done: { doneReason: string; promptTokenCount: number | null; outputTokenCount: number | null } | null = null;
      for await (const line of readLines(response.body)) {
        const parsed = parseGenerateLine(line);
        if (parsed.kind === 'error') {
          throw new Error(`Ollama generation failed mid-stream: ${parsed.message}`);
        }
        if (parsed.kind === 'done') {
          done = parsed;
          break;
        }
        output += parsed.text;
        yield { text: parsed.text, at: performance.now() };
      }
      if (done === null) {
        throw new Error(
          'Ollama generation stream ended without a done line; the server likely crashed mid-generation',
        );
      }
      return {
        output,
        startedAt,
        finishedAt: performance.now(),
        doneReason: done.doneReason,
        promptTokenCount: done.promptTokenCount,
        outputTokenCount: done.outputTokenCount,
        requestOptions,
      };
    }
    return stream();
  }

  /** @inheritdoc */
  async unload(model: string): Promise<void> {
    await this.requestJson('/api/generate', {
      method: 'POST',
      body: JSON.stringify({ model, prompt: '', stream: false, keep_alive: 0 }),
    });
  }
}
