import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  allDescriptorsFromTags,
  descriptorFromTags,
  parseErrorBody,
  parseGenerateLine,
  parsePullLine,
} from '../../src/backends/ollama-parse.js';

const FIXTURES = resolve(import.meta.dirname, '../fixtures/ollama');
const fixture = (name: string): string => readFileSync(resolve(FIXTURES, name), 'utf8');

describe('parseGenerateLine against a captured live stream', () => {
  const lines = fixture('generate-stream.jsonl').trim().split('\n');

  it('classifies every non-final line as a token with its text', () => {
    const tokens = lines.slice(0, -1).map(parseGenerateLine);
    expect(tokens.every((t) => t.kind === 'token')).toBe(true);
    expect(tokens[0]).toEqual({ kind: 'token', text: 'hello' });
  });

  it('classifies the final line as done with reason and eval counts', () => {
    const last = parseGenerateLine(lines[lines.length - 1] ?? '');
    expect(last).toEqual({
      kind: 'done',
      doneReason: 'stop',
      promptTokenCount: 16,
      outputTokenCount: 3,
    });
  });

  it('classifies an unload response as done with the unload reason', () => {
    const parsed = parseGenerateLine(fixture('unload-response.json').trim());
    expect(parsed).toMatchObject({ kind: 'done', doneReason: 'unload' });
  });

  it('classifies an error envelope as an error line', () => {
    const parsed = parseGenerateLine(fixture('error-not-found.json').trim());
    expect(parsed).toEqual({ kind: 'error', message: "model 'no-such-model:latest' not found" });
  });

  it('throws on a non-JSON line so a wrong server is not silently tolerated', () => {
    expect(() => parseGenerateLine('<html>proxy error</html>')).toThrow(/unparseable stream line/);
  });

  it('throws on JSON that matches no known shape', () => {
    expect(() => parseGenerateLine('{"unexpected": true}')).toThrow(/no known shape/);
  });
});

describe('descriptorFromTags against a captured live tags response', () => {
  const tags: unknown = JSON.parse(fixture('tags.json'));

  it('finds a local model and maps digest, size, quant, and parameter size', () => {
    const descriptor = descriptorFromTags(tags, 'gemma3:1b');
    expect(descriptor).toEqual({
      name: 'gemma3:1b',
      digest: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
      sizeBytes: 815319791,
      quantization: 'Q4_K_M',
      parameterSize: '999.89M',
      remote: false,
    });
  });

  it('maps every entry and marks ollama cloud models as remote', () => {
    const all = allDescriptorsFromTags(tags);
    expect(all.length).toBeGreaterThanOrEqual(9);
    const cloud = all.find((d) => d.name === 'kimi-k2.6:cloud');
    expect(cloud?.remote).toBe(true);
    const local = all.find((d) => d.name === 'qwen3:14b');
    expect(local?.remote).toBe(false);
  });

  it('returns an empty list for a malformed tags body', () => {
    expect(allDescriptorsFromTags({ nope: 1 })).toEqual([]);
  });

  it('maps empty quantization strings to null (cloud models report "")', () => {
    const descriptor = descriptorFromTags(tags, 'glm-5.1:cloud');
    expect(descriptor?.quantization).toBeNull();
    expect(descriptor?.parameterSize).toBeNull();
  });

  it('returns null for a model that is not pulled', () => {
    expect(descriptorFromTags(tags, 'never-pulled:13b')).toBeNull();
  });

  it('matches a bare name against its :latest tag', () => {
    expect(descriptorFromTags(tags, 'gemma3-27b-q4')?.name).toBe('gemma3-27b-q4:latest');
  });

  it('returns null for a malformed body instead of throwing', () => {
    expect(descriptorFromTags('nonsense', 'gemma3:1b')).toBeNull();
  });
});

describe('parsePullLine against a captured live pull stream', () => {
  it('returns the status of every progress line', () => {
    const lines = fixture('pull-stream.jsonl').trim().split('\n');
    expect(parsePullLine(lines[0] ?? '')).toBe('pulling manifest');
    expect(lines.map(parsePullLine).every((s) => s.startsWith('pulling'))).toBe(true);
  });

  it('throws the backend message on an error envelope', () => {
    expect(() => parsePullLine('{"error":"pull model manifest: file does not exist"}')).toThrow(
      /file does not exist/,
    );
  });
});

describe('parseErrorBody', () => {
  it('extracts the message from the error envelope', () => {
    expect(parseErrorBody(fixture('error-not-found.json'))).toBe(
      "model 'no-such-model:latest' not found",
    );
  });

  it('falls back to the raw body for non-JSON errors', () => {
    expect(parseErrorBody('bad gateway')).toBe('bad gateway');
  });

  it('names an empty body instead of returning nothing', () => {
    expect(parseErrorBody('')).toBe('empty error response');
  });
});
