import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AnthropicAdapter, requireApiKey } from '../../src/backends/anthropic-adapter.js';
import { observeGeneration } from '../../src/telemetry/timing-probe.js';
import { startFakeAnthropic } from '../helpers/fake-anthropic.js';
import type { FakeAnthropic } from '../helpers/fake-anthropic.js';

const KEY_CANARY = 'sk-ant-test-canary-never-persist-1234';
const savedKey = process.env['ANTHROPIC_API_KEY'];
let api: FakeAnthropic;

beforeAll(async () => {
  process.env['ANTHROPIC_API_KEY'] = KEY_CANARY;
  api = await startFakeAnthropic();
});

afterAll(() => {
  api.close();
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
    await expect(new AnthropicAdapter(api.baseUrl).version()).resolves.toMatch(/^anthropic api \(sdk /);
  });

  it('lists API models with no local footprint (sizeBytes 0, id as digest)', async () => {
    const models = await new AnthropicAdapter(api.baseUrl).listModels();
    expect(models.map((m) => m.name)).toEqual(['claude-haiku-4-5', 'claude-sonnet-5']);
    expect(models[0]?.sizeBytes).toBe(0);
    expect(models[0]?.digest).toBe('claude-haiku-4-5');
    expect(models[0]?.remote).toBe(false);
  });

  it('resolves a known model and rejects an unknown one with the models command hint', async () => {
    const adapter = new AnthropicAdapter(api.baseUrl);
    await expect(adapter.ensureModelAvailable('claude-haiku-4-5')).resolves.toMatchObject({ name: 'claude-haiku-4-5' });
    await expect(adapter.ensureModelAvailable('claude-nope')).rejects.toThrow(
      /"claude-nope" is not available on the Anthropic API.*quantproof models --backend anthropic/s,
    );
  });

  it('streams a generation with measurable timing and honest token counts', async () => {
    const observed = await observeGeneration(new AnthropicAdapter(api.baseUrl).generate('claude-haiku-4-5', request));
    expect(observed.summary.output).toBe('billing');
    expect(observed.summary.doneReason).toBe('end_turn');
    expect(observed.summary.promptTokenCount).toBe(42);
    expect(observed.summary.outputTokenCount).toBe(7);
    expect(observed.timing.ttftMs).not.toBeNull();
    expect(observed.timing.wallMs).toBeGreaterThan(0);
  });

  it('records seed and context as not-applicable instead of dropping them silently', async () => {
    const observed = await observeGeneration(new AnthropicAdapter(api.baseUrl).generate('claude-haiku-4-5', request));
    const options = observed.summary.requestOptions;
    expect(String(options['seed'])).toContain('not-applicable');
    expect(String(options['context'])).toContain('not-applicable');
    expect(options['temperature']).toBe(0);
  });

  it('retries once without temperature when the model rejects it, and records why', async () => {
    const strict = await startFakeAnthropic({ rejectTemperature: true });
    try {
      const observed = await observeGeneration(new AnthropicAdapter(strict.baseUrl).generate('claude-haiku-4-5', request));
      expect(observed.summary.output).toBe('billing');
      expect(String(observed.summary.requestOptions['temperature'])).toContain(
        'not-applicable (claude-haiku-4-5 rejects the temperature parameter)',
      );
    } finally {
      strict.close();
    }
  });

  it('surfaces exhausted rate limits with the resume command', async () => {
    const limited = await startFakeAnthropic({ rateLimited: true });
    try {
      await expect(
        observeGeneration(new AnthropicAdapter(limited.baseUrl).generate('claude-haiku-4-5', request)),
      ).rejects.toThrow(/rate limit held even after automatic backoff retries.*quantproof resume/s);
    } finally {
      limited.close();
    }
  }, 20000);

  it('keeps the API key out of every record it produces', async () => {
    const observed = await observeGeneration(new AnthropicAdapter(api.baseUrl).generate('claude-haiku-4-5', request));
    expect(JSON.stringify(observed)).not.toContain(KEY_CANARY);
  });
});
