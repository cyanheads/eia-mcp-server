/**
 * @fileoverview Tests for the normalizeDescription pure formatter in route-cache.
 * @module tests/services/normalize-description.test
 */

import { describe, expect, it } from 'vitest';
import { normalizeDescription } from '@/services/eia/route-cache.js';

describe('normalizeDescription', () => {
  it('returns empty string for undefined', () => {
    expect(normalizeDescription(undefined)).toBe('');
  });

  it('returns empty string for empty string', () => {
    expect(normalizeDescription('')).toBe('');
  });

  it('collapses embedded CRLF sequences to a single space', () => {
    const raw = 'Retail\r\n  electricity\r\n  sales';
    expect(normalizeDescription(raw)).toBe('Retail electricity sales');
  });

  it('collapses newlines with leading whitespace', () => {
    const raw = 'Energy\n  production by\n  state';
    expect(normalizeDescription(raw)).toBe('Energy production by state');
  });

  it('collapses multiple consecutive spaces to one', () => {
    expect(normalizeDescription('one   two    three')).toBe('one two three');
  });

  it('trims leading and trailing whitespace', () => {
    expect(normalizeDescription('  leading and trailing  ')).toBe('leading and trailing');
  });

  it('handles a plain description without modification (except trim)', () => {
    expect(normalizeDescription('Gasoline prices by region')).toBe('Gasoline prices by region');
  });

  it('preserves unicode characters', () => {
    expect(normalizeDescription('Électricité données')).toBe('Électricité données');
  });

  it('handles only whitespace', () => {
    expect(normalizeDescription('   \n  \r\n  ')).toBe('');
  });
});
