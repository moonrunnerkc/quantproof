import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GenerationSummary } from '../../src/backends/backend-adapter.js';
import { RapidMlxAdapter } from '../../src/backends/rapid-mlx-adapter.js';

/**
 * Fake Rapid-MLX server reproducing the shapes verified against the
 * live 0.6.0 instance: openapi info, single served model, 404 detail
 * for unknown models, SSE chunks with usage in the final frames, and a
 * cache-clear endpoint.
 */
let server: Server;
let baseUrl: string;
let requestLog: string[] = [];
let failCacheClear = false;
let omitFinishReason = false;

const SSE_CHUNKS = [
  '{"choices":[{"index":0,"delta":{"role":"assistant"}}]}',
  '{"choices":[{"index":0,"delta":{"content":"bug"}}]}',
  '{"choices":[{"index":0,"delta":{"content":"-report"}}]}',
  '{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":2,"total_tokens":13}}',
  '{"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":2,"total_tokens":13}}',
];

beforeAll(async () => {
  server = createServer((req, res) => {
    requestLog.push(`${req.method ?? ''} ${req.url ?? ''}`);
    if (req.url === '/openapi.json') {
      res.end(JSON.stringify({ openapi: '3.1.0', info: { title: 'Rapid-MLX API', version: '0.6.0' } }));
      return;
    }
    if (req.url === '/health') {
      res.end(JSON.stringify({ status: 'healthy', ready: true, model_loaded: true, model_name: 'qwen-test:4b' }));
      return;
    }
    if (req.url === '/v1/models') {
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'qwen-test:4b', object: 'model', owned_by: 'rapid-mlx' }] }));
      return;
    }
    if (req.url === '/v1/cache/clear') {
      if (failCacheClear) {
        res.statusCode = 500;
        res.end(JSON.stringify({ detail: 'cache backend exploded' }));
        return;
      }
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (req.url === '/v1/chat/completions') {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { model: string };
        if (parsed.model !== 'qwen-test:4b') {
          res.statusCode = 404;
          res.end(JSON.stringify({ detail: `The model \`${parsed.model}\` does not exist. Available: qwen-test:4b` }));
          return;
        }
        res.setHeader('Content-Type', 'text/event-stream');
        const chunks = omitFinishReason ? SSE_CHUNKS.slice(0, 3) : SSE_CHUNKS;
        for (const chunk of chunks) {
          res.write(`data: ${chunk}\n\n`);
        }
        res.end('data: [DONE]\n\n');
      });
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ detail: 'Not Found' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('fake server has no port');
  }
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const generationRequest = { prompt: 'hi', context: 2048, maxTokens: 16, temperature: 0, seed: 42 };

async function drain(adapter: RapidMlxAdapter, model: string): Promise<{ texts: string[]; summary: GenerationSummary }> {
  const stream = adapter.generate(model, generationRequest);
  const texts: string[] = [];
  for (;;) {
    const step = await stream.next();
    if (step.done === true) {
      return { texts, summary: step.value };
    }
    texts.push(step.value.text);
  }
}

describe('RapidMlxAdapter against an unreachable server', () => {
  const unreachable = new RapidMlxAdapter('http://127.0.0.1:9');

  it('fails fast on version() with the exact command to start the server', async () => {
    await expect(unreachable.version()).rejects.toThrow(/rapid-mlx serve/);
  });

  it('names the unreachable base url in the message', async () => {
    await expect(unreachable.listModels()).rejects.toThrow(/127\.0\.0\.1:9/);
  });
});

describe('RapidMlxAdapter against the fake server', () => {
  it('reports its version from the openapi document', async () => {
    await expect(new RapidMlxAdapter(baseUrl).version()).resolves.toBe('rapid-mlx 0.6.0');
  });

  it('lists the served model with the name doubling as the digest', async () => {
    const models = await new RapidMlxAdapter(baseUrl).listModels();
    expect(models).toEqual([
      { name: 'qwen-test:4b', digest: 'qwen-test:4b', sizeBytes: 0, quantization: null, parameterSize: null, remote: false },
    ]);
  });

  it('resolves a served model and rejects an unserved one with the restart command', async () => {
    const adapter = new RapidMlxAdapter(baseUrl);
    await expect(adapter.ensureModelAvailable('qwen-test:4b')).resolves.toMatchObject({ name: 'qwen-test:4b' });
    await expect(adapter.ensureModelAvailable('other:7b')).rejects.toThrow(/rapid-mlx serve other:7b/);
    await expect(adapter.ensureModelAvailable('other:7b')).rejects.toThrow(/serving: qwen-test:4b/);
  });

  it('load verifies the server reports a loaded model', async () => {
    await expect(new RapidMlxAdapter(baseUrl).load('qwen-test:4b', 2048)).resolves.toBeUndefined();
  });

  it('streams tokens and returns the summary with usage and done reason', async () => {
    const { texts, summary } = await drain(new RapidMlxAdapter(baseUrl), 'qwen-test:4b');
    expect(texts).toEqual(['bug', '-report']);
    expect(summary.output).toBe('bug-report');
    expect(summary.doneReason).toBe('stop');
    expect(summary.promptTokenCount).toBe(11);
    expect(summary.outputTokenCount).toBe(2);
    expect(summary.requestOptions['prompt_cache']).toBe('cleared before request');
  });

  it('clears the prompt cache before each generation so latency is fresh', async () => {
    requestLog = [];
    await drain(new RapidMlxAdapter(baseUrl), 'qwen-test:4b');
    const clearIndex = requestLog.indexOf('POST /v1/cache/clear');
    const completionIndex = requestLog.indexOf('POST /v1/chat/completions');
    expect(clearIndex).toBeGreaterThanOrEqual(0);
    expect(completionIndex).toBeGreaterThan(clearIndex);
  });

  it('still generates when cache clearing fails, recording the caveat', async () => {
    failCacheClear = true;
    try {
      const { summary } = await drain(new RapidMlxAdapter(baseUrl), 'qwen-test:4b');
      expect(summary.output).toBe('bug-report');
      expect(String(summary.requestOptions['prompt_cache'])).toContain('latency may include cache hits');
    } finally {
      failCacheClear = false;
    }
  });

  it('surfaces the server 404 detail for a wrong model in generate', async () => {
    const stream = new RapidMlxAdapter(baseUrl).generate('wrong:1b', generationRequest);
    await expect(stream.next()).rejects.toThrow(/does not exist/);
  });

  it('throws when the stream ends without a finish reason', async () => {
    omitFinishReason = true;
    try {
      await expect(drain(new RapidMlxAdapter(baseUrl), 'qwen-test:4b')).rejects.toThrow(/finish_reason/);
    } finally {
      omitFinishReason = false;
    }
  });
});
