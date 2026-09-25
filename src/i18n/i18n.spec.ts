import { describe, expect, it } from 'vitest';
import { en } from './locales/en.js';
import { fr } from './locales/fr.js';
import {
  amenityLabel,
  currentLang,
  langMiddleware,
  parseLang,
  runWithLang,
  t,
} from './i18n.js';

describe('parseLang', () => {
  it.each([
    ['fr', 'fr'],
    ['FR', 'fr'],
    ['fr-FR', 'fr'],
    ['fr_SN', 'fr'],
    ['fr;q=0.9, en;q=0.8', 'fr'],
    ['en-US', 'en'],
  ])('%s -> %s', (header, lang) => {
    expect(parseLang(header)).toBe(lang);
  });

  it('falls back to English for anything missing or unsupported', () => {
    expect(parseLang(undefined)).toBe('en');
    expect(parseLang('')).toBe('en');
    expect(parseLang('de')).toBe('en');
    expect(parseLang('*')).toBe('en');
  });
});

describe('t', () => {
  it('translates and fills placeholders', () => {
    expect(t('errors.products.unknownCategory', { code: 'X' }, 'en')).toBe(
      'Unknown product category "X"',
    );
    expect(t('errors.products.unknownCategory', { code: 'X' }, 'fr')).toBe(
      'Catégorie de produit inconnue « X »',
    );
  });

  it('uses the language of the current request, English outside of one', () => {
    expect(t('errors.clubs.notFound')).toBe('Club not found');
    expect(runWithLang('fr', () => t('errors.clubs.notFound'))).toBe(
      'Club introuvable',
    );
    expect(currentLang()).toBe('en');
  });

  it('leaves an unfilled placeholder visible rather than blank', () => {
    expect(t('errors.phone.max', {}, 'en')).toBe(
      'You can add up to {max} extra numbers',
    );
  });

  it('reads the lang header and exposes it to the rest of the request', () => {
    const headers: Record<string, string> = {};
    let seen: string | undefined;
    langMiddleware(
      { headers: { lang: 'fr-FR' } } as never,
      {
        setHeader: (k: string, v: string) => (headers[k] = v),
        vary: () => {},
      } as never,
      () => {
        seen = currentLang();
      },
    );
    expect(seen).toBe('fr');
    expect(headers['Content-Language']).toBe('fr');
  });

  it('keeps unknown amenities as they are', () => {
    expect(runWithLang('fr', () => amenityLabel('Pro shop'))).toBe('Boutique');
    expect(runWithLang('fr', () => amenityLabel('Sauna'))).toBe('Sauna');
  });
});

describe('locale files', () => {
  const keys = (node: object, prefix = ''): string[] =>
    Object.entries(node).flatMap(([k, v]) =>
      typeof v === 'string'
        ? [prefix + k]
        : keys(v as object, `${prefix}${k}.`),
    );
  const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();
  const get = (node: object, key: string) =>
    key
      .split('.')
      .reduce<never>((n, part) => (n as never)[part], node as never) as string;

  it('French has exactly the English keys', () => {
    expect(keys(fr).sort()).toEqual(keys(en).sort());
  });

  it('every French message keeps the placeholders of the English one', () => {
    for (const key of keys(en)) {
      expect(placeholders(get(fr, key)), key).toEqual(
        placeholders(get(en, key)),
      );
    }
  });
});
