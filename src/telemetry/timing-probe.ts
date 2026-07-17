/**
 * Timing probe: consumes a backend generation stream and derives
 * time-to-first-token, tokens per second after the first token, and
 * wall time from the stream's own timestamps. Purely observational; it
 * never alters the tokens.
 */

import type { GenerationStream, GenerationSummary, TokenEvent } from '../backends/backend-adapter.js';

/** Timing derived from one generation's token timestamps. */
export interface GenerationTiming {
  /** Milliseconds from request start to the first token; null when the
   * generation produced no tokens. */
  readonly ttftMs: number | null;
  /** Streamed-chunk rate after the first token; null when fewer than
   * two tokens arrived or they arrived within the same millisecond. */
  readonly tokensPerSecond: number | null;
  /** Milliseconds from request start to stream end. */
  readonly wallMs: number;
  /** Number of streamed chunks (one per token for Ollama). */
  readonly tokenCount: number;
}

/** A fully consumed generation: summary, events, and derived timing. */
export interface ObservedGeneration {
  readonly summary: GenerationSummary;
  readonly events: readonly TokenEvent[];
  readonly timing: GenerationTiming;
}

/**
 * Derives timing numbers from token timestamps.
 *
 * @param startedAt - Request start on the stream's monotonic clock.
 * @param finishedAt - Stream end on the same clock.
 * @param events - Token events in arrival order.
 * @returns The derived timing. Never throws; degenerate streams (no
 *   tokens, single token) produce nulls rather than fabricated rates.
 */
export function deriveTiming(
  startedAt: number,
  finishedAt: number,
  events: readonly TokenEvent[],
): GenerationTiming {
  const first = events[0];
  const last = events[events.length - 1];
  const spanMs = first !== undefined && last !== undefined ? last.at - first.at : 0;
  return {
    ttftMs: first === undefined ? null : first.at - startedAt,
    tokensPerSecond: events.length < 2 || spanMs <= 0 ? null : ((events.length - 1) * 1000) / spanMs,
    wallMs: finishedAt - startedAt,
    tokenCount: events.length,
  };
}

/**
 * Consumes a generation stream to completion, collecting every token
 * event and deriving timing from the stream's timestamps.
 *
 * @param stream - A backend adapter generation stream.
 * @returns The summary, the raw events, and the derived timing.
 * @throws Whatever the stream throws (transport failures, backend
 *   crashes); the caller owns retry policy.
 */
export async function observeGeneration(stream: GenerationStream): Promise<ObservedGeneration> {
  const events: TokenEvent[] = [];
  let next = await stream.next();
  while (next.done !== true) {
    events.push(next.value);
    next = await stream.next();
  }
  const summary = next.value;
  return {
    summary,
    events,
    timing: deriveTiming(summary.startedAt, summary.finishedAt, events),
  };
}
