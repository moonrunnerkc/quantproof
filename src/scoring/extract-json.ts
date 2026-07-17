/**
 * Extraction of a JSON value from raw model output.
 *
 * Local models routinely wrap valid JSON in markdown fences or prose
 * ("Here is the extracted data: ..."). Scorers that need JSON call this
 * instead of JSON.parse so that wrapping costs nothing but is recorded.
 */

/** Result of attempting to pull a JSON value out of model output. */
export interface JsonExtraction {
  /** The parsed value, present only when parsing succeeded. */
  readonly value?: unknown;
  /** True when parsing succeeded. */
  readonly ok: boolean;
  /**
   * True when the output was not itself valid JSON and a balanced JSON
   * value had to be carved out of surrounding fences or prose.
   */
  readonly extractionNeeded: boolean;
  /** Parse failure description, present only when ok is false. */
  readonly error?: string;
}

/**
 * Scans from `start` (an opening brace or bracket) to the index just
 * past its balanced closing counterpart, honoring JSON string literals
 * and escapes. Returns -1 when the value never closes.
 */
function findBalancedEnd(text: string, start: number): number {
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') {
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
    } else if (ch === '"') {
      inString = true;
    } else if (ch === open) {
      depth += 1;
    } else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        return i + 1;
      }
    }
  }
  return -1;
}

/**
 * Extracts the first balanced JSON value from model output.
 *
 * Tries a direct parse of the trimmed output first (extractionNeeded
 * stays false on that path). Otherwise scans for the first `{` or `[`,
 * carves out the balanced value, and parses that. Objects and arrays
 * only on the extraction path; a bare string or number buried in prose
 * is not treated as JSON.
 *
 * @param output - Raw model output.
 * @returns The extraction result; never throws. On failure, `error`
 *   says why so scorer details can surface it.
 */
export function extractJson(output: string): JsonExtraction {
  const trimmed = output.trim();
  try {
    return { value: JSON.parse(trimmed) as unknown, ok: true, extractionNeeded: false };
  } catch {
    // Fall through to balanced-value extraction.
  }
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (ch !== '{' && ch !== '[') {
      continue;
    }
    const end = findBalancedEnd(trimmed, i);
    if (end === -1) {
      return {
        ok: false,
        extractionNeeded: true,
        error: `output contains an unclosed ${ch === '{' ? 'object' : 'array'} starting at character ${String(i)}`,
      };
    }
    const candidate = trimmed.slice(i, end);
    try {
      return {
        value: JSON.parse(candidate) as unknown,
        ok: true,
        extractionNeeded: true,
      };
    } catch (err) {
      return {
        ok: false,
        extractionNeeded: true,
        error: `balanced candidate at character ${String(i)} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  return {
    ok: false,
    extractionNeeded: false,
    error: 'output contains no JSON object or array',
  };
}
