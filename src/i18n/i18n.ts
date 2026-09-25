import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';
import { en } from './locales/en.js';
import { fr } from './locales/fr.js';

export const SUPPORTED_LANGS = ['en', 'fr'] as const;
export type Lang = (typeof SUPPORTED_LANGS)[number];
export const DEFAULT_LANG: Lang = 'en';

// Locale used for dates and numbers spoken in a language.
export const INTL_LOCALES: Record<Lang, string> = { en: 'en-GB', fr: 'fr-FR' };

type Dictionary = { [key: string]: string | Dictionary };
const dictionaries: Record<Lang, Dictionary> = { en, fr };

type Paths<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string
    ? `${Prefix}${K}`
    : Paths<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

/** Every translatable key, e.g. "errors.club.notFound". */
export type MessageKey = Paths<typeof en>;
export type MessageParams = Record<string, string | number | null | undefined>;

const storage = new AsyncLocalStorage<Lang>();

/** "fr-FR", "FR", "fr;q=0.9" -> "fr". Anything unsupported -> the default. */
export function parseLang(header: string | string[] | undefined): Lang {
  const raw = Array.isArray(header) ? header[0] : header;
  const code = raw
    ?.trim()
    .toLowerCase()
    .split(/[-_,;\s]/)[0];
  return SUPPORTED_LANGS.find((lang) => lang === code) ?? DEFAULT_LANG;
}

/** Language of the request being handled; the default outside of a request. */
export function currentLang(): Lang {
  return storage.getStore() ?? DEFAULT_LANG;
}

export function runWithLang<T>(lang: Lang, fn: () => T): T {
  return storage.run(lang, fn);
}

/** Reads the `lang` header and makes it available to `t()` for the request. */
export function langMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const lang = parseLang(req.headers['lang']);
  res.setHeader('Content-Language', lang);
  res.vary('lang');
  storage.run(lang, next);
}

/** A club amenity's label in the request's language (unknown ones stay as is). */
export function amenityLabel(name: string): string {
  const key = `amenities.${name}` as MessageKey;
  const label = t(key);
  return label === key ? name : label;
}

const lookup = (dictionary: Dictionary, key: string): string | undefined => {
  let node: string | Dictionary | undefined = dictionary;
  for (const part of key.split('.')) {
    if (typeof node !== 'object') return undefined;
    node = node[part];
  }
  return typeof node === 'string' ? node : undefined;
};

/**
 * Translates `key` into the request's language (or `lang`), filling `{name}`
 * placeholders from `params`. A key missing in a language falls back to the
 * default language, so a half-finished translation never shows a raw key.
 */
export function t(
  key: MessageKey,
  params?: MessageParams,
  lang: Lang = currentLang(),
): string {
  const template =
    lookup(dictionaries[lang], key) ??
    lookup(dictionaries[DEFAULT_LANG], key) ??
    key;
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    params?.[name] != null ? String(params[name]) : placeholder,
  );
}
