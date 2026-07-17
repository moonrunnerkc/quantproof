import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkExpectedValues } from '../../src/scoring/plan-check.js';
import { registerBuiltinScorers } from '../../src/scoring/builtin-scorers.js';
import { listScorers } from '../../src/scoring/scorer-registry.js';
import { loadExamples } from '../../src/tasks/example-loader.js';
import { loadTaskPack } from '../../src/tasks/task-loader.js';
import { renderPrompt } from '../../src/tasks/prompt-template.js';

registerBuiltinScorers();
const root = mkdtempSync(join(tmpdir(), 'quantproof-hostile-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function writePack(
  name: string,
  manifest: string,
  examples: readonly { file: string; body: string }[],
): string {
  const dir = join(root, name);
  mkdirSync(join(dir, 'examples'), { recursive: true });
  writeFileSync(join(dir, 'task.yaml'), manifest);
  writeFileSync(join(dir, 'prompt.md'), 'Task:\n{{input}}\n');
  for (const example of examples) {
    writeFileSync(join(dir, 'examples', example.file), example.body);
  }
  return dir;
}

const labelManifest = `
name: hostile
type: classification
scorer: exact-label
scorer_params:
  labels: [billing, bug]
generation:
  context: 2048
  max_tokens: 16
  temperature: 0
  seed: 42
  runs_per_example: 1
prompt_template: ./prompt.md
examples_dir: ./examples
`;

describe('hostile inputs are caught at plan time', () => {
  it('a multi-megabyte example loads intact without truncation', () => {
    const big = 'x'.repeat(4 * 1024 * 1024);
    const dir = writePack('huge', labelManifest, [
      { file: '001.json', body: JSON.stringify({ input: big, expected: 'billing' }) },
    ]);
    const pack = loadTaskPack(dir, listScorers());
    expect(pack.examples[0]?.input.length).toBe(big.length);
  });

  it('hundreds of examples load in stable sorted order', () => {
    const examples = Array.from({ length: 300 }, (_, i) => ({
      file: `${String(i).padStart(3, '0')}.json`,
      body: JSON.stringify({ input: `ticket ${String(i)}`, expected: 'bug' }),
    }));
    const pack = loadTaskPack(writePack('many', labelManifest, examples), listScorers());
    expect(pack.examples).toHaveLength(300);
    expect(pack.examples[0]?.id).toBe('000');
    expect(pack.examples[299]?.id).toBe('299');
  });

  it('reports every broken example of a large pack in one pass', () => {
    const examples = [
      ...Array.from({ length: 40 }, (_, i) => ({
        file: `ok-${String(i)}.json`,
        body: JSON.stringify({ input: 'fine', expected: 'billing' }),
      })),
      ...Array.from({ length: 25 }, (_, i) => ({
        file: `bad-${String(i)}.json`,
        body: '{ not json at all',
      })),
    ];
    const result = loadExamples(join(writePack('broken', labelManifest, examples), 'examples'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(25);
      expect(result.errors.every((e) => e.includes('not valid JSON'))).toBe(true);
    }
  });

  it('unicode-heavy input and expected values survive loading and prompt rendering byte for byte', () => {
    const input = 'Ticket: 請求書が二重です 💸 \u{1F9FE} مرحبا ́combining\nnewline\ttab';
    const dir = writePack('unicode', labelManifest, [
      { file: '001.json', body: JSON.stringify({ input, expected: 'billing' }) },
    ]);
    const pack = loadTaskPack(dir, listScorers());
    expect(pack.examples[0]?.input).toBe(input);
    expect(renderPrompt(pack.promptTemplate, input)).toContain(input);
  });

  it('an expected value outside the label set dies before any inference', () => {
    const dir = writePack('off-label', labelManifest, [
      { file: '001.json', body: JSON.stringify({ input: 'x', expected: 'billing' }) },
      { file: '002.json', body: JSON.stringify({ input: 'y', expected: 'refund' }) },
    ]);
    const problems = checkExpectedValues(loadTaskPack(dir, listScorers()));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('002.json');
    expect(problems[0]).toContain('"refund"');
    expect(problems[0]).toContain('not in labels');
  });

  it('a field-f1 pack with a string expected dies at plan time, not mid-sweep', () => {
    const manifest = labelManifest
      .replace('scorer: exact-label', 'scorer: field-f1')
      .replace('  labels: [billing, bug]', '  key_fields: [vendor]');
    const dir = writePack('wrong-shape', manifest, [
      { file: '001.json', body: JSON.stringify({ input: 'x', expected: 'not-an-object' }) },
    ]);
    const problems = checkExpectedValues(loadTaskPack(dir, listScorers()));
    expect(problems[0]).toContain('needs an object with the key fields as properties');
  });

  it('collapses a bad scorer param to one problem instead of one per example', () => {
    const manifest = labelManifest.replace('  labels: [billing, bug]', '  labels: []');
    const dir = writePack('bad-param', manifest, [
      { file: '001.json', body: JSON.stringify({ input: 'x', expected: 'a' }) },
      { file: '002.json', body: JSON.stringify({ input: 'y', expected: 'b' }) },
    ]);
    const problems = checkExpectedValues(loadTaskPack(dir, listScorers()));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('labels');
  });

  it('a clean pack produces zero problems', () => {
    const dir = writePack('clean', labelManifest, [
      { file: '001.json', body: JSON.stringify({ input: 'x', expected: 'billing' }) },
    ]);
    expect(checkExpectedValues(loadTaskPack(dir, listScorers()))).toEqual([]);
  });
});
