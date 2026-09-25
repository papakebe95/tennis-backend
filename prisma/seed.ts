// Idempotent seed script for local/dev databases.
//
// Prisma 7's query engine is a WASM query compiler, so (same as
// PrismaService) a driver adapter is required to actually talk to Postgres.
//
// Run with `npx prisma db seed` (registered via `migrations.seed` in
// prisma.config.ts) or directly with `npx tsx prisma/seed.ts`.
import 'dotenv/config';
import {
  CompetitionFormat,
  CompetitionStatus,
  FinalSetFormat,
  MatchStatus,
  NotificationType,
  PlayerSide,
  PrismaClient,
  ProductCondition,
  ProductStatus,
  PurchaseRequestStatus,
  Surface,
} from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcrypt';
import {
  CLUB_TRANSLATIONS,
  COMPETITION_TRANSLATIONS,
  COUNTRY_TRANSLATIONS,
  PRODUCT_CATEGORY_TRANSLATIONS,
  STORY_TRANSLATIONS,
} from './seed-translations.js';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

// Wraps French text as a row's `translations` value (undefined leaves it unset).
const fr = (text?: object) => (text ? { fr: text } : undefined);

// ISO 3166-1 alpha-2 codes for the countries the seed data mentions.
const COUNTRY_CODES: Record<string, string> = { Senegal: 'SN' };

// Country -> City, created on demand and reused (idempotent).
async function cityIdFor(cityName: string, countryName: string) {
  const code = COUNTRY_CODES[countryName];
  if (!code) {
    throw new Error(
      `Add an ISO code for "${countryName}" to COUNTRY_CODES in the seed`,
    );
  }
  const country = await prisma.country.upsert({
    where: { code },
    update: { name: countryName, translations: fr(COUNTRY_TRANSLATIONS[countryName]) },
    create: { code, name: countryName, translations: fr(COUNTRY_TRANSLATIONS[countryName]) },
  });
  const city = await prisma.city.upsert({
    where: { countryId_name: { countryId: country.id, name: cityName } },
    update: {},
    create: { name: cityName, countryId: country.id },
  });
  return city.id;
}

type ProductCategoryCode =
  | 'RACKET'
  | 'SHOES'
  | 'APPAREL'
  | 'BAGS'
  | 'BALLS'
  | 'ACCESSORIES'
  | 'OTHER';

// The marketplace categories, in the order the app lists them.
const PRODUCT_CATEGORY_SEEDS: {
  code: ProductCategoryCode;
  label: string;
  icon: string;
}[] = [
  { code: 'RACKET', label: 'Rackets', icon: 'racket' },
  { code: 'SHOES', label: 'Shoes', icon: 'shoes' },
  { code: 'APPAREL', label: 'Apparel', icon: 'apparel' },
  { code: 'BAGS', label: 'Bags', icon: 'bags' },
  { code: 'BALLS', label: 'Balls', icon: 'balls' },
  { code: 'ACCESSORIES', label: 'Accessories', icon: 'accessories' },
  { code: 'OTHER', label: 'Other', icon: 'other' },
];

// Upserts the categories and returns code -> id.
async function seedProductCategories() {
  const ids = {} as Record<ProductCategoryCode, string>;
  for (const [index, category] of PRODUCT_CATEGORY_SEEDS.entries()) {
    const { code, label, icon } = category;
    const translations = fr(PRODUCT_CATEGORY_TRANSLATIONS[code]);
    const row = await prisma.productCategory.upsert({
      where: { code },
      update: { label, icon, sortOrder: index + 1, translations },
      create: { code, label, icon, sortOrder: index + 1, translations },
    });
    ids[code] = row.id;
  }
  return ids;
}

interface CourtSeed {
  name: string;
  surface: Surface;
  indoor: boolean;
  pricePerHour: number;
}

interface ClubSeed {
  name: string;
  slug: string;
  photoCount: number;
  description: string;
  address: string;
  city: string;
  country: string;
  latitude: number;
  longitude: number;
  amenities: string[];
  openingHours: Record<string, string>;
  courts: CourtSeed[];
}

const DEFAULT_HOURS = {
  'mon-fri': '07:00-22:00',
  'sat-sun': '08:00-20:00',
};

// Curated, freely-licensed real tennis photography (Unsplash License: free
// for commercial and noncommercial use, no permission required) — courts,
// nets, balls, rackets, players. None of these depict any specific named
// club or business; they're generic, realistic tennis imagery standing in
// until real club-submitted photos exist. Deliberately NOT photos of any
// actual named clubs (some of these seeded club names resemble real Dakar
// sports associations) — using real businesses' own photography without
// their involvement would misrepresent them.
const TENNIS_PHOTO_IDS = [
  '1545151414-8a948e1ea54f',
  '1499510318569-1a3d67dc3976',
  '1699117686612-ece525e4f91a',
  '1567220720374-a67f33b2a6b9',
  '1614743758466-e569f4791116',
  '1692288720754-743fbd1f2155',
  '1717869835053-bc3f150e105f',
  '1541744573515-478c959628a0',
  '1632755898125-36cd72575dde',
  '1620742820748-87c09249a72a',
];

// Seed photos are mirrored in our R2 bucket under seed/ (originally sourced
// from Unsplash), so seeded data doesn't depend on a third-party host.
const R2_PUBLIC_URL = (
  process.env.R2_PUBLIC_URL ?? 'https://pub-40b3d89b0df9456088de3896732855cd.r2.dev'
).replace(/\/$/, '');

function unsplashUrl(id: string, width: number, height: number): string {
  return `${R2_PUBLIC_URL}/seed/photo-${id}-${width}x${height}.jpg`;
}

// Deterministic pseudo-random pick from a string so re-seeding always
// selects the same photo for the same club/court slug (idempotent).
function hashIndex(seed: string, modulo: number): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return hash % modulo;
}

