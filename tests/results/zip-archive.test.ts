import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { crc32, readZip, writeZip } from '../../src/results/zip-archive.js';

const STAMP = Date.UTC(2026, 6, 16, 3, 24, 0);

const entries = [
  { path: 'report.md', data: Buffer.from('# report\n\nsome markdown body that deflates well well well well') },
  { path: 'outputs/gemma3-1b/001-rep1.txt', data: Buffer.from('{"label": "billing"}') },
  { path: 'empty.txt', data: Buffer.alloc(0) },
];

describe('writeZip / readZip', () => {
  it('round-trips every entry byte for byte', () => {
    const archive = writeZip(entries, STAMP);
    const back = readZip(archive);
    expect(back.map((e) => e.path)).toEqual(entries.map((e) => e.path));
    for (const [i, entry] of back.entries()) {
      expect(entry.data.equals(entries[i]?.data ?? Buffer.alloc(0))).toBe(true);
    }
  });

  it('produces byte-identical archives for identical inputs', () => {
    expect(writeZip(entries, STAMP).equals(writeZip(entries, STAMP))).toBe(true);
  });

  it('self-describes its entry count through the central directory', () => {
    const archive = writeZip(entries, STAMP);
    expect(readZip(archive)).toHaveLength(3);
  });

  it('is readable by an independent unzip implementation', () => {
    // python3 zipfile is the cross-check that the writer emits real
    // ZIP, not something only our own reader accepts.
    const dir = mkdtempSync(join(tmpdir(), 'quantproof-zipcheck-'));
    try {
      const path = join(dir, 'check.zip');
      writeFileSync(path, writeZip(entries, STAMP));
      const listing = execFileSync(
        'python3',
        ['-c', `import zipfile; z = zipfile.ZipFile('${path}'); print(z.testzip()); print(len(z.namelist()))`],
        { encoding: 'utf8' },
      );
      expect(listing.trim().split('\n')).toEqual(['None', '3']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects duplicate entry paths with the offending path named', () => {
    expect(() =>
      writeZip([entries[0] as (typeof entries)[0], entries[0] as (typeof entries)[0]], STAMP),
    ).toThrow(/duplicate zip entry "report\.md"/);
  });

  it('rejects a non-zip buffer with an actionable message', () => {
    expect(() => readZip(Buffer.from('not a zip at all'))).toThrow(/not a zip archive/);
  });

  it('detects payload corruption through the crc check', () => {
    // Incompressible data keeps the entry stored, so a flipped payload
    // byte reaches the CRC check instead of breaking the inflater.
    const incompressible = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 37) % 256));
    const archive = writeZip([{ path: 'a.txt', data: incompressible }], STAMP);
    // Payload starts after the 30-byte local header and 5-byte name.
    archive[40] = (archive[40] ?? 0) ^ 0xff;
    expect(() => readZip(archive)).toThrow(/failed its CRC check/);
  });
});

describe('crc32', () => {
  it('matches the published check value for "123456789"', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });

  it('returns the standard empty-input value', () => {
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });
});
