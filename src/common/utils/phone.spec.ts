import { describe, expect, it } from 'vitest';
import { normalizePhone } from './phone.js';

describe('normalizePhone', () => {
  it.each([
    ['+221 77 000-01-01', '+221770000101'],
    ['00221770000101', '+221770000101'],
    ['(770) 000 101', '770000101'],
  ])('normalizes %s', (raw, expected) => {
    expect(normalizePhone(raw)).toBe(expected);
  });

  it.each(['abc', '123', '+0123456789', ''])('rejects %j', (raw) => {
    expect(normalizePhone(raw)).toBeNull();
  });

  it('treats different spellings of the same number as identical', () => {
    expect(normalizePhone('+221 77 000 01 01')).toBe(
      normalizePhone('+221770000101'),
    );
  });
});
