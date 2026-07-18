import { describe, expect, it } from 'vitest';
import { validateManifest } from '../../src/tasks/task-schema.js';

const SCORERS = ['exact-label', 'field-f1', 'json-schema', 'numeric-tolerance', 'pattern'];

const valid = {
  name: 'invoice-extraction',
  type: 'extraction',
  scorer: 'field-f1',
  scorer_params: { key_fields: ['vendor'] },
  generation: { context: 4096, max_tokens: 512, temperature: 0, seed: 42, runs_per_example: 3 },
  prompt_template: './prompt.md',
  examples_dir: './examples',
};

function errorsFor(overrides: Record<string, unknown>): readonly string[] {
  const result = validateManifest({ ...valid, ...overrides }, SCORERS);
  if (result.ok) {
    throw new Error('expected validation to fail');
  }
  return result.errors;
}

describe('validateManifest', () => {
  it('accepts a complete manifest and defaults gates to empty', () => {
    const result = validateManifest(valid, SCORERS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.name).toBe('invoice-extraction');
      expect(result.manifest.gates).toEqual([]);
      expect(result.manifest.generation.runs_per_example).toBe(3);
    }
  });

  it('defaults scorer_params to an empty mapping when absent', () => {
    const result = validateManifest({ ...valid, scorer_params: undefined }, SCORERS);
    expect(result.ok && result.manifest.scorer_params).toEqual({});
  });

  it('accepts valid gates', () => {
    const result = validateManifest(
      { ...valid, gates: [{ scorer: 'json-schema', scorer_params: { schema: './s.json' } }] },
      SCORERS,
    );
    expect(result.ok && result.manifest.gates).toEqual([
      { scorer: 'json-schema', scorer_params: { schema: './s.json' } },
    ]);
  });

  it('rejects a non-mapping document with a pointer to the format docs', () => {
    const result = validateManifest('nope', SCORERS);
    expect(!result.ok && result.errors[0]).toContain('task-packs.md');
  });

  const fieldCases: readonly [name: string, overrides: Record<string, unknown>, needle: string][] = [
    ['a missing name', { name: undefined }, '"name" must be a non-empty string'],
    ['an empty name', { name: '  ' }, '"name" must be a non-empty string'],
    ['a missing type', { type: undefined }, '"type"'],
    ['a missing scorer', { scorer: undefined }, 'exact-label, field-f1'],
    ['an unknown scorer', { scorer: 'vibes' }, 'not a known scorer'],
    ['non-mapping scorer_params', { scorer_params: 'x' }, 'scorer_params'],
    ['a missing generation block', { generation: undefined }, '"generation" must be a mapping'],
    ['a missing prompt_template', { prompt_template: undefined }, 'prompt.md'],
    ['a missing examples_dir', { examples_dir: undefined }, 'examples_dir'],
    ['non-list gates', { gates: 'json-schema' }, '"gates" must be a list'],
    ['a gate that is not a mapping', { gates: ['json-schema'] }, 'gates[0]'],
    ['a gate with a missing scorer', { gates: [{}] }, 'gates[0].scorer'],
    ['a gate with an unknown scorer', { gates: [{ scorer: 'vibes' }] }, 'not a known scorer'],
  ];
  it.each(fieldCases)('rejects %s', (_name, overrides, needle) => {
    expect(errorsFor(overrides).join('\n')).toContain(needle);
  });

  const generationCases: readonly [name: string, generation: Record<string, unknown>, needle: string][] = [
    ['a missing context', { context: undefined }, '"generation.context" must be a number'],
    ['a fractional context', { context: 0.5 }, '"generation.context" must be an integer'],
    ['a zero context', { context: 0 }, '"generation.context" must be at least 1'],
    ['a string max_tokens', { max_tokens: '512' }, '"generation.max_tokens" must be a number'],
    ['a negative temperature', { temperature: -0.1 }, '"generation.temperature" must be zero or greater'],
    ['a fractional seed', { seed: 4.2 }, '"generation.seed" must be an integer'],
    ['zero runs_per_example', { runs_per_example: 0 }, '"generation.runs_per_example" must be at least 1'],
  ];
  it.each(generationCases)('rejects %s', (_name, generation, needle) => {
    const errors = errorsFor({ generation: { ...valid.generation, ...generation } });
    expect(errors.join('\n')).toContain(needle);
  });

  it('allows a fractional temperature', () => {
    const result = validateManifest(
      { ...valid, generation: { ...valid.generation, temperature: 0.7 } },
      SCORERS,
    );
    expect(result.ok).toBe(true);
  });

  it('collects every error in one pass instead of stopping at the first', () => {
    const result = validateManifest(
      { name: '', scorer: 'vibes', generation: { context: 0 }, gates: [{}] },
      SCORERS,
    );
    expect(!result.ok && result.errors.length).toBeGreaterThanOrEqual(8);
  });
});

describe('validateManifest provenance', () => {
  const provenance = {
    source: 'notes.md',
    source_sha256: 'a'.repeat(64),
    drafted_by: 'gemma3:4b (ollama 0.23.1)',
    drafted_at: '2026-07-17',
    reviewed: false,
  };

  it('is null for hand-written packs', () => {
    const result = validateManifest(valid, SCORERS);
    expect(result.ok && result.manifest.provenance).toBeNull();
  });

  it('accepts a complete provenance block', () => {
    const result = validateManifest({ ...valid, provenance }, SCORERS);
    expect(result.ok && result.manifest.provenance).toEqual(provenance);
  });

  it('defaults reviewed to false when absent', () => {
    const { reviewed, ...rest } = provenance;
    void reviewed;
    const result = validateManifest({ ...valid, provenance: rest }, SCORERS);
    expect(result.ok && result.manifest.provenance?.reviewed).toBe(false);
  });

  it('rejects a provenance block missing its drafting fields', () => {
    const errors = errorsFor({ provenance: { source: 'notes.md' } });
    expect(errors.some((e) => e.includes('source_sha256'))).toBe(true);
    expect(errors.some((e) => e.includes('drafted_by'))).toBe(true);
  });

  it('rejects a non-boolean reviewed flag with the fix', () => {
    const errors = errorsFor({ provenance: { ...provenance, reviewed: 'yes' } });
    expect(errors.some((e) => e.includes('true once the examples are human-checked'))).toBe(true);
  });
});