function bannerUrl(slug: string): string {
  const id = TENNIS_PHOTO_IDS[hashIndex(`${slug}-banner`, TENNIS_PHOTO_IDS.length)];
  return unsplashUrl(id, 1200, 675);
}

function photoUrls(slug: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => {
    const id = TENNIS_PHOTO_IDS[hashIndex(`${slug}-${i + 1}`, TENNIS_PHOTO_IDS.length)];
    return unsplashUrl(id, 900, 900);
  });
}

// Slugifies a court name for use in the photo-selection hash, e.g.
// "Court Alboury Ndiaye" -> "court-alboury-ndiaye".
function slugifyCourtName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

// Same curated-pool pattern as club photos, but keyed by "<clubSlug>-<court
// slug>-<n>" so each court gets its own (deterministic) set of images.
function courtPhotoUrls(clubSlug: string, courtName: string, count: number): string[] {
  const courtSlug = `${clubSlug}-${slugifyCourtName(courtName)}`;
  return Array.from({ length: count }, (_, i) => {
    const id = TENNIS_PHOTO_IDS[hashIndex(`${courtSlug}-${i + 1}`, TENNIS_PHOTO_IDS.length)];
    return unsplashUrl(id, 800, 800);
  });
}

const clubs: ClubSeed[] = [
  {
    name: 'Stade L.S.S',
    slug: 'stade-lss',
    photoCount: 6,
    description:
      "Tennis courts within the Stade Léopold Sédar Senghor sporting complex, home to some of Dakar's most competitive club play.",
    address: 'Avenue Cheikh Anta Diop, Stade Léopold Sédar Senghor',
    city: 'Dakar',
    country: 'Senegal',
    latitude: 14.7247,
    longitude: -17.4658,
    amenities: ['Parking', 'Floodlights', 'Clubhouse'],
    openingHours: DEFAULT_HOURS,
    courts: [
      {
        name: 'Court Cheikh Anta Diop',
        surface: Surface.HARD,
        indoor: false,
        pricePerHour: 7500,
      },
      {
        name: 'Court Lat Dior',
        surface: Surface.HARD,
        indoor: false,
        pricePerHour: 7500,
      },
      {
        name: 'Court Fann',
        surface: Surface.CLAY,
        indoor: false,
        pricePerHour: 9000,
      },
    ],
  },
  {
    name: 'ASTU',
    slug: 'astu',
    photoCount: 4,
    description:
      'Association Sportive des Travailleurs Unis, a long-standing neighborhood tennis club with a welcoming, community feel.',
    address: 'Rue 10 x Rue 15, Médina',
    city: 'Dakar',
    country: 'Senegal',
    latitude: 14.6795,
    longitude: -17.4453,
    amenities: ['Parking', 'Locker rooms'],
    openingHours: DEFAULT_HOURS,
    courts: [
      {
        name: 'Court Alboury Ndiaye',
        surface: Surface.HARD,
        indoor: false,
        pricePerHour: 5000,
      },
      {
        name: 'Court Ndeye Fatou',
        surface: Surface.HARD,
        indoor: false,
        pricePerHour: 5000,
      },
    ],
  },
  {
    name: 'Olympic Club',
    slug: 'olympic-club',
    photoCount: 6,
    description:
      'A premium multi-sport club in Dakar with a strong tennis program, coaching academy, and well-maintained courts.',
    address: 'Route de la Corniche Ouest, Fann Résidence',
    city: 'Dakar',
    country: 'Senegal',
    latitude: 14.6928,
    longitude: -17.4874,
    amenities: ['Parking', 'Pro shop', 'Locker rooms', 'Coaching'],
    openingHours: DEFAULT_HOURS,
    courts: [
      {
        name: 'Court Aline Sitoé Diatta',
        surface: Surface.HARD,
        indoor: false,
        pricePerHour: 10000,
      },
      {
        name: 'Court Blaise Diagne',
        surface: Surface.HARD,
        indoor: true,
        pricePerHour: 15000,
      },
      {
        name: 'Court Ngor',
        surface: Surface.CLAY,
        indoor: false,
        pricePerHour: 12000,
      },
      {
        name: 'Court Yoff',
        surface: Surface.HARD,
        indoor: false,
        pricePerHour: 10000,
      },
    ],
  },
  {
    name: 'T.C.D',
    slug: 'tcd',
    photoCount: 5,
    description:
      'Tennis Club de Dakar, one of the oldest and most storied tennis clubs in the city, known for its competitive league play.',
    address: 'Avenue Georges Pompidou, Plateau',
    city: 'Dakar',
    country: 'Senegal',
    latitude: 14.6673,
    longitude: -17.4304,
    amenities: ['Clubhouse', 'Pro shop', 'Floodlights'],
    openingHours: DEFAULT_HOURS,
    courts: [
      {
        name: 'Court Lat Dior',
        surface: Surface.CLAY,
        indoor: false,
        pricePerHour: 11000,
      },
      {
        name: 'Court Fann',
        surface: Surface.HARD,
        indoor: false,
        pricePerHour: 8000,
      },
      {
        name: 'Court Cheikh Anta Diop',
        surface: Surface.HARD,
        indoor: false,
        pricePerHour: 8000,
      },
    ],
  },
  {
    name: 'ASAC',
    slug: 'asac',
    photoCount: 4,
    description:
      "Association Sportive et d'Athlétisme, a family-friendly club with accessible pricing and a growing junior program.",
    address: 'Rue 6, Point E',
    city: 'Dakar',
    country: 'Senegal',
    latitude: 14.7012,
    longitude: -17.4611,
    amenities: ['Parking', 'Coaching'],
    openingHours: DEFAULT_HOURS,
    courts: [
      {
        name: 'Court Alboury Ndiaye',
        surface: Surface.HARD,
        indoor: false,
        pricePerHour: 4000,
      },
      {
        name: 'Court Ndeye Fatou',
        surface: Surface.HARD,
        indoor: false,
        pricePerHour: 4000,
      },
      {
        name: 'Court Yoff',
        surface: Surface.GRASS,
        indoor: false,
        pricePerHour: 6500,
      },
    ],
  },
  {
    name: 'King Fahd',
    slug: 'king-fahd',
    photoCount: 6,
    description:
      "Courts attached to the King Fahd Palace hotel grounds, offering a resort-style setting with top-tier facilities.",
    address: "Route de l'Aéroport, Les Almadies",
    city: 'Dakar',
    country: 'Senegal',
    latitude: 14.7368,
    longitude: -17.5142,
    amenities: ['Parking', 'Pro shop', 'Locker rooms', 'Floodlights'],
    openingHours: DEFAULT_HOURS,
    courts: [
      {
        name: 'Court Blaise Diagne',
        surface: Surface.HARD,
        indoor: false,
        pricePerHour: 13000,
      },
      {
        name: 'Court Aline Sitoé Diatta',
        surface: Surface.HARD,
        indoor: true,
        pricePerHour: 15000,
      },
      {
        name: 'Court Ngor',
        surface: Surface.HARD,
        indoor: false,
        pricePerHour: 13000,
      },
    ],
  },
];

