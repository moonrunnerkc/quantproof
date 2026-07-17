import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadTaskPack, TaskPackError } from '../../src/tasks/task-loader.js';

const SCORERS = ['exact-label', 'field-f1', 'json-schema', 'numeric-tolerance', 'pattern'];
const STARTER_PACKS = resolve(import.meta.dirname, '../../examples');

let dirs: string[] = [];

function tempPack(): string {
  const dir = mkdtempSync(join(tmpdir(), 'quantproof-pack-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs = [];
});

function catchPackError(fn: () => void): TaskPackError {
  try {
    fn();
  } catch (err) {
    if (err instanceof TaskPackError) {
      return err;
    }
    throw err;
  }
  throw new Error('expected loadTaskPack to throw TaskPackError');
}

describe('loadTaskPack', () => {
  it('loads the invoice-extraction starter pack with 20 examples and a resolved schema gate', () => {
    const pack = loadTaskPack(join(STARTER_PACKS, 'invoice-extraction'), SCORERS);
    expect(pack.manifest.name).toBe('invoice-extraction');
    expect(pack.manifest.scorer).toBe('field-f1');
    expect(pack.examples).toHaveLength(20);
    expect(pack.promptTemplate).toContain('{{input}}');
    expect(pack.gates).toHaveLength(1);
    expect(pack.gates[0]?.scorer).toBe('json-schema');
    // The gate's schema path must be resolved into the parsed object.
    expect(pack.gates[0]?.scorerParams['schema']).toMatchObject({ type: 'object' });
  });

  it('loads the ticket-classification starter pack with its label set', () => {
    const pack = loadTaskPack(join(STARTER_PACKS, 'ticket-classification'), SCORERS);
    expect(pack.examples).toHaveLength(20);
    expect(pack.scorerParams['labels']).toContain('feature-request');
    expect(pack.gates).toHaveLength(0);
  });

  it('loads the config-generation starter pack with a resolved primary schema and pattern gate', () => {
    const pack = loadTaskPack(join(STARTER_PACKS, 'config-generation'), SCORERS);
    expect(pack.examples).toHaveLength(20);
    expect(pack.scorerParams['schema']).toMatchObject({ type: 'object' });
    expect(pack.gates[0]?.scorer).toBe('pattern');
  });

  it('reports a missing task.yaml and suggests quantproof init', () => {
    const err = catchPackError(() => loadTaskPack(tempPack(), SCORERS));
    expect(err.problems[0]).toContain('task.yaml');
    expect(err.problems[0]).toContain('quantproof init');
  });

  it('reports unparseable YAML with the file path', () => {
    const dir = tempPack();
    writeFileSync(join(dir, 'task.yaml'), 'name: [unclosed');
    const err = catchPackError(() => loadTaskPack(dir, SCORERS));
    expect(err.problems[0]).toContain('not valid YAML');
    expect(err.problems[0]).toContain(join(dir, 'task.yaml'));
  });

  it('prefixes manifest validation errors with the manifest path', () => {
    const dir = tempPack();
    writeFileSync(join(dir, 'task.yaml'), 'name: x\n');
    const err = catchPackError(() => loadTaskPack(dir, SCORERS));
    expect(err.problems.length).toBeGreaterThan(1);
    expect(err.problems.every((p) => p.includes(join(dir, 'task.yaml')))).toBe(true);
  });

  it('aggregates template, schema, and example problems into one throw', () => {
    const dir = tempPack();
    writeFileSync(
      join(dir, 'task.yaml'),
      [
        'name: broken',
        'type: extraction',
        'scorer: json-schema',
        'scorer_params:',
        '  schema: ./missing-schema.json',
        'generation:',
        '  context: 2048',
        '  max_tokens: 256',
        '  temperature: 0',
        '  seed: 1',
        '  runs_per_example: 1',
        'prompt_template: ./missing-prompt.md',
        'examples_dir: ./examples',
      ].join('\n'),
    );
    mkdirSync(join(dir, 'examples'));
    writeFileSync(join(dir, 'examples', '001.json'), '{broken');
    writeFileSync(join(dir, 'examples', '002.json'), JSON.stringify({ expected: 1 }));

    const err = catchPackError(() => loadTaskPack(dir, SCORERS));
    const text = err.problems.join('\n');
    expect(err.problems).toHaveLength(4);
    expect(text).toContain('missing-prompt.md');
    expect(text).toContain('missing-schema.json');
    expect(text).toContain('001.json');
    expect(text).toContain('002.json');
    expect(err.message).toContain('4 problems');
  });

  it('reports a schema file that is valid JSON but not an object', () => {
    const dir = tempPack();
    writeFileSync(
      join(dir, 'task.yaml'),
      [
        'name: broken',
        'type: generation',
        'scorer: json-schema',
        'scorer_params:',
        '  schema: ./schema.json',
        'generation:',
        '  context: 2048',
        '  max_tokens: 256',
        '  temperature: 0',
        '  seed: 1',
        '  runs_per_example: 1',
        'prompt_template: ./prompt.md',
        'examples_dir: ./examples',
      ].join('\n'),
    );
    writeFileSync(join(dir, 'schema.json'), '[1, 2]');
    writeFileSync(join(dir, 'prompt.md'), '{{input}}');
    mkdirSync(join(dir, 'examples'));
    writeFileSync(join(dir, 'examples', '001.json'), JSON.stringify({ input: 'x', expected: 1 }));
    const err = catchPackError(() => loadTaskPack(dir, SCORERS));
    expect(err.problems[0]).toContain('must contain a JSON object');
  });

  it('passes non-path schema params through untouched', () => {
    const dir = tempPack();
    writeFileSync(
      join(dir, 'task.yaml'),
      [
        'name: inline',
        'type: generation',
        'scorer: pattern',
        'scorer_params:',
        '  patterns: ["ok"]',
        'generation:',
        '  context: 2048',
        '  max_tokens: 256',
        '  temperature: 0',
        '  seed: 1',
        '  runs_per_example: 1',
        'prompt_template: ./prompt.md',
        'examples_dir: ./examples',
      ].join('\n'),
    );
    writeFileSync(join(dir, 'prompt.md'), '{{input}}');
    mkdirSync(join(dir, 'examples'));
    writeFileSync(join(dir, 'examples', '001.json'), JSON.stringify({ input: 'x', expected: 1 }));
    const pack = loadTaskPack(dir, SCORERS);
    expect(pack.scorerParams).toEqual({ patterns: ['ok'] });
  });
});
