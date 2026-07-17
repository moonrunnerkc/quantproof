import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AnthropicAdapter, requireApiKey } from '../../src/backends/anthropic-adapter.js';
import { observeGeneration } from '../../src/telemetry/timing-probe.js';

const KEY_CANARY = 'sk-ant-test-canary-never-persist-1234';

/** Minimal Anthropic-API-shaped server: models list/retrieve + SSE. */
function sse(res: ServerResponse, events: readonly { event: string; data: unknown }[]): void {
  res.setHeader('content-type', 'text/event-stream');
  for (const e of events) {
    res.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
  }
  res.end();
}

function happyStream(res: ServerResponse, text: readonly string[]): void {
  sse(res, [
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-haiku-4-5',
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 42, output_tokens: 0 },
        },
      },
    },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    ...text.map((t) => ({
      event: 'content_block_delta',
      data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } },
    })),
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);
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

let server: Server;
let baseUrl: string;
let mode: 'happy' | 'reject-temperature' | 'rate-limited' = 'happy';
const savedKey = process.env['ANTHROPIC_API_KEY'];

beforeAll(async () => {
  process.env['ANTHROPIC_API_KEY'] = KEY_CANARY;
  server = createServer((req, res) => {
    void (async (): Promise<void> => {
      if (req.url !== '/v1/messages') {
        res.setHeader('content-type', 'application/json');
      }
      if (req.url === '/v1/models' && req.method === 'GET') {
        res.end(JSON.stringify({
          data: [
            { type: 'model', id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5', created_at: '2025-10-01T00:00:00Z' },
            { type: 'model', id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5', created_at: '2026-01-01T00:00:00Z' },
          ],
          has_more: false, first_id: null, last_id: null,
        }));
        return;
      }
      if (req.url?.startsWith('/v1/models/') && req.method === 'GET') {
        const id = req.url.slice('/v1/models/'.length);
        if (id === 'claude-haiku-4-5') {
          res.end(JSON.stringify({ type: 'model', id, display_name: 'Claude Haiku 4.5', created_at: '2025-10-01T00:00:00Z' }));
        } else {
          res.statusCode = 404;
          res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `model: ${id}` } }));
        }
        return;
      }
      if (req.url === '/v1/messages' && req.method === 'POST') {
        const body = await readBody(req);
        if (mode === 'rate-limited') {
          res.setHeader('content-type', 'application/json');
          res.statusCode = 429;
          res.setHeader('retry-after', '0');
          res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } }));
          return;
        }
        if (mode === 'reject-temperature' && body.includes('"temperature"')) {
          res.setHeader('content-type', 'application/json');
          res.statusCode = 400;
          res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'temperature: not supported on this model' } }));
          return;
        }
        happyStream(res, ['bil', 'ling']);
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'no route' } }));
    })();
  });
  await new Promise<void>((ready) => {
    server.listen(0, '127.0.0.1', ready);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('fake anthropic server failed to bind');
  }
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
});

afterAll(() => {
  server.close();
  if (savedKey === undefined) {
    delete process.env['ANTHROPIC_API_KEY'];
  } else {
    process.env['ANTHROPIC_API_KEY'] = savedKey;
  }
});

const request = { prompt: 'classify this', context: 2048, maxTokens: 16, temperature: 0, seed: 42 };

describe('requireApiKey', () => {
  it('fails fast with the exact export command when the key is unset', () => {
    delete process.env['ANTHROPIC_API_KEY'];
    try {
      expect(() => requireApiKey()).toThrow(/export ANTHROPIC_API_KEY=sk-ant-/);
    } finally {
      process.env['ANTHROPIC_API_KEY'] = KEY_CANARY;
    }
  });
});

describe('AnthropicAdapter', () => {
  it('labels the backend unmistakably in its version string', async () => {
    await expect(new AnthropicAdapter(baseUrl).version()).resolves.toMatch(/^anthropic api \(sdk /);
  });

  it('lists API models with no local footprint (sizeBytes 0, id as digest)', async () => {
    const models = await new AnthropicAdapter(baseUrl).listModels();
    expect(models.map((m) => m.name)).toEqual(['claude-haiku-4-5', 'claude-sonnet-5']);
    expect(models[0]?.sizeBytes).toBe(0);
    expect(models[0]?.digest).toBe('claude-haiku-4-5');
    expect(models[0]?.remote).toBe(false);
  });

  it('resolves a known model and rejects an unknown one with the models command hint', async () => {
    const adapter = new AnthropicAdapter(baseUrl);
    await expect(adapter.ensureModelAvailable('claude-haiku-4-5')).resolves.toMatchObject({ name: 'claude-haiku-4-5' });
    await expect(adapter.ensureModelAvailable('claude-nope')).rejects.toThrow(
      /"claude-nope" is not available on the Anthropic API.*quantproof models --backend anthropic/s,
    );
  });

  it('streams a generation with measurable timing and honest token counts', async () => {
    mode = 'happy';
    const observed = await observeGeneration(new AnthropicAdapter(baseUrl).generate('claude-haiku-4-5', request));
    expect(observed.summary.output).toBe('billing');
    expect(observed.summary.doneReason).toBe('end_turn');
    expect(observed.summary.promptTokenCount).toBe(42);
    expect(observed.summary.outputTokenCount).toBe(7);
    expect(observed.timing.ttftMs).not.toBeNull();
    expect(observed.timing.wallMs).toBeGreaterThan(0);
  });

  it('records seed and context as not-applicable instead of dropping them silently', async () => {
    mode = 'happy';
    const observed = await observeGeneration(new AnthropicAdapter(baseUrl).generate('claude-haiku-4-5', request));
    const options = observed.summary.requestOptions;
    expect(String(options['seed'])).toContain('not-applicable');
    expect(String(options['context'])).toContain('not-applicable');
    expect(options['temperature']).toBe(0);
  });

  it('retries once without temperature when the model rejects it, and records why', async () => {
    mode = 'reject-temperature';
    try {
      const observed = await observeGeneration(new AnthropicAdapter(baseUrl).generate('claude-haiku-4-5', request));
      expect(observed.summary.output).toBe('billing');
      expect(String(observed.summary.requestOptions['temperature'])).toContain(
        'not-applicable (claude-haiku-4-5 rejects the temperature parameter)',
      );
    } finally {
      mode = 'happy';
    }
  });

  it('surfaces exhausted rate limits with the resume command', async () => {
    mode = 'rate-limited';
    try {
      await expect(
        observeGeneration(new AnthropicAdapter(baseUrl).generate('claude-haiku-4-5', request)),
      ).rejects.toThrow(/rate limit held even after automatic backoff retries.*quantproof resume/s);
    } finally {
      mode = 'happy';
    }
  }, 20000);

  it('keeps the API key out of every record it produces', async () => {
    mode = 'happy';
    const observed = await observeGeneration(new AnthropicAdapter(baseUrl).generate('claude-haiku-4-5', request));
    expect(JSON.stringify(observed)).not.toContain(KEY_CANARY);
  });
});