async function main() {
  for (const clubSeed of clubs) {
    const { courts, slug, photoCount, city, country, ...rest } = clubSeed;
    const cityId = await cityIdFor(city, country);
    const clubData = {
      ...rest,
      cityId,
      translations: fr(CLUB_TRANSLATIONS[rest.name]),
      bannerUrl: bannerUrl(slug),
      photos: photoUrls(slug, photoCount),
    };

    // Club.name has no unique constraint in the schema, so upsert-by-name
    // isn't directly available; look the row up first instead.
    const existing = await prisma.club.findFirst({
      where: { name: clubData.name },
    });
    const club = existing
      ? await prisma.club.update({ where: { id: existing.id }, data: clubData })
      : await prisma.club.create({ data: clubData });

    // Seeded courts are keyed by (clubId, name): delete-then-recreate keeps
    // this idempotent without needing a unique constraint on the schema.
    await prisma.court.deleteMany({ where: { clubId: club.id } });
    await prisma.court.createMany({
      data: courts.map((court) => ({
        ...court,
        clubId: club.id,
        // A court is in its club's city (the schema enforces it).
        cityId,
        photos: courtPhotoUrls(slug, court.name, 3),
      })),
    });

    console.log(`Seeded club "${club.name}" with ${courts.length} courts`);
  }

  await seedMarketplace();
  await seedMatches();
  await seedHome();
}

// ---------------------------------------------------------------------------
// Marketplace seed: 3 seller users + ~18 products + a few purchase requests.
// Idempotent: users are upserted by email; the sellers' products (and, via
// cascade, their purchase requests) are deleted and recreated on every run.
// ---------------------------------------------------------------------------

interface SellerSeed {
  key: 'moussa' | 'aissatou' | 'cheikh';
  email: string;
  firstname: string;
  lastname: string;
  msisdn: string;
}

const SELLERS: SellerSeed[] = [
  {
    key: 'moussa',
    email: 'moussa.diallo@example.com',
    firstname: 'Moussa',
    lastname: 'Diallo',
    msisdn: '+221770000101',
  },
  {
    key: 'aissatou',
    email: 'aissatou.ndiaye@example.com',
    firstname: 'Aïssatou',
    lastname: 'Ndiaye',
    msisdn: '+221770000102',
  },
  {
    key: 'cheikh',
    email: 'cheikh.fall@example.com',
    firstname: 'Cheikh',
    lastname: 'Fall',
    msisdn: '+221770000103',
  },
];

// Unsplash License photo pools per category (ACCESSORIES / OTHER reuse the
// BALLS + RACKET pools).
const RACKET_PHOTOS = [
  '1622163642998-1ea32b0bbc67',
  '1542144582-1ba00456b5e3',
  '1530915365347-e35b749a0381',
  '1617883861744-13b534e3b928',
  '1560012057-4372e14c5085',
  '1646343253545-9171464ce425',
];
const SHOES_PHOTOS = [
  '1595341888016-a392ef81b7de',
  '1587683437362-da7775ffc532',
  '1599586120429-48281b6f0ece',
  '1524532787116-e70228437bbe',
  '1569597795160-dcc6d944587f',
  '1592670587543-f409a95839e0',
];
const BAGS_PHOTOS = [
  '1672223303533-05fddcbf6e6c',
  '1507473707539-69dc878df4fd',
  '1670252751272-8ce520dc1a95',
];
const BALLS_PHOTOS = [
  '1595435742656-5272d0b3fa82',
  '1510697963685-53101e615777',
  '1558365849-6ebd8b0454b2',
  '1541744573515-478c959628a0',
  '1632755898125-36cd72575dde',
];
const APPAREL_PHOTOS = [
  '1604272804518-4496d93d3652',
  '1595559786009-a696d446ad4a',
];

const PRODUCT_PHOTO_POOLS: Record<ProductCategoryCode, string[]> = {
  RACKET: RACKET_PHOTOS,
  SHOES: SHOES_PHOTOS,
  BAGS: BAGS_PHOTOS,
  BALLS: BALLS_PHOTOS,
  APPAREL: APPAREL_PHOTOS,
  ACCESSORIES: [...BALLS_PHOTOS, ...RACKET_PHOTOS],
  OTHER: [...BALLS_PHOTOS, ...RACKET_PHOTOS],
};

