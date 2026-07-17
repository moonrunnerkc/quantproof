import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readGgufMetadata } from '../../src/catalog/gguf-reader.js';

const dir = mkdtempSync(join(tmpdir(), 'quantproof-gguf-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Builds a GGUF v3 header byte-by-byte per the documented format. */
function ggufFile(entries: [string, { type: number; payload: Buffer }][]): Buffer {
  const chunks: Buffer[] = [];
  const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const u64 = (n: number): Buffer => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const str = (s: string): Buffer => Buffer.concat([u64(Buffer.byteLength(s)), Buffer.from(s, 'utf8')]);
  chunks.push(Buffer.from('GGUF', 'ascii'), u32(3), u64(0), u64(entries.length));
  for (const [key, value] of entries) {
    chunks.push(str(key), u32(value.type), value.payload);
  }
  return Buffer.concat(chunks);
}

const u32v = (n: number): { type: number; payload: Buffer } => {
  const b = Buffer.alloc(4); b.writeUInt32LE(n); return { type: 4, payload: b };
};
const u64v = (n: number): { type: number; payload: Buffer } => {
  const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return { type: 10, payload: b };
};
const f32v = (n: number): { type: number; payload: Buffer } => {
  const b = Buffer.alloc(4); b.writeFloatLE(n); return { type: 6, payload: b };
};
const boolv = (v: boolean): { type: number; payload: Buffer } => ({ type: 7, payload: Buffer.from([v ? 1 : 0]) });
const strv = (s: string): { type: number; payload: Buffer } => {
  const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(Buffer.byteLength(s)));
  return { type: 8, payload: Buffer.concat([b, Buffer.from(s, 'utf8')]) };
};
/** Array of strings, the shape of tokenizer tables that must be skipped. */
const strArrayV = (items: string[]): { type: number; payload: Buffer } => {
  const head = Buffer.alloc(12);
  head.writeUInt32LE(8, 0);
  head.writeBigUInt64LE(BigInt(items.length), 4);
  const parts = items.map((s) => {
    const len = Buffer.alloc(8); len.writeBigUInt64LE(BigInt(Buffer.byteLength(s)));
    return Buffer.concat([len, Buffer.from(s, 'utf8')]);
  });
  return { type: 9, payload: Buffer.concat([head, ...parts]) };
};

describe('readGgufMetadata', () => {
  it('reads scalar and string metadata and skips array entries', () => {
    const path = join(dir, 'model.gguf');
    writeFileSync(
      path,
      ggufFile([
        ['general.architecture', strv('gemma3')],
        ['gemma3.block_count', u32v(26)],
        ['gemma3.attention.head_count_kv', u32v(1)],
        ['gemma3.attention.key_length', u32v(256)],
        ['gemma3.attention.value_length', u32v(256)],
        ['gemma3.context_length', u64v(32768)],
        ['gemma3.rope.freq_base', f32v(1000000)],
        ['tokenizer.ggml.add_bos_token', boolv(true)],
        ['tokenizer.ggml.tokens', strArrayV(['<bos>', '<eos>', 'hello'])],
        ['after.the.array', u32v(7)],
      ]),
    );
    const meta = readGgufMetadata(path);
    expect(meta.get('general.architecture')).toBe('gemma3');
    expect(meta.get('gemma3.block_count')).toBe(26);
    expect(meta.get('gemma3.context_length')).toBe(32768);
    expect(meta.get('gemma3.rope.freq_base')).toBe(1000000);
    expect(meta.get('tokenizer.ggml.add_bos_token')).toBe(true);
    expect(meta.has('tokenizer.ggml.tokens')).toBe(false);
    // Correct array skipping proves itself by what parses afterward.
    expect(meta.get('after.the.array')).toBe(7);
  });

  it('rejects a non-GGUF file by magic', () => {
    const path = join(dir, 'not-gguf.bin');
    writeFileSync(path, Buffer.from('PK\x03\x04 definitely a zip'));
    expect(() => readGgufMetadata(path)).toThrow(/not a GGUF file/);
  });

  it('rejects unsupported GGUF versions instead of misparsing', () => {
    const path = join(dir, 'future.gguf');
    const file = ggufFile([]);
    file.writeUInt32LE(9, 4);
    writeFileSync(path, file);
    expect(() => readGgufMetadata(path)).toThrow(/version 9/);
  });

  it('reports truncation instead of hanging or misreading', () => {
    const path = join(dir, 'truncated.gguf');
    const file = ggufFile([['general.architecture', strv('gemma3')]]);
    writeFileSync(path, file.subarray(0, file.length - 4));
    expect(() => readGgufMetadata(path)).toThrow(/ended after/);
  });
});
