import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { registerBuiltinScorers } from '../../src/scoring/builtin-scorers.js';
import { listScorers } from '../../src/scoring/scorer-registry.js';
import { loadTaskPack } from '../../src/tasks/task-loader.js';
import type { PackDraft } from '../../src/ingest/draft-parser.js';
import { writePackDraft } from '../../src/ingest/pack-writer.js';

registerBuiltinScorers();
const root = mkdtempSync(join(tmpdir(), 'qp-pack-writer-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const draft: PackDraft = {
  name: 'ticket-triage',
  type: 'classification',
  scorer: 'exact-label',
  scorerParams: { labels: ['billing', 'bug'] },
  prompt: 'Classify the ticket, one bare label.\n\nTicket:\n{{input}}',
  examples: Array.from({ length: 12 }, (_, i) => ({
    input: `ticket ${String(i)}`,
    expected: i % 2 === 0 ? 'billing' : 'bug',
  })),
};

const provenance = {
  source: 'notes.md',
  source_sha256: 'a'.repeat(64),
  drafted_by: 'gemma3:4b (ollama 0.23.1)',
  drafted_at: '2026-07-17',
  reviewed: false,
};

describe('writePackDraft', () => {
  it('writes a pack the strict loader accepts untouched, provenance included', () => {
    const written = writePackDraft(join(root, 'clean'), draft, provenance);
    expect(written.files).toContain('task.yaml');
    expect(written.files).toContain('prompt.md');
    expect(written.files.filter((f) => f.startsWith('examples/'))).toHaveLength(12);

    const pack = loadTaskPack(written.dir, listScorers());
    expect(pack.manifest.name).toBe('ticket-triage');
    expect(pack.manifest.provenance).toEqual(provenance);
    expect(pack.examples).toHaveLength(12);
    expect(pack.promptTemplate).toContain('{{input}}');
    expect(pack.manifest.generation.runs_per_example).toBe(3);
  });

  it('tells the user to review before trusting, in the manifest itself', () => {
    const written = writePackDraft(join(root, 'commented'), draft, provenance);
    const yaml = readFileSync(join(written.dir, 'task.yaml'), 'utf8');
    expect(yaml).toContain('review the examples');
    expect(yaml).toContain('reviewed: false');
  });

  it('never overwrites an existing pack and says what to do', () => {
    writePackDraft(join(root, 'twice'), draft, provenance);
    expect(() => writePackDraft(join(root, 'twice'), draft, provenance)).toThrow(
      /already exists.*pick another directory/,
    );
  });
});
