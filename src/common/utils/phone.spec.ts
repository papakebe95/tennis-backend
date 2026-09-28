import { describe, expect, it } from 'vitest';
import { normalizePhone, toInternationalPhone } from './phone.js';

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

describe('toInternationalPhone', () => {
  it.each([
    ['77 000 01 01', '+221770000101'],
    ['221770000101', '+221770000101'],
    ['+33 6 12 34 56 78', '+33612345678'],
    ['0033612345678', '+33612345678'],
  ])('%s → %s', (raw, expected) => {
    expect(toInternationalPhone(raw, '221')).toBe(expected);
  });

  it('rejects what is not a phone number', () => {
    expect(toInternationalPhone('abc', '221')).toBeNull();
  });
});