// Deterministic (hash-based, no Math.random) 1-4 distinct photos from the
// product's category pool, so re-seeding is stable.
function productPhotos(key: string, category: ProductCategoryCode): string[] {
  const pool = PRODUCT_PHOTO_POOLS[category];
  const count = Math.min(1 + hashIndex(`${key}-count`, 4), pool.length);
  const start = hashIndex(`${key}-start`, pool.length);
  return Array.from({ length: count }, (_, i) =>
    unsplashUrl(pool[(start + i) % pool.length], 900, 900),
  );
}

interface ProductSeed {
  key: string;
  seller: SellerSeed['key'];
  title: string;
  description: string;
  price: number; // XOF
  category: ProductCategoryCode;
  condition: ProductCondition;
  status: ProductStatus;
  city: string;
  daysAgo: number;
}

const PRODUCTS: ProductSeed[] = [
  {
    key: 'wilson-pro-staff-97',
    seller: 'moussa',
    title: 'Wilson Pro Staff 97 v13 — lightly used',
    description:
      'Wilson Pro Staff 97 v13, grip 3. Played about ten times, no frame damage, strung with Luxilon last month. Comes with a protective cover.',
    price: 95000,
    category: 'RACKET',
    condition: 'USED',
    status: 'AVAILABLE',
    city: 'Dakar',
    daysAgo: 1,
  },
  {
    key: 'babolat-pure-drive-2023',
    seller: 'aissatou',
    title: 'Babolat Pure Drive 2023 grip 3',
    description:
      'Babolat Pure Drive 2023 (300 g), grip 3. Great power racket, small paint chips on the bumper only. Fresh overgrip.',
    price: 85000,
    category: 'RACKET',
    condition: 'USED',
    status: 'AVAILABLE',
    city: 'Dakar',
    daysAgo: 2,
  },
  {
    key: 'head-boom-mp-2024',
    seller: 'cheikh',
    title: 'Head Boom MP 2024 — brand new with cover',
    description:
      'Head Boom MP 2024, grip 2, brand new and unstrung, still in its plastic. Bought abroad, wrong grip size for me.',
    price: 165000,
    category: 'RACKET',
    condition: 'NEW',
    status: 'AVAILABLE',
    city: 'Saly',
    daysAgo: 4,
  },
  {
    key: 'yonex-ezone-98',
    seller: 'moussa',
    title: 'Yonex EZONE 98 (2022) grip 2',
    description:
      'Yonex EZONE 98 2022, grip 2. Comfortable and arm-friendly. Some cosmetic wear on the throat, strings just replaced.',
    price: 110000,
    category: 'RACKET',
    condition: 'USED',
    status: 'RESERVED',
    city: 'Thiès',
    daysAgo: 6,
  },
  {
    key: 'wilson-clash-100-v2',
    seller: 'cheikh',
    title: 'Wilson Clash 100 v2 — restrung',
    description:
      'Wilson Clash 100 v2, grip 3. Very flexible and comfortable frame, restrung with multifilament two weeks ago.',
    price: 120000,
    category: 'RACKET',
    condition: 'USED',
    status: 'SOLD',
    city: 'Mbour',
    daysAgo: 9,
  },
  {
    key: 'nike-vapor-43',
    seller: 'moussa',
    title: 'Nike Court Air Zoom Vapor size 43',
    description:
      'Nike Court Air Zoom Vapor, EU size 43, hard-court sole. Worn for a single season, plenty of tread left.',
    price: 35000,
    category: 'SHOES',
    condition: 'USED',
    status: 'AVAILABLE',
    city: 'Dakar',
    daysAgo: 3,
  },
  {
    key: 'adidas-barricade-42',
    seller: 'aissatou',
    title: 'Adidas Barricade 2024 size 42 — new in box',
    description:
      'Adidas Barricade 2024, EU size 42. Never worn, still in the original box with tags. Durable all-court sole.',
    price: 78000,
    category: 'SHOES',
    condition: 'NEW',
    status: 'AVAILABLE',
    city: 'Saint-Louis',
    daysAgo: 8,
  },
  {
    key: 'asics-gel-resolution-44',
    seller: 'cheikh',
    title: 'Asics Gel-Resolution 9 size 44',
    description:
      'Asics Gel-Resolution 9, EU size 44. Very stable shoe for baseline players. Clay-court use only, cleaned and ready to play.',
    price: 42000,
    category: 'SHOES',
    condition: 'USED',
    status: 'AVAILABLE',
    city: 'Mbour',
    daysAgo: 12,
  },
  {
    key: 'head-tour-team-6r',
    seller: 'aissatou',
    title: 'Head Tour Team 6R bag',
    description:
      'Head Tour Team 6R racket bag, holds up to six rackets, thermal compartment and shoe pocket. Zips work perfectly.',
    price: 28000,
    category: 'BAGS',
    condition: 'USED',
    status: 'AVAILABLE',
    city: 'Dakar',
    daysAgo: 5,
  },
  {
    key: 'babolat-rdl-12',
    seller: 'moussa',
    title: 'Babolat Pure Aero RDL 12 racket bag',
    description:
      'Babolat Pure Aero RDL 12-racket bag, brand new with tags. Isothermal compartment, padded straps. Too big for my needs.',
    price: 62000,
    category: 'BAGS',
    condition: 'NEW',
    status: 'AVAILABLE',
    city: 'Saly',
    daysAgo: 14,
  },
  {
    key: 'dunlop-tournament-balls',
    seller: 'cheikh',
    title: 'Dunlop tournament balls, 12 cans, sealed',
    description:
      'A full case of 12 sealed cans (4 balls each) of Dunlop Tournament balls. Perfect for club training sessions.',
    price: 38000,
    category: 'BALLS',
    condition: 'NEW',
    status: 'AVAILABLE',
    city: 'Thiès',
    daysAgo: 7,
  },
  {
    key: 'wilson-us-open-balls',
    seller: 'aissatou',
    title: 'Wilson US Open balls, 4 cans',
    description:
      'Four sealed cans of Wilson US Open extra-duty balls. Ideal for hard courts.',
    price: 12000,
    category: 'BALLS',
    condition: 'NEW',
    status: 'AVAILABLE',
    city: 'Dakar',
    daysAgo: 10,
  },
  {
    key: 'adidas-dress-m',
    seller: 'aissatou',
    title: 'Adidas tennis dress size M',
    description:
      'Adidas tennis dress, size M, breathable fabric with built-in shorts. Worn a handful of times, no stains or pilling.',
    price: 15000,
    category: 'APPAREL',
    condition: 'USED',
    status: 'AVAILABLE',
    city: 'Mbour',
    daysAgo: 11,
  },
  {
    key: 'nike-dri-fit-set-l',
    seller: 'moussa',
    title: 'Nike Court Dri-FIT polo and shorts set, size L',
    description:
      'Nike Court Dri-FIT polo and matching shorts, size L, new with tags. Light and quick-drying, perfect for hot Senegalese afternoons.',
    price: 22000,
    category: 'APPAREL',
    condition: 'NEW',
    status: 'AVAILABLE',
    city: 'Saint-Louis',
    daysAgo: 16,
  },
  {
    key: 'yonex-poly-tour-pro',
    seller: 'cheikh',
    title: 'Yonex Poly Tour Pro string set',
    description:
      'Yonex Poly Tour Pro 125 (16L), 12 m set, unopened. Soft polyester with great spin potential.',
    price: 9500,
    category: 'ACCESSORIES',
    condition: 'NEW',
    status: 'AVAILABLE',
    city: 'Dakar',
    daysAgo: 18,
  },
  {
    key: 'overgrip-30-pack',
    seller: 'moussa',
    title: 'Overgrip x 30 pack',
    description:
      'Pack of 30 white tacky overgrips, sealed. Enough for a whole season of matches or for the club.',
    price: 2500,
    category: 'ACCESSORIES',
    condition: 'NEW',
    status: 'AVAILABLE',
    city: 'Saly',
    daysAgo: 21,
  },
  {
    key: 'portable-ball-machine',
    seller: 'aissatou',
    title: 'Portable tennis ball machine — tested',
    description:
      'Portable ball machine with oscillation and adjustable speed, about 2 hours of battery. Includes charger and 150-ball basket.',
    price: 180000,
    category: 'OTHER',
    condition: 'USED',
    status: 'RESERVED',
    city: 'Saly',
    daysAgo: 25,
  },
  {
    key: 'prince-old-racket',
    seller: 'cheikh',
    title: 'Prince Precision racket — withdrawn',
    description:
      'Old Prince racket, withdrawn from sale by the seller. Kept in the seed so the REMOVED status is exercisable.',
    price: 8500,
    category: 'RACKET',
    condition: 'USED',
    status: 'REMOVED',
    city: 'Dakar',
    daysAgo: 28,
  },
];

