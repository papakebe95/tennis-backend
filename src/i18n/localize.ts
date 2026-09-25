import { DEFAULT_LANG, currentLang, type Lang } from './i18n.js';

type Overlay = Record<string, unknown>;

// Arrays (a story's slides) are translated per index: only the keys present in
// the translation override, so `imageUrl`, `route`, ... carry over untouched.
const merge = (base: unknown, translated: unknown): unknown => {
  if (Array.isArray(base) && Array.isArray(translated)) {
    return base.map((item, i) => merge(item, translated[i]));
  }
  if (
    base &&
    translated &&
    typeof base === 'object' &&
    typeof translated === 'object' &&
    !Array.isArray(base) &&
    !Array.isArray(translated)
  ) {
    return { ...base, ...translated };
  }
  return translated ?? base;
};

/**
 * Applies a row's `translations` for `lang` over its plain columns and drops
 * the `translations` column from the result. The plain columns hold the
 * default language, so a row (or a single field) without a translation simply
 * keeps its default text.
 *
 *   localize({ label: 'Rackets', translations: { fr: { label: 'Raquettes' } } })
 *   // fr -> { label: 'Raquettes' }   en -> { label: 'Rackets' }
 */
export function localize<T extends { translations?: unknown }>(
  row: T,
  lang: Lang = currentLang(),
): Omit<T, 'translations'> {
  const { translations, ...rest } = row;
  const overlay =
    lang === DEFAULT_LANG
      ? undefined
      : (translations as Record<string, Overlay> | null | undefined)?.[lang];
  if (!overlay) return rest;

  const result: Overlay = { ...rest };
  for (const [field, value] of Object.entries(overlay)) {
    if (field in result && value != null) {
      result[field] = merge(result[field], value);
    }
  }
  return result as Omit<T, 'translations'>;
}
