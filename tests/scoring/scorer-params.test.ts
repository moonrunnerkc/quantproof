import { describe, expect, it } from 'vitest';
import {
  optionalChoice,
  optionalStringRecord,
  requireNumber,
  requireObject,
  requireStringArray,
} from '../../src/scoring/scorer-params.js';

describe('requireStringArray', () => {
  it('returns a valid string array', () => {
    expect(requireStringArray('s', { k: ['a', 'b'] }, 'k')).toEqual(['a', 'b']);
  });
  it.each([
    ['missing', {}],
    ['empty', { k: [] }],
    ['non-array', { k: 'a' }],
    ['mixed types', { k: ['a', 1] }],
  ])('rejects a %s value with the scorer and key in the message', (_name, params) => {
    expect(() => requireStringArray('my-scorer', params, 'k')).toThrow(
      /scorer "my-scorer" param "k".*scorer_params\.k/,
    );
  });
});

describe('requireNumber', () => {
  it('returns a valid number', () => {
    expect(requireNumber('s', { k: 0.5 }, 'k')).toBe(0.5);
  });
  it.each([
    ['missing', {}],
    ['string', { k: '5' }],
    ['NaN', { k: Number.NaN }],
    ['Infinity', { k: Number.POSITIVE_INFINITY }],
  ])('rejects a %s value', (_name, params) => {
    expect(() => requireNumber('s', params, 'k')).toThrow(/finite number/);
  });
});

describe('optionalChoice', () => {
  it('returns the fallback when absent', () => {
    expect(optionalChoice('s', {}, 'k', ['a', 'b'], 'a')).toBe('a');
  });
  it('returns a declared choice', () => {
    expect(optionalChoice('s', { k: 'b' }, 'k', ['a', 'b'], 'a')).toBe('b');
  });
  it('rejects a value outside the choices, listing them', () => {
    expect(() => optionalChoice('s', { k: 'z' }, 'k', ['a', 'b'], 'a')).toThrow(/one of: a, b/);
  });
});

describe('optionalStringRecord', () => {
  it('returns an empty record when absent', () => {
    expect(optionalStringRecord('s', {}, 'k')).toEqual({});
  });
  it('returns a valid record', () => {
    expect(optionalStringRecord('s', { k: { a: 'b' } }, 'k')).toEqual({ a: 'b' });
  });
  it('rejects an array', () => {
    expect(() => optionalStringRecord('s', { k: ['a'] }, 'k')).toThrow(/object mapping/);
  });
  it('rejects non-string values, naming the offending key', () => {
    expect(() => optionalStringRecord('s', { k: { a: 1 } }, 'k')).toThrow(/"a" maps to a number/);
  });
});

describe('requireObject', () => {
  it('returns a valid object', () => {
    expect(requireObject('s', { k: { a: 1 } }, 'k')).toEqual({ a: 1 });
  });
  it.each([
    ['missing', {}],
    ['array', { k: [] }],
    ['string', { k: 'x' }],
    ['null', { k: null }],
  ])('rejects a %s value', (_name, params) => {
    expect(() => requireObject('s', params, 'k')).toThrow(/must be an object/);
  });
});
