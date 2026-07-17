/**
 * A throwaway HTTP server shaped like the Anthropic API: models
 * list/retrieve plus a streaming /v1/messages that returns a scripted
 * completion. The adapter and pipeline tests drive the real SDK
 * against it, so the HTTP boundary is the honest fake boundary.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

/** Behavior knobs the tests flip per case. */
export interface FakeAnthropicOptions {
  /** Model ids served by /v1/models. */
  readonly models?: readonly string[];
  /** Text chunks streamed for every generation. */
  readonly completion?: readonly string[];
  /** When set, /v1/messages rejects bodies containing "temperature". */
  readonly rejectTemperature?: boolean;
  /** When set, /v1/messages always answers 429 with retry-after 0. */
  readonly rateLimited?: boolean;
}

/** A running fake server. */
export interface FakeAnthropic {
  readonly baseUrl: string;
  close(): void;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((done) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      done(body);
    });
  });
}

function streamCompletion(res: ServerResponse, model: string, chunks: readonly string[]): void {
  res.setHeader('content-type', 'text/event-stream');
  const events: { event: string; data: unknown }[] = [
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: 'msg_test', type: 'message', role: 'assistant', model,
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 42, output_tokens: 0 },
        },
      },
    },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    ...chunks.map((text) => ({
      event: 'content_block_delta',
      data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    })),
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ];
  for (const e of events) {
    res.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
  }
  res.end();
}

/**
 * Starts the fake server on an ephemeral port.
 *
 * @param options - Behavior knobs; sensible defaults otherwise.
 * @returns Base url and a close handle.
 */
export async function startFakeAnthropic(options: FakeAnthropicOptions = {}): Promise<FakeAnthropic> {
  const models = options.models ?? ['claude-haiku-4-5', 'claude-sonnet-5'];
  const completion = options.completion ?? ['bil', 'ling'];
  const server: Server = createServer((req, res) => {
    void (async (): Promise<void> => {
      if (req.url === '/v1/models' && req.method === 'GET') {
        json(res, 200, {
          data: models.map((id) => ({ type: 'model', id, display_name: id, created_at: '2025-10-01T00:00:00Z' })),
          has_more: false, first_id: null, last_id: null,
        });
        return;
      }
      if (req.url?.startsWith('/v1/models/') && req.method === 'GET') {
        const id = req.url.slice('/v1/models/'.length);
        if (models.includes(id)) {
          json(res, 200, { type: 'model', id, display_name: id, created_at: '2025-10-01T00:00:00Z' });
        } else {
          json(res, 404, { type: 'error', error: { type: 'not_found_error', message: `model: ${id}` } });
        }
        return;
      }
      if (req.url === '/v1/messages' && req.method === 'POST') {
        const body = await readBody(req);
        if (options.rateLimited === true) {
          res.setHeader('retry-after', '0');
          json(res, 429, { type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } });
          return;
        }
        if (options.rejectTemperature === true && body.includes('"temperature"')) {
          json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'temperature: not supported on this model' } });
          return;
        }
        const model = (JSON.parse(body) as { model: string }).model;
        streamCompletion(res, model, completion);
        return;
      }
      json(res, 404, { type: 'error', error: { type: 'not_found_error', message: 'no route' } });
    })();
  });
  await new Promise<void>((ready) => {
    server.listen(0, '127.0.0.1', ready);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('fake anthropic server failed to bind');
  }
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    close: () => server.close(),
  };
}