interface PurchaseRequestSeed {
  productKey: string;
  buyer: SellerSeed['key'];
  status: PurchaseRequestStatus;
  message: string;
  hoursAgo: number;
}

// One PENDING request across sellers, plus an ACCEPTED request for each
// RESERVED product (so both owner and buyer views have data).
const PURCHASE_REQUESTS: PurchaseRequestSeed[] = [
  {
    productKey: 'wilson-pro-staff-97',
    buyer: 'cheikh',
    status: 'PENDING',
    message: 'Hi Moussa, is the racket still available? I can meet in Dakar this weekend.',
    hoursAgo: 5,
  },
  {
    productKey: 'yonex-ezone-98',
    buyer: 'aissatou',
    status: 'ACCEPTED',
    message: 'Interested in the EZONE 98, can I pick it up in Thiès on Saturday?',
    hoursAgo: 96,
  },
  {
    productKey: 'portable-ball-machine',
    buyer: 'cheikh',
    status: 'ACCEPTED',
    message: 'I run a small academy in Mbour, this would be perfect for our juniors.',
    hoursAgo: 240,
  },
];

async function seedMarketplace() {
  const passwordHash = await bcrypt.hash('password123', 10);

  const userIds = {} as Record<SellerSeed['key'], string>;
  const memberSince = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  for (const { key, email, ...profile } of SELLERS) {
    const user = await prisma.user.upsert({
      where: { email },
      update: { ...profile, passwordHash, createdAt: memberSince },
      create: { email, passwordHash, ...profile, createdAt: memberSince },
    });
    userIds[key] = user.id;
  }
  const sellerIds = Object.values(userIds);
  const categoryIds = await seedProductCategories();

  // Wipe + recreate. Purchase requests on these products go with them
  // (onDelete: Cascade); also clear requests the seed users made elsewhere.
  await prisma.purchaseRequest.deleteMany({
    where: { buyerId: { in: sellerIds } },
  });
  await prisma.product.deleteMany({ where: { sellerId: { in: sellerIds } } });

  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;
  const HOUR_MS = 60 * 60 * 1000;
  const productIds: Record<string, string> = {};

  for (const product of PRODUCTS) {
    const createdAt = new Date(now - product.daysAgo * DAY_MS);
    const created = await prisma.product.create({
      data: {
        sellerId: userIds[product.seller],
        title: product.title,
        description: product.description,
        price: product.price,
        categoryId: categoryIds[product.category],
        condition: product.condition,
        status: product.status,
        city: product.city,
        photos: productPhotos(product.key, product.category),
        createdAt,
        updatedAt: createdAt,
      },
      select: { id: true },
    });
    productIds[product.key] = created.id;
  }

  for (const request of PURCHASE_REQUESTS) {
    const createdAt = new Date(now - request.hoursAgo * HOUR_MS);
    await prisma.purchaseRequest.create({
      data: {
        productId: productIds[request.productKey],
        buyerId: userIds[request.buyer],
        status: request.status,
        message: request.message,
        createdAt,
        updatedAt: createdAt,
      },
    });
  }

  const byCategory: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  for (const p of PRODUCTS) {
    byCategory[p.category] = (byCategory[p.category] ?? 0) + 1;
    byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
  }
  console.log(
    `Seeded marketplace: ${SELLERS.length} sellers, ${PRODUCTS.length} products, ${PURCHASE_REQUESTS.length} purchase requests`,
  );
  console.log('  by category:', byCategory);
  console.log('  by status:', byStatus);
}

