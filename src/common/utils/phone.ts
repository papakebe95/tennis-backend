/**
 * "+221 77 000-01-01" -> "+221770000101"; null when it can't be a phone
 * number. Shared by registration (User.msisdn) and the extra-numbers flow
 * (UserPhone.number) so the same number always normalizes to the same
 * string, no matter how it was typed or which endpoint it came through.
 */
export function normalizePhone(raw: string): string | null {
  let value = raw.replace(/[\s().-]/g, '');
  if (value.startsWith('00')) value = `+${value.slice(2)}`;
  return /^\+?[1-9]\d{7,14}$/.test(value) ? value : null;
}

/**
 * Like normalizePhone, but always international: a number typed without a
 * country code gets `callingCode` ("77 000 01 01" → "+221770000101"; a
 * leading "221…" is read as the code itself). Used for account numbers, so
 * the same phone can't be registered twice in two spellings.
 */
export function toInternationalPhone(raw: string, callingCode: string): string | null {
  const value = normalizePhone(raw);
  if (!value || value.startsWith('+')) return value;
  const international = value.startsWith(callingCode) && value.length > callingCode.length + 8
    ? `+${value}`
    : `+${callingCode}${value}`;
  return normalizePhone(international);
}
