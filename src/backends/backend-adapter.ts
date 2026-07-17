/**
 * Backend adapter interface. Designed around what the orchestrator
 * needs: check a model exists, load it at a context length, stream a
 * generation with timestamps (so TTFT is derivable), force an unload,
 * and identify the backend for the environment line. Ollama is made to
 * fit this shape, not the reverse.
 */

/** A model the backend can serve, as reported by the backend itself. */
export interface ModelDescriptor {
  /** Name as the backend knows it, e.g. "gemma3:1b". */
  readonly name: string;
  /** Content digest identifying the exact weights. */
  readonly digest: string;
  /** On-disk size in bytes. */
  readonly sizeBytes: number;
  /** Quant tag as reported, e.g. "Q4_K_M"; null when not reported. */
  readonly quantization: string | null;
  /** Parameter count as reported, e.g. "999.89M"; null when absent. */
  readonly parameterSize: string | null;
  /**
   * True for models served remotely (Ollama cloud entries). Remote
   * models cannot be measured locally and are excluded from sweeps.
   */
  readonly remote: boolean;
}

/** Generation parameters, taken verbatim from the task manifest. */
export interface GenerationRequest {
  readonly prompt: string;
  /** Context window in tokens (num_ctx for Ollama). */
  readonly context: number;
  /** Generation cap in tokens (num_predict for Ollama). */
  readonly maxTokens: number;
  readonly temperature: number;
  readonly seed: number;
}

/** One streamed chunk with the moment it arrived. */
export interface TokenEvent {
  readonly text: string;
  /** Milliseconds on the same monotonic clock as GenerationSummary. */
  readonly at: number;
}

/** Final accounting for one generation, returned when the stream ends. */
export interface GenerationSummary {
  /** Full output text (concatenation of every streamed chunk). */
  readonly output: string;
  /** When the HTTP request was sent, monotonic ms. */
  readonly startedAt: number;
  /** When the final stream line arrived, monotonic ms. */
  readonly finishedAt: number;
  /** Backend's reason for stopping, e.g. "stop" or "length". */
  readonly doneReason: string;
  /** Prompt token count as reported by the backend; null if absent. */
  readonly promptTokenCount: number | null;
  /** Output token count as reported by the backend; null if absent. */
  readonly outputTokenCount: number | null;
  /**
   * The exact request options sent to the backend, recorded so a run
   * is reproducible from its result record alone.
   */
  readonly requestOptions: Readonly<Record<string, unknown>>;
}

/**
 * The streaming generation handle: iterate for token events, and the
 * generator's return value is the summary. Consume with the timing
 * probe or a manual `for await` loop followed by `next()`.
 */
export type GenerationStream = AsyncGenerator<TokenEvent, GenerationSummary, void>;

/**
 * A backend that can serve models for evaluation runs. Implementations
 * must fail fast with an actionable message (including the exact
 * command to run) when the backend is unreachable.
 */
export interface BackendAdapter {
  /** Backend identity for the environment line, e.g. "ollama 0.23.1". */
  version(): Promise<string>;
  /** Lists every model in the backend's local store. */
  listModels(): Promise<readonly ModelDescriptor[]>;
  /**
   * Ensures the model is present locally, pulling it if the backend
   * supports that, and returns its descriptor. Throws when the model
   * does not exist or the backend is unreachable.
   */
  ensureModelAvailable(model: string): Promise<ModelDescriptor>;
  /** Loads the model at the given context length without generating. */
  load(model: string, context: number): Promise<void>;
  /** Starts a streaming generation. */
  generate(model: string, request: GenerationRequest): GenerationStream;
  /** Forces the model out of memory. Must be safe to call repeatedly. */
  unload(model: string): Promise<void>;
}
