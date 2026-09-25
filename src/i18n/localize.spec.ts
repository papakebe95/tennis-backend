import { describe, expect, it } from 'vitest';
import { localize } from './localize.js';

const category = {
  code: 'RACKET',
  label: 'Rackets',
  translations: { fr: { label: 'Raquettes' } },
};

describe('localize', () => {
  it('overlays the requested language and drops the translations column', () => {
    expect(localize(category, 'fr')).toEqual({
      code: 'RACKET',
      label: 'Raquettes',
    });
  });

  it('keeps the default text in English, for other languages and when untranslated', () => {
    expect(localize(category, 'en')).toEqual({
      code: 'RACKET',
      label: 'Rackets',
    });
    expect(localize({ ...category, translations: null }, 'fr').label).toBe(
      'Rackets',
    );
    expect(
      localize<{ label: string; translations?: unknown }>(
        { label: 'Rackets' },
        'fr',
      ).label,
    ).toBe('Rackets');
  });

  it('falls back field by field, and ignores empty translations', () => {
    const row = {
      name: 'Cup',
      description: 'Big',
      translations: { fr: { description: 'Grand', name: null, unknown: 'x' } },
    };
    expect(localize(row, 'fr')).toEqual({ name: 'Cup', description: 'Grand' });
  });

  it('translates story slides by index without losing their images and routes', () => {
    const story = {
      title: 'Dakar Open',
      slides: [
        { imageUrl: 'a.jpg', headline: 'Open', ctaLabel: 'Go', route: '/x' },
        { imageUrl: 'b.jpg', headline: 'Two draws' },
      ],
      translations: {
        fr: {
          title: 'Dakar Open',
          slides: [{ headline: 'Ouvert', ctaLabel: 'Y aller' }],
        },
      },
    };
    expect(localize(story, 'fr').slides).toEqual([
      {
        imageUrl: 'a.jpg',
        headline: 'Ouvert',
        ctaLabel: 'Y aller',
        route: '/x',
      },
      { imageUrl: 'b.jpg', headline: 'Two draws' },
    ]);
  });
});
