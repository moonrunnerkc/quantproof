/**
 * Anthropic API backend adapter: runs task packs against Claude models
 * over the streaming Messages API, so quality and latency stay
 * measurable without any local GPU. Nothing local is loaded, so load
 * and unload are no-ops and VRAM never applies; the run and its
 * reports label this backend explicitly so an API table can never be
 * mistaken for a local-model measurement.
 *
 * The API key comes from ANTHROPIC_API_KEY only, is passed straight to
 * the SDK client, and never enters logs, records, or bundles. Retry
 * policy rides on the SDK defaults, which match the design exactly:
 * rate limits retry with backoff honoring retry-after, transient
 * server errors retry twice, invalid requests never retry.
 */

import { performance } from 'node:perf_hooks';
import Anthropic from '@anthropic-ai/sdk';
import { VERSION as SDK_VERSION } from '@anthropic-ai/sdk/version';
import type {
  BackendAdapter,
  GenerationRequest,
  GenerationStream,
  GenerationSummary,
  ModelDescriptor,
  TokenEvent,
} from './backend-adapter.js';

/** Prefix that marks a run as API-backed everywhere it is rendered. */
export const ANTHROPIC_BACKEND_PREFIX = 'anthropic api';

/**
 * Reads the API key from the environment.
 *
 * @returns The key.
 * @throws Error with the exact export command when ANTHROPIC_API_KEY
 *   is unset or empty.
 */
export function requireApiKey(): string {
  const key = process.env['ANTHROPIC_API_KEY'];
  if (key === undefined || key === '') {
    throw new Error(
      'ANTHROPIC_API_KEY is not set, so the anthropic backend cannot authenticate; create a key at console.anthropic.com and run: export ANTHROPIC_API_KEY=sk-ant-...',
    );
  }
  return key;
}

function describeApiError(err: unknown): Error {
  if (err instanceof Anthropic.AuthenticationError) {
    return new Error(
      'the Anthropic API rejected the key in ANTHROPIC_API_KEY; check the key at console.anthropic.com and re-export it',
      { cause: err },
    );
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new Error(
      'the Anthropic API rate limit held even after automatic backoff retries; wait a minute, then continue with: quantproof resume',
      { cause: err },
    );
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new Error(
      `cannot reach the Anthropic API (${err.message}); check the network connection and retry`,
      { cause: err },
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}

function isTemperatureRejection(err: unknown): boolean {
  return err instanceof Anthropic.BadRequestError && /temperature/i.test(err.message);
}

/** Adapter for the Anthropic Messages API. */
export class AnthropicAdapter implements BackendAdapter {
  private readonly baseUrl: string | undefined;
  private sdk: Anthropic | null = null;

  /**
   * @param baseUrl - API endpoint override, for tests against a fake
   *   server; production omits it.
   */
  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl;
  }

  private client(): Anthropic {
    this.sdk ??= new Anthropic({
      apiKey: requireApiKey(),
      ...(this.baseUrl === undefined ? {} : { baseURL: this.baseUrl }),
    });
    return this.sdk;
  }

  /** @inheritdoc */
  version(): Promise<string> {
    this.client();
    return Promise.resolve(`${ANTHROPIC_BACKEND_PREFIX} (sdk ${SDK_VERSION})`);
  }

  /** @inheritdoc */
  async listModels(): Promise<readonly ModelDescriptor[]> {
    const descriptors: ModelDescriptor[] = [];
    try {
      for await (const model of this.client().models.list()) {
        descriptors.push(this.describe(model.id));
      }
    } catch (err) {
      throw describeApiError(err);
    }
    return descriptors;
  }

  /**
   * Maps a model id onto the descriptor shape. API models have no
   * local weights: sizeBytes 0 marks "no local footprint" for the
   * recommendation logic, and the model id doubles as the digest
   * because it is the version pin the API exposes.
   */
  private describe(id: string): ModelDescriptor {
    return {
      name: id,
      digest: id,
      sizeBytes: 0,
      quantization: null,
      parameterSize: null,
      remote: false,
    };
  }

  /** @inheritdoc */
  async ensureModelAvailable(model: string): Promise<ModelDescriptor> {
    try {
      const found = await this.client().models.retrieve(model);
      return this.describe(found.id);
    } catch (err) {
      if (err instanceof Anthropic.NotFoundError) {
        throw new Error(
          `model "${model}" is not available on the Anthropic API; list valid ids with: quantproof models --backend anthropic`,
          { cause: err },
        );
      }
      throw describeApiError(err);
    }
  }

  /** No local process exists, so load is a no-op. */
  load(_model: string, _context: number): Promise<void> {
    return Promise.resolve();
  }

  /** @inheritdoc */
  generate(model: string, request: GenerationRequest): GenerationStream {
    const client = this.client();

    async function* stream(): AsyncGenerator<TokenEvent, GenerationSummary, void> {
      const startedAt = performance.now();
      // Seed and context sizing have no Messages API equivalent; they
      // are recorded as not-applicable instead of silently dropped.
      let temperature: number | string = request.temperature;
      let yielded = 0;
      for (const withTemperature of [true, false]) {
        try {
          const message = client.messages.stream({
            model,
            max_tokens: request.maxTokens,
            ...(withTemperature ? { temperature: request.temperature } : {}),
            messages: [{ role: 'user', content: request.prompt }],
          });
          let output = '';
          for await (const event of message) {
            if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
              output += event.delta.text;
              yielded += 1;
              yield { text: event.delta.text, at: performance.now() };
            }
          }
          const final = await message.finalMessage();
          return {
            output,
            startedAt,
            finishedAt: performance.now(),
            doneReason: final.stop_reason ?? 'unknown',
            promptTokenCount: final.usage.input_tokens,
            outputTokenCount: final.usage.output_tokens,
            requestOptions: {
              model,
              max_tokens: request.maxTokens,
              temperature,
              seed: 'not-applicable (the Messages API has no sampler seed)',
              context: 'not-applicable (the context window is model-defined)',
            },
          };
        } catch (err) {
          if (withTemperature && yielded === 0 && isTemperatureRejection(err)) {
            temperature = `not-applicable (${model} rejects the temperature parameter)`;
            continue;
          }
          throw describeApiError(err);
        }
      }
      throw new Error(`the Anthropic API rejected the request for ${model} twice; this is a bug, report it`);
    }
    return stream();
  }

  /** No local process exists, so unload is a no-op. */
  unload(_model: string): Promise<void> {
    return Promise.resolve();
  }
}
