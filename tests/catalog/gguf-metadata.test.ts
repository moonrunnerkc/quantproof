import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { architectureFromInfo, resolveArchitecture } from '../../src/catalog/gguf-metadata.js';
import type { ModelInfoSource } from '../../src/catalog/gguf-metadata.js';

const FIXTURES = resolve(import.meta.dirname, '../fixtures/ollama');
function showInfo(name: string): Record<string, unknown> {
  const doc = JSON.parse(readFileSync(resolve(FIXTURES, name), 'utf8')) as {
    model_info: Record<string, unknown>;
  };
  return doc.model_info;
}

describe('architectureFromInfo against captured live metadata', () => {
  it('extracts gemma3:1b fields including its single KV head', () => {
    expect(architectureFromInfo(showInfo('show-gemma3-1b.json'))).toEqual({
      architecture: 'gemma3',
      blockCount: 26,
      kvHeadCount: 1,
      keyLength: 256,
      valueLength: 256,
      maxContext: 32768,
    });
  });

  it('extracts qwen3:4b GQA fields', () => {
    expect(architectureFromInfo(showInfo('show-qwen3-4b.json'))).toEqual({
      architecture: 'qwen3',
      blockCount: 36,
      kvHeadCount: 8,
      keyLength: 128,
      valueLength: 128,
      maxContext: 262144,
    });
  });

  it('extracts qwen3:14b fields', () => {
    expect(architectureFromInfo(showInfo('show-qwen3-14b.json'))).toMatchObject({
      blockCount: 40,
      kvHeadCount: 8,
      maxContext: 40960,
    });
  });

  it('derives head dim from embedding/head_count when key_length is absent', () => {
    const info = showInfo('show-qwen3-4b.json');
    delete info['qwen3.attention.key_length'];
    delete info['qwen3.attention.value_length'];
    // embedding 2560 / 32 heads = 80.
    expect(architectureFromInfo(info)).toMatchObject({ keyLength: 80, valueLength: 80 });
  });

  it('returns null, never throws, for an exotic architecture missing fields', () => {
    expect(architectureFromInfo({ 'general.architecture': 'mysterynet' })).toBeNull();
    expect(architectureFromInfo({})).toBeNull();
  });
});

describe('resolveArchitecture', () => {
  const apiSource = (info: Record<string, unknown> | null): ModelInfoSource => ({
    showModelInfo: () => Promise.resolve(info),
  });

  it('uses the API answer when it is complete', async () => {
    const arch = await resolveArchitecture(apiSource(showInfo('show-gemma3-1b.json')), 'gemma3:1b');
    expect(arch?.blockCount).toBe(26);
  });

  it('degrades to null when the API lacks fields and no blob exists', async () => {
    const arch = await resolveArchitecture(
      apiSource({ 'general.architecture': 'mysterynet' }),
      'no-such-model:latest',
    );
    expect(arch).toBeNull();
  });

  it('degrades to null when the source itself throws', async () => {
    const source: ModelInfoSource = {
      showModelInfo: () => Promise.reject(new Error('backend down')),
    };
    expect(await resolveArchitecture(source, 'no-such-model:latest')).toBeNull();
  });
});