// ---------------------------------------------------------------------------
// Match history seed: a few demo matches for every user that has none yet,
// so the Play tab isn't empty on a fresh dev database. Idempotent — users who
// already recorded a match are left untouched.
// ---------------------------------------------------------------------------

interface MatchSeedSet {
  me: number;
  opp: number;
  tiebreak?: [number, number];
  superTiebreak?: boolean;
}

interface MatchSeed {
  // Index into the other registered users, or a guest name.
  opponent: { user: number } | { guest: string };
  daysAgo: number;
  sets: MatchSeedSet[];
  winner: 'ME' | 'OPPONENT';
  totalMin: number;
  playMin: number;
  myPoints: number;
  oppPoints: number;
  location: string;
  bestOf?: 3 | 5 | 1;
  finalSet?: FinalSetFormat;
  noAd?: boolean;
  matchType?: 'FRIENDLY' | 'TRAINING';
}

const MATCH_SEEDS: MatchSeed[] = [
  {
    opponent: { user: 0 },
    daysAgo: 2,
    sets: [
      { me: 6, opp: 4 },
      { me: 3, opp: 6 },
      { me: 7, opp: 6, tiebreak: [7, 4] },
    ],
    winner: 'ME',
    totalMin: 168,
    playMin: 84,
    myPoints: 112,
    oppPoints: 104,
    location: 'Stade L.S.S',
  },
  {
    opponent: { guest: 'Coach Ibou' },
    daysAgo: 5,
    sets: [
      { me: 6, opp: 2 },
      { me: 6, opp: 3 },
    ],
    winner: 'ME',
    totalMin: 82,
    playMin: 47,
    myPoints: 64,
    oppPoints: 41,
    location: 'ASAC',
    matchType: 'TRAINING',
  },
  {
    opponent: { user: 1 },
    daysAgo: 9,
    sets: [
      { me: 4, opp: 6 },
      { me: 6, opp: 7, tiebreak: [5, 7] },
    ],
    winner: 'OPPONENT',
    totalMin: 131,
    playMin: 73,
    myPoints: 79,
    oppPoints: 91,
    location: 'Olympic Club',
  },
  {
    opponent: { guest: 'Fatou' },
    daysAgo: 14,
    sets: [
      { me: 6, opp: 3 },
      { me: 2, opp: 6 },
      { me: 1, opp: 0, tiebreak: [10, 6], superTiebreak: true },
    ],
    winner: 'ME',
    finalSet: FinalSetFormat.SUPER_TIEBREAK,
    noAd: true,
    totalMin: 110,
    playMin: 61,
    myPoints: 88,
    oppPoints: 74,
    location: 'T.C.D',
  },
  {
    opponent: { user: 2 },
    daysAgo: 21,
    sets: [
      { me: 3, opp: 6 },
      { me: 4, opp: 6 },
    ],
    winner: 'OPPONENT',
    totalMin: 95,
    playMin: 52,
    myPoints: 55,
    oppPoints: 72,
    location: 'King Fahd',
  },
];

async function seedMatches() {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  const DAY_MS = 24 * 60 * 60 * 1000;
  const MIN_MS = 60 * 1000;
  let created = 0;

  for (const user of users) {
    const already = await prisma.match.count({ where: { player1Id: user.id } });
    if (already > 0) continue;

    const others = users.filter((u) => u.id !== user.id);
    if (others.length === 0) continue;

    for (const seed of MATCH_SEEDS) {
      const opponentUser =
        'user' in seed.opponent
          ? others[seed.opponent.user % others.length]
          : null;
      const startedAt = new Date(Date.now() - seed.daysAgo * DAY_MS);
      const endedAt = new Date(startedAt.getTime() + seed.totalMin * MIN_MS);

      await prisma.match.create({
        data: {
          player1Id: user.id,
          player2Id: opponentUser?.id ?? null,
          player2Name:
            'guest' in seed.opponent ? seed.opponent.guest : null,
          location: seed.location,
          playedAt: startedAt,
          startedAt,
          endedAt,
          totalSeconds: seed.totalMin * 60,
          playSeconds: seed.playMin * 60,
          player1Points: seed.myPoints,
          player2Points: seed.oppPoints,
          bestOf: seed.bestOf ?? 3,
          noAd: seed.noAd ?? false,
          finalSet: seed.finalSet ?? FinalSetFormat.TIEBREAK,
          matchType: seed.matchType ?? 'FRIENDLY',
          status: MatchStatus.COMPLETED,
          winnerSide:
            seed.winner === 'ME' ? PlayerSide.PLAYER1 : PlayerSide.PLAYER2,
          winnerId:
            seed.winner === 'ME' ? user.id : (opponentUser?.id ?? null),
          sets: {
            create: seed.sets.map((set, index) => ({
              setNumber: index + 1,
              player1Games: set.me,
              player2Games: set.opp,
              isTiebreak: !!set.tiebreak,
              isSuperTiebreak: set.superTiebreak ?? false,
              tiebreakPlayer1Points: set.tiebreak?.[0] ?? null,
              tiebreakPlayer2Points: set.tiebreak?.[1] ?? null,
            })),
          },
        },
      });
      created++;
    }
  }
  console.log(`Seeded matches: ${created} demo matches`);
}

