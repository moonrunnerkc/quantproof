import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { initCommand } from '../../src/cli/command-init.js';
import { registerBuiltinScorers } from '../../src/scoring/builtin-scorers.js';
import { listScorers } from '../../src/scoring/scorer-registry.js';
import { loadTaskPack, TaskPackError } from '../../src/tasks/task-loader.js';

registerBuiltinScorers();
const root = mkdtempSync(join(tmpdir(), 'quantproof-init-'));

beforeAll(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterAll(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function loadErrors(dir: string): readonly string[] {
  try {
    loadTaskPack(dir, listScorers());
  } catch (err) {
    if (err instanceof TaskPackError) {
      return err.problems;
    }
    throw err;
  }
  throw new Error(`expected the scaffolded pack at ${dir} to fail validation`);
}

describe('initCommand', () => {
  it('states a default in every prompt and uses the answers', async () => {
    const prompts: { question: string; defaultValue: string }[] = [];
    const dir = await initCommand({
      dir: join(root, 'prompted'),
      ask: (question, defaultValue) => {
        prompts.push({ question, defaultValue });
        return Promise.resolve(defaultValue);
      },
    });
    expect(prompts.map((p) => p.defaultValue)).toEqual(['prompted', 'extraction', 'field-f1']);
    expect(prompts.every((p) => p.question.length > 0)).toBe(true);
    expect(existsSync(join(dir, 'task.yaml'))).toBe(true);
  });

  it('scaffolds a field-f1 pack whose placeholders fail validation with replace-me messages', async () => {
    const dir = await initCommand({ dir: join(root, 'invoices'), name: 'invoices', type: 'extraction', scorer: 'field-f1', yes: true });
    const problems = loadErrors(dir);
    const placeholderProblems = problems.filter((p) => p.includes('placeholder example from quantproof init'));
    expect(placeholderProblems).toHaveLength(2);
    expect(placeholderProblems[0]).toContain('001-replace-me.json');
    expect(placeholderProblems[1]).toContain('002-replace-me.json');
  });

  it('validates cleanly once the placeholders are replaced with real examples', async () => {
    const dir = join(root, 'invoices');
    for (const file of ['001-replace-me.json', '002-replace-me.json']) {
      writeFileSync(
        join(dir, 'examples', file),
        JSON.stringify({ input: 'Invoice from ACME for $12.50', expected: { field_a: 'ACME', field_b: 12.5 } }),
      );
    }
    const pack = loadTaskPack(dir, listScorers());
    expect(pack.manifest.name).toBe('invoices');
    expect(pack.manifest.scorer).toBe('field-f1');
    expect(pack.gates.map((g) => g.scorer)).toEqual(['json-schema']);
    expect(pack.gates[0]?.scorerParams['schema']).toBeTypeOf('object');
    expect(pack.examples).toHaveLength(2);
  });

  it('scaffolds label packs without a schema file', async () => {
    const dir = await initCommand({ dir: join(root, 'tickets'), name: 'tickets', type: 'classification', scorer: 'exact-label', yes: true });
    expect(existsSync(join(dir, 'schema.json'))).toBe(false);
    writeFileSync(join(dir, 'examples', '001-replace-me.json'), JSON.stringify({ input: 'x', expected: 'label_a' }));
    writeFileSync(join(dir, 'examples', '002-replace-me.json'), JSON.stringify({ input: 'y', expected: 'label_b' }));
    expect(loadTaskPack(dir, listScorers()).manifest.scorer).toBe('exact-label');
  });

  it('never overwrites an existing pack', async () => {
    await expect(
      initCommand({ dir: join(root, 'invoices'), name: 'x', type: 'extraction', scorer: 'field-f1', yes: true }),
    ).rejects.toThrow(/already contains a task\.yaml/);
  });

  it('rejects a scorer without a scaffold, naming the options', async () => {
    await expect(
      initCommand({ dir: join(root, 'bad'), name: 'bad', type: 'x', scorer: 'made-up', yes: true }),
    ).rejects.toThrow(/no init scaffold; use one of: exact-label/);
  });

  it('never prompts when every answer arrives as a flag', async () => {
    const ask = vi.fn();
    await initCommand({
      dir: join(root, 'flags-only'), name: 'flags-only', type: 'generation', scorer: 'pattern',
      ask: ask as never,
    });
    expect(ask).not.toHaveBeenCalled();
  });
});
