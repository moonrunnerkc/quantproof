import { describe, expect, it } from 'vitest';
import { SOURCE_CHAR_BUDGET, buildDraftPrompt } from '../../src/ingest/draft-prompt.js';

describe('buildDraftPrompt', () => {
  it('names every scorer and demands the input placeholder', () => {
    const prompt = buildDraftPrompt('classify my tickets', 'notes.md');
    for (const scorer of ['exact-label', 'field-f1', 'json-schema', 'numeric-tolerance', 'pattern']) {
      expect(prompt).toContain(`"${scorer}"`);
    }
    expect(prompt).toContain('{{input}}');
    expect(prompt).toContain('notes.md');
    expect(prompt).toContain('classify my tickets');
  });

  it('truncates an oversized source and says so', () => {
    const prompt = buildDraftPrompt('x'.repeat(SOURCE_CHAR_BUDGET + 500), 'big.md');
    expect(prompt).toContain('truncated to fit');
    expect(prompt.length).toBeLessThan(SOURCE_CHAR_BUDGET + 3000);
  });

  it('feeds the failed draft and its errors back on a repair round', () => {
    const prompt = buildDraftPrompt('doc', 'notes.md', {
      previousDraft: '{"name": ""}',
      errors: ['"name" must be a non-empty string'],
    });
    expect(prompt).toContain('previous draft failed validation');
    expect(prompt).toContain('{"name": ""}');
    expect(prompt).toContain('- "name" must be a non-empty string');
  });
});