// ---------------------------------------------------------------------------
// Home tab seed: amateur tournaments, expiring stories and a few notifications.
// Dates are relative to "now" so the demo always has a live event, upcoming
// ones and a finished one. Idempotent: tournaments are upserted by name,
// stories are recreated, notifications are only added to users who have none.
// ---------------------------------------------------------------------------

interface CompetitionSeed {
  key: string;
  name: string;
  category: string;
  description: string;
  surface: Surface;
  format: CompetitionFormat;
  status: CompetitionStatus;
  // Days from now; negative = already started.
  startsInDays: number;
  lengthDays: number;
  featured?: boolean;
  maxParticipants: number;
  entryFee: number;
  clubIndex: number;
}

const COMPETITION_SEEDS: CompetitionSeed[] = [
  {
    key: 'teranga',
    name: 'Teranga Cup',
    category: 'Open · Singles',
    description:
      'The biggest amateur weekend of the season. Single elimination, best of three sets, a proper draw sheet and a trophy ceremony under the floodlights.',
    surface: Surface.HARD,
    format: CompetitionFormat.SINGLE_ELIMINATION,
    status: CompetitionStatus.ONGOING,
    startsInDays: -2,
    lengthDays: 5,
    featured: true,
    maxParticipants: 32,
    entryFee: 15000,
    clubIndex: 0,
  },
  {
    key: 'dakar-open',
    name: 'Dakar Open Amateur',
    category: 'Men & Women · 3.0–4.5',
    description:
      'Two draws, one weekend. Play at your level, meet players from every club in the city and take home points for the season ranking.',
    surface: Surface.HARD,
    format: CompetitionFormat.SINGLE_ELIMINATION,
    status: CompetitionStatus.UPCOMING,
    startsInDays: 6,
    lengthDays: 3,
    featured: true,
    maxParticipants: 64,
    entryFee: 20000,
    clubIndex: 1,
  },
  {
    key: 'clay-classic',
    name: 'Petite-Côte Clay Classic',
    category: 'Intermediate · Singles',
    description:
      'Long rallies, sliding and sea air. A round-robin so everybody plays at least three matches.',
    surface: Surface.CLAY,
    format: CompetitionFormat.ROUND_ROBIN,
    status: CompetitionStatus.UPCOMING,
    startsInDays: 19,
    lengthDays: 2,
    maxParticipants: 16,
    entryFee: 10000,
    clubIndex: 2,
  },
  {
    key: 'night-series',
    name: 'Corniche Night Series',
    category: 'All levels · Singles',
    description:
      'After-work matches under the lights. Short format, relaxed vibe, big atmosphere.',
    surface: Surface.HARD,
    format: CompetitionFormat.ROUND_ROBIN,
    status: CompetitionStatus.UPCOMING,
    startsInDays: 33,
    lengthDays: 4,
    maxParticipants: 24,
    entryFee: 8000,
    clubIndex: 0,
  },
  {
    key: 'masters-45',
    name: 'Seniors 45+ Masters',
    category: 'Seniors 45+ · Singles',
    description:
      'Experience beats power. A friendly but fiercely fought event for players over 45.',
    surface: Surface.HARD,
    format: CompetitionFormat.SINGLE_ELIMINATION,
    status: CompetitionStatus.UPCOMING,
    startsInDays: 52,
    lengthDays: 2,
    maxParticipants: 16,
    entryFee: 12000,
    clubIndex: 1,
  },
  {
    key: 'rentree',
    name: 'Trophée de la Rentrée',
    category: 'Open · Singles',
    description:
      'The season opener, played last month — see who lifted the trophy.',
    surface: Surface.HARD,
    format: CompetitionFormat.SINGLE_ELIMINATION,
    status: CompetitionStatus.COMPLETED,
    startsInDays: -30,
    lengthDays: 3,
    maxParticipants: 32,
    entryFee: 10000,
    clubIndex: 2,
  },
];

interface StorySlideSeed {
  photo: number; // index into TENNIS_PHOTO_IDS
  headline: string;
  body?: string;
  ctaLabel?: string;
  route?: string;
}

interface StorySeed {
  title: string;
  kind: 'TOURNAMENT' | 'NEWS' | 'TIP' | 'CLUB';
  coverPhoto: number;
  hoursAgo: number;
  slides: StorySlideSeed[];
}

function storyUrl(photo: number): string {
  return unsplashUrl(TENNIS_PHOTO_IDS[photo % TENNIS_PHOTO_IDS.length], 900, 1600);
}

