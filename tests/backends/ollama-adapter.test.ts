import { describe, expect, it } from 'vitest';
import { OllamaAdapter } from '../../src/backends/ollama-adapter.js';

// Port 9 (discard protocol) is never an HTTP server; connection is
// refused immediately, which is the unreachable-backend case.
const unreachable = new OllamaAdapter('http://127.0.0.1:9');

describe('OllamaAdapter against an unreachable server', () => {
  it('fails fast on version() with the exact command to start Ollama', async () => {
    await expect(unreachable.version()).rejects.toThrow(/start it with: ollama serve/);
  });

  it('fails fast on ensureModelAvailable() with the same guidance', async () => {
    await expect(unreachable.ensureModelAvailable('gemma3:1b')).rejects.toThrow(/ollama serve/);
  });

  it('fails fast when the generation stream is first consumed', async () => {
    const stream = unreachable.generate('gemma3:1b', {
      prompt: 'hi',
      context: 2048,
      maxTokens: 8,
      temperature: 0,
      seed: 42,
    });
    await expect(stream.next()).rejects.toThrow(/ollama serve/);
  });

  it('names the unreachable base url in the message', async () => {
    await expect(unreachable.version()).rejects.toThrow(/127\.0\.0\.1:9/);
  });
});
