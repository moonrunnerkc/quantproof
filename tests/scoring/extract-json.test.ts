import { describe, expect, it } from 'vitest';
import { extractJson } from '../../src/scoring/extract-json.js';

describe('extractJson', () => {
  it('parses clean JSON without flagging extraction', () => {
    const result = extractJson('{"a": 1}');
    expect(result).toEqual({ value: { a: 1 }, ok: true, extractionNeeded: false });
  });

  it('parses a clean JSON array', () => {
    expect(extractJson('[1, 2, 3]').value).toEqual([1, 2, 3]);
  });

  it('extracts JSON wrapped in markdown fences and flags the extraction', () => {
    const result = extractJson('```json\n{"vendor": "Acme"}\n```');
    expect(result.ok).toBe(true);
    expect(result.extractionNeeded).toBe(true);
    expect(result.value).toEqual({ vendor: 'Acme' });
  });

  it('extracts JSON preceded and followed by prose', () => {
    const result = extractJson('Here is the data you asked for: {"total": 5} Hope that helps!');
    expect(result.ok).toBe(true);
    expect(result.extractionNeeded).toBe(true);
    expect(result.value).toEqual({ total: 5 });
  });

  it('handles braces inside JSON string values while balancing', () => {
    const result = extractJson('output: {"note": "use {curly} braces", "n": 1} done');
    expect(result.value).toEqual({ note: 'use {curly} braces', n: 1 });
  });

  it('handles escaped quotes inside strings while balancing', () => {
    const result = extractJson('res {"quote": "she said \\"hi\\""} end');
    expect(result.value).toEqual({ quote: 'she said "hi"' });
  });

  it('fails on partial JSON with an unclosed-object error', () => {
    const result = extractJson('{"vendor": "Acme", "total": ');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('unclosed object');
  });

  it('fails on prose with no JSON at all', () => {
    const result = extractJson('I cannot assist with that request.');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('no JSON object or array');
  });

  it('fails on empty string', () => {
    expect(extractJson('').ok).toBe(false);
  });

  it('fails when the balanced candidate is still not valid JSON', () => {
    const result = extractJson("here: {'single': 'quotes'} end");
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not valid JSON');
  });

  it('parses a bare top-level number as direct JSON', () => {
    expect(extractJson('42')).toEqual({ value: 42, ok: true, extractionNeeded: false });
  });
});