async function seedHome() {
  const HOUR_MS = 60 * 60 * 1000;
  const DAY_MS = 24 * HOUR_MS;
  const clubList = await prisma.club.findMany({
    orderBy: { name: 'asc' },
    include: { city: true },
  });
  const competitionIds: Record<string, string> = {};

  for (const seed of COMPETITION_SEEDS) {
    const club = clubList.length ? clubList[seed.clubIndex % clubList.length] : null;
    const startDate = new Date(Date.now() + seed.startsInDays * DAY_MS);
    const endDate = new Date(startDate.getTime() + seed.lengthDays * DAY_MS);
    const data = {
      name: seed.name,
      category: seed.category,
      description: seed.description,
      translations: fr(COMPETITION_TRANSLATIONS[seed.key]),
      surface: seed.surface,
      format: seed.format,
      status: seed.status,
      featured: seed.featured ?? false,
      maxParticipants: seed.maxParticipants,
      entryFee: seed.entryFee,
      startDate,
      endDate,
      clubId: club?.id ?? null,
      location: club ? `${club.name}, ${club.city.name}` : null,
      bannerUrl: unsplashUrl(
        TENNIS_PHOTO_IDS[hashIndex(`competition-${seed.key}`, TENNIS_PHOTO_IDS.length)],
        1200,
        800,
      ),
    };
    const existing = await prisma.competition.findFirst({ where: { name: seed.name } });
    const competition = existing
      ? await prisma.competition.update({ where: { id: existing.id }, data })
      : await prisma.competition.create({ data });
    competitionIds[seed.key] = competition.id;
  }

  // A handful of registered players so the cards aren't empty.
  const users = await prisma.user.findMany({ orderBy: { createdAt: 'asc' }, select: { id: true } });
  const registrations: [string, number][] = [
    ['teranga', 6],
    ['dakar-open', 5],
    ['clay-classic', 3],
    ['night-series', 2],
    ['rentree', 6],
  ];
  for (const [key, count] of registrations) {
    await prisma.competitionParticipant.createMany({
      data: users.slice(0, count).map((u, i) => ({
        competitionId: competitionIds[key],
        userId: u.id,
        seed: i + 1,
      })),
      skipDuplicates: true,
    });
  }

  const stories: StorySeed[] = [
    {
      title: 'Teranga Cup',
      kind: 'TOURNAMENT',
      coverPhoto: 4,
      hoursAgo: 3,
      slides: [
        { photo: 4, headline: 'The Teranga Cup is live', body: 'Round of 16 is underway at the club.' },
        { photo: 5, headline: 'Follow the draw', body: 'Who plays who, and when.', ctaLabel: 'See the tournament', route: `/tournaments/${competitionIds['teranga']}` },
      ],
    },
    {
      title: 'Dakar Open',
      kind: 'TOURNAMENT',
      coverPhoto: 6,
      hoursAgo: 6,
      slides: [
        { photo: 6, headline: 'Registration is open', body: 'Dakar Open Amateur starts in a week.' },
        { photo: 7, headline: 'Two draws, 64 players', body: 'Play at your level and earn season points.' },
        { photo: 8, headline: 'Grab your spot', ctaLabel: 'Register now', route: `/tournaments/${competitionIds['dakar-open']}` },
      ],
    },
    {
      title: 'Serve tips',
      kind: 'TIP',
      coverPhoto: 1,
      hoursAgo: 20,
      slides: [
        { photo: 1, headline: 'Toss it higher', body: 'A consistent toss is 80% of a good serve.' },
        { photo: 9, headline: 'Bend your knees', body: 'Power comes from the legs, not the arm.' },
        { photo: 0, headline: 'Finish the swing', body: 'Let the racket finish across your body.' },
      ],
    },
    {
      title: 'Book a court',
      kind: 'CLUB',
      coverPhoto: 3,
      hoursAgo: 30,
      slides: [
        { photo: 3, headline: 'Evening slots are filling fast', body: 'Book your court before 6 pm to be safe.', ctaLabel: 'Find a court', route: '/club' },
      ],
    },
    {
      title: 'Season race',
      kind: 'NEWS',
      coverPhoto: 2,
      hoursAgo: 44,
      slides: [
        { photo: 2, headline: 'Every match counts', body: 'Official wins earn 100 points, friendlies 50.' },
        { photo: 5, headline: 'Climb the ladder', body: 'From Rookie to Champion — check your progress.', ctaLabel: 'My season', route: '/profile' },
      ],
    },
    {
      title: 'Gear deals',
      kind: 'NEWS',
      coverPhoto: 8,
      hoursAgo: 60,
      slides: [
        { photo: 8, headline: 'Fresh rackets on the market', body: 'Second-hand gear from players near you.', ctaLabel: 'Browse the market', route: '/marketplace' },
      ],
    },
  ];
  await prisma.story.deleteMany({});
  for (const story of stories) {
    const publishedAt = new Date(Date.now() - story.hoursAgo * HOUR_MS);
    await prisma.story.create({
      data: {
        title: story.title,
        kind: story.kind,
        coverUrl: storyUrl(story.coverPhoto),
        publishedAt,
        expiresAt: new Date(Date.now() + 2 * DAY_MS),
        translations: fr(STORY_TRANSLATIONS[story.title]),
        slides: story.slides.map(({ photo, ...slide }) => ({
          ...slide,
          imageUrl: storyUrl(photo),
        })),
      },
    });
  }

  let notified = 0;
  for (const user of users) {
    if ((await prisma.notification.count({ where: { userId: user.id } })) > 0) continue;
    const now = Date.now();
    await prisma.notification.createMany({
      data: [
        { type: NotificationType.TOURNAMENT, messageKey: 'registrationOpen', title: 'Registration is open', body: 'Dakar Open Amateur starts in a week — grab your spot.', data: { route: `/tournaments/${competitionIds['dakar-open']}` }, createdAt: new Date(now - 1 * HOUR_MS) },
        { type: NotificationType.MATCH, messageKey: 'niceWin', title: 'Nice win!', body: 'Your last match earned you season points. See where you stand.', data: { route: '/profile' }, createdAt: new Date(now - 5 * HOUR_MS) },
        { type: NotificationType.BOOKING, messageKey: 'courtReminder', title: 'Court reminder', body: 'Bookings are easier to keep with a partner — invite someone.', data: { route: '/club/bookings' }, createdAt: new Date(now - 26 * HOUR_MS) },
        { type: NotificationType.MARKETPLACE, messageKey: 'newGear', title: 'New gear near you', body: 'Fresh rackets and shoes were just listed in the market.', data: { route: '/marketplace' }, read: true, createdAt: new Date(now - 3 * DAY_MS) },
        { type: NotificationType.SYSTEM, messageKey: 'welcome', title: 'Welcome to the club', body: 'Book courts, score your matches and climb the season ranking.', read: true, createdAt: new Date(now - 6 * DAY_MS) },
      ].map((n) => ({ ...n, userId: user.id })),
    });
    notified++;
  }
  console.log(`Seeded home: ${COMPETITION_SEEDS.length} tournaments, ${stories.length} stories, notifications for ${notified} users`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
