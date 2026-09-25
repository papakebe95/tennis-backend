// French text for the seeded rows. Each entry ends up in the row's
// `translations` column as `{ fr: { ... } }` (see src/i18n/localize.ts); the
// English text stays in the plain columns as the default and fallback.

export const COUNTRY_TRANSLATIONS: Record<string, { name: string }> = {
  Senegal: { name: 'Sénégal' },
};

export const PRODUCT_CATEGORY_TRANSLATIONS: Record<string, { label: string }> =
  {
    RACKET: { label: 'Raquettes' },
    SHOES: { label: 'Chaussures' },
    APPAREL: { label: 'Vêtements' },
    BAGS: { label: 'Sacs' },
    BALLS: { label: 'Balles' },
    ACCESSORIES: { label: 'Accessoires' },
    OTHER: { label: 'Autres' },
  };

// Keyed by club name.
export const CLUB_TRANSLATIONS: Record<string, { description: string }> = {
  'Stade L.S.S': {
    description:
      'Courts de tennis du complexe sportif du stade Léopold Sédar Senghor, où se joue l’une des compétitions de club les plus disputées de Dakar.',
  },
  ASTU: {
    description:
      'Association Sportive des Travailleurs Unis, un club de quartier historique à l’ambiance conviviale et chaleureuse.',
  },
  'Olympic Club': {
    description:
      'Un club omnisports haut de gamme à Dakar, avec un solide programme de tennis, une académie de coaching et des courts bien entretenus.',
  },
  'T.C.D': {
    description:
      'Le Tennis Club de Dakar, l’un des plus anciens et des plus prestigieux clubs de la ville, réputé pour ses compétitions par équipes.',
  },
  ASAC: {
    description:
      'Association Sportive et d’Athlétisme, un club familial aux tarifs accessibles avec un programme junior en pleine croissance.',
  },
  'King Fahd': {
    description:
      'Des courts situés dans l’enceinte de l’hôtel King Fahd Palace, dans un cadre de villégiature avec des équipements de premier plan.',
  },
};

// Keyed by the seed's `key`.
export const COMPETITION_TRANSLATIONS: Record<
  string,
  { category: string; description: string }
> = {
  teranga: {
    category: 'Open · Simple',
    description:
      'Le plus grand week-end amateur de la saison. Élimination directe, meilleur des trois sets, un vrai tableau et une remise des trophées sous les projecteurs.',
  },
  'dakar-open': {
    category: 'Hommes & Femmes · 3.0–4.5',
    description:
      'Deux tableaux, un week-end. Jouez à votre niveau, rencontrez des joueurs de tous les clubs de la ville et gagnez des points pour le classement de la saison.',
  },
  'clay-classic': {
    category: 'Intermédiaire · Simple',
    description:
      'De longs échanges, des glissades et l’air marin. Une poule unique pour que chacun joue au moins trois matchs.',
  },
  'night-series': {
    category: 'Tous niveaux · Simple',
    description:
      'Des matchs après le travail sous les projecteurs. Format court, ambiance détendue, grosse ambiance.',
  },
  'masters-45': {
    category: 'Seniors 45+ · Simple',
    description:
      'L’expérience l’emporte sur la puissance. Un tournoi amical mais âprement disputé pour les joueurs de plus de 45 ans.',
  },
  rentree: {
    category: 'Open · Simple',
    description:
      'L’ouverture de la saison, jouée le mois dernier — découvrez qui a soulevé le trophée.',
  },
};

// Keyed by the story's English title; `slides` lines up with the seed's slides.
export const STORY_TRANSLATIONS: Record<
  string,
  {
    title: string;
    slides: { headline: string; body?: string; ctaLabel?: string }[];
  }
> = {
  'Teranga Cup': {
    title: 'Coupe Teranga',
    slides: [
      {
        headline: 'La Coupe Teranga est lancée',
        body: 'Les huitièmes de finale sont en cours au club.',
      },
      {
        headline: 'Suivez le tableau',
        body: 'Qui joue contre qui, et quand.',
        ctaLabel: 'Voir le tournoi',
      },
    ],
  },
  'Dakar Open': {
    title: 'Dakar Open',
    slides: [
      {
        headline: 'Les inscriptions sont ouvertes',
        body: 'Le Dakar Open Amateur commence dans une semaine.',
      },
      {
        headline: 'Deux tableaux, 64 joueurs',
        body: 'Jouez à votre niveau et gagnez des points pour la saison.',
      },
      { headline: 'Réservez votre place', ctaLabel: 'S’inscrire' },
    ],
  },
  'Serve tips': {
    title: 'Conseils de service',
    slides: [
      {
        headline: 'Lancez plus haut',
        body: 'Un lancer de balle régulier fait 80 % d’un bon service.',
      },
      {
        headline: 'Fléchissez les genoux',
        body: 'La puissance vient des jambes, pas du bras.',
      },
      {
        headline: 'Terminez le geste',
        body: 'Laissez la raquette finir sa course en travers du corps.',
      },
    ],
  },
  'Book a court': {
    title: 'Réservez un court',
    slides: [
      {
        headline: 'Les créneaux du soir partent vite',
        body: 'Réservez avant 18 h pour être tranquille.',
        ctaLabel: 'Trouver un court',
      },
    ],
  },
  'Season race': {
    title: 'La course de la saison',
    slides: [
      {
        headline: 'Chaque match compte',
        body: 'Une victoire officielle rapporte 100 points, un match amical 50.',
      },
      {
        headline: 'Grimpez les échelons',
        body: 'De Débutant à Champion — suivez votre progression.',
        ctaLabel: 'Ma saison',
      },
    ],
  },
  'Gear deals': {
    title: 'Bons plans matériel',
    slides: [
      {
        headline: 'Des raquettes toutes fraîches sur le marché',
        body: 'Du matériel d’occasion de joueurs près de chez vous.',
        ctaLabel: 'Parcourir le marché',
      },
    ],
  },
};
