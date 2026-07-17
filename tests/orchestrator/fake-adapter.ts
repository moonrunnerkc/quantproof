/**
 * Scriptable fake backend adapter for executor tests. The adapter
 * interface is the legitimate fake boundary: this simulates streams,
 * mid-generation crashes, and transport failures without any HTTP.
 */

import { performance } from 'node:perf_hooks';
import type {
  BackendAdapter,
  GenerationRequest,
  GenerationStream,
  ModelDescriptor,
} from '../../src/backends/backend-adapter.js';

/** What one generate() call should do. */
export type FakeBehavior =
  | { readonly kind: 'ok'; readonly output: string; readonly tokenDelayMs?: number }
  | { readonly kind: 'crash-mid-stream'; readonly afterTokens: number; readonly message: string }
  | { readonly kind: 'transport-error' };

/** Chooses a behavior for the nth generate() call (0-based). */
export type BehaviorScript = (prompt: string, callIndex: number) => FakeBehavior;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class FakeAdapter implements BackendAdapter {
  readonly loads: { model: string; context: number }[] = [];
  readonly unloads: string[] = [];
  readonly generatePrompts: string[] = [];
  private readonly script: BehaviorScript;

  constructor(script: BehaviorScript) {
    this.script = script;
  }

  /** Models returned by listModels; tests may replace the contents. */
  localModels: ModelDescriptor[] = [];

  version(): Promise<string> {
    return Promise.resolve('fake-backend 1.0');
  }

  listModels(): Promise<readonly ModelDescriptor[]> {
    return Promise.resolve(this.localModels);
  }

  ensureModelAvailable(model: string): Promise<ModelDescriptor> {
    return Promise.resolve(
      this.localModels.find((m) => m.name === model) ?? {
        name: model,
        digest: 'f'.repeat(64),
        sizeBytes: 1000,
        quantization: 'Q4_K_M',
        parameterSize: '1B',
        remote: false,
      },
    );
  }

  load(model: string, context: number): Promise<void> {
    this.loads.push({ model, context });
    return Promise.resolve();
  }

  generate(model: string, request: GenerationRequest): GenerationStream {
    const callIndex = this.generatePrompts.length;
    this.generatePrompts.push(request.prompt);
    const behavior = this.script(request.prompt, callIndex);
    const requestOptions = {
      model,
      options: {
        temperature: request.temperature,
        seed: request.seed,
        num_predict: request.maxTokens,
        num_ctx: request.context,
      },
    };

    async function* stream(): GenerationStream {
      const startedAt = performance.now();
      if (behavior.kind === 'transport-error') {
        await sleep(0);
        throw new Error('cannot reach Ollama at http://fake; start it with: ollama serve');
      }
      if (behavior.kind === 'crash-mid-stream') {
        for (let i = 0; i < behavior.afterTokens; i += 1) {
          await sleep(1);
          yield { text: 'x', at: performance.now() };
        }
        throw new Error(behavior.message);
      }
      let output = '';
      for (const char of behavior.output) {
        await sleep(behavior.tokenDelayMs ?? 0);
        output += char;
        yield { text: char, at: performance.now() };
      }
      return {
        output,
        startedAt,
        finishedAt: performance.now(),
        doneReason: 'stop',
        promptTokenCount: 12,
        outputTokenCount: output.length,
        requestOptions,
      };
    }
    return stream();
  }

  unload(model: string): Promise<void> {
    this.unloads.push(model);
    return Promise.resolve();
  }
}
