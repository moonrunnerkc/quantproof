import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadExamples } from '../../src/tasks/example-loader.js';

let dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'quantproof-examples-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs = [];
});

describe('loadExamples', () => {
  it('loads valid examples in sorted filename order with ids and source paths', () => {
    const dir = tempDir();
    writeFileSync(join(dir, '002.json'), JSON.stringify({ input: 'b', expected: 2 }));
    writeFileSync(join(dir, '001.json'), JSON.stringify({ input: 'a', expected: { x: 1 } }));
    const result = loadExamples(dir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.examples.map((e) => e.id)).toEqual(['001', '002']);
      expect(result.examples[0]).toEqual({
        id: '001',
        sourcePath: join(dir, '001.json'),
        input: 'a',
        expected: { x: 1 },
      });
    }
  });

  it('ignores non-json files', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'notes.txt'), 'not an example');
    writeFileSync(join(dir, '001.json'), JSON.stringify({ input: 'a', expected: 1 }));
    const result = loadExamples(dir);
    expect(result.ok && result.examples).toHaveLength(1);
  });

  it('accepts falsy expected values like 0 and null', () => {
    const dir = tempDir();
    writeFileSync(join(dir, '001.json'), JSON.stringify({ input: 'a', expected: null }));
    writeFileSync(join(dir, '002.json'), JSON.stringify({ input: 'b', expected: 0 }));
    expect(loadExamples(dir).ok).toBe(true);
  });

  it('reports a missing directory with a pointer at examples_dir', () => {
    const result = loadExamples('/nonexistent/quantproof-examples');
    expect(!result.ok && result.errors[0]).toContain('examples_dir in task.yaml');
  });

  it('reports a directory with no json files and suggests adding one', () => {
    const dir = tempDir();
    const result = loadExamples(dir);
    expect(!result.ok && result.errors[0]).toContain('no .json files');
  });

  it('reports invalid JSON with the file path', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'bad.json'), '{not json');
    const result = loadExamples(dir);
    expect(!result.ok && result.errors[0]).toContain(join(dir, 'bad.json'));
    expect(!result.ok && result.errors[0]).toContain('not valid JSON');
  });

  it('reports a file whose top level is not an object', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'arr.json'), '[1, 2]');
    const result = loadExamples(dir);
    expect(!result.ok && result.errors[0]).toContain('must be a JSON object');
  });

  it('reports a missing or empty input field', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'a.json'), JSON.stringify({ expected: 1 }));
    writeFileSync(join(dir, 'b.json'), JSON.stringify({ input: '  ', expected: 1 }));
    const result = loadExamples(dir);
    expect(!result.ok && result.errors).toHaveLength(2);
    expect(!result.ok && result.errors.join('\n')).toContain('"input" must be a non-empty string');
  });

  it('reports a missing expected field', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'a.json'), JSON.stringify({ input: 'x' }));
    const result = loadExamples(dir);
    expect(!result.ok && result.errors[0]).toContain('missing "expected"');
  });

  it('collects errors across all files in one pass instead of stopping at the first bad file', () => {
    const dir = tempDir();
    writeFileSync(join(dir, '001.json'), '{broken');
    writeFileSync(join(dir, '002.json'), JSON.stringify({ input: 'ok', expected: 1 }));
    writeFileSync(join(dir, '003.json'), JSON.stringify({ expected: 1 }));
    writeFileSync(join(dir, '004.json'), JSON.stringify({ input: 'x' }));
    const result = loadExamples(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(3);
      expect(result.errors.join('\n')).toContain('001.json');
      expect(result.errors.join('\n')).toContain('003.json');
      expect(result.errors.join('\n')).toContain('004.json');
    }
  });

  it('reports both problems of a doubly-broken file', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'a.json'), JSON.stringify({ input: 3 }));
    const result = loadExamples(dir);
    expect(!result.ok && result.errors).toHaveLength(2);
  });
});
