import { createHash, randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Single-elimination draw generation, kept pure (no Nest/Prisma) and
// reproducible: the same entries and the same stored `seed` always give the
// same draw, so a contested draw can be replayed and checked.
//
// Rules:
// - the draw size is the next power of two (2 … 128) holding every entry and
//   reserved place;
// - seeds sit on the standard seed lines: 1 at the top, 2 at the bottom,
//   3–4 drawn by lot between the two remaining quarter lines, 5–8 between the
//   eighth lines, and so on;
// - byes go to the strongest seed lines first (seed 1 gets the first bye);
// - reserved places (qualifier "Q" places, empty places) are drawn like
//   unseeded players but never opposite a bye, where they would advance
//   without anyone to play;
// - everyone else is shuffled into the remaining lines.
// ---------------------------------------------------------------------------

export const MIN_DRAW = 2;
export const MAX_DRAW = 128;

export type SlotKind = 'ENTRY' | 'BYE' | 'QUALIFIER' | 'EMPTY';

export interface DrawEntry {
  participantId: string;
  /** Seed from the entries list; only the first `seedCount` count. */
  seed: number | null;
}

export interface Placeholder {
  kind: 'QUALIFIER' | 'EMPTY';
  sourceEventId?: string | null;
}

export interface PlannedSlot {
  position: number;
  kind: SlotKind;
  participantId: string | null;
  seed: number | null;
  label: string | null;
  sourceEventId: string | null;
}

export class DrawError extends Error {
  constructor(readonly code: 'TOO_FEW' | 'TOO_MANY' | 'SIZE_TOO_SMALL') {
    super(code);
  }
}

/** Smallest power of two ≥ lines (at least 2). */
export function drawSizeFor(lines: number): number {
  if (lines < MIN_DRAW) throw new DrawError('TOO_FEW');
  if (lines > MAX_DRAW) throw new DrawError('TOO_MANY');
  let size = MIN_DRAW;
  while (size < lines) size *= 2;
  return size;
}

/**
 * The canonical seed line of each position: seedingOrder(8) is
 * [1, 8, 5, 4, 3, 6, 7, 2] — 1 on top, 2 at the bottom, so 1 and 2 can only
 * meet in the final, 1–4 in the semi-finals, and so on.
 */
export function seedingOrder(size: number): number[] {
  let order = [1];
  while (order.length < size) {
    const n = order.length * 2;
    order = order.flatMap((line, i) => (i % 2 === 0 ? [line, n + 1 - line] : [n + 1 - line, line]));
  }
  return order;
}

/** A new random seed to store with a generated draw. */
export const newDrawSeed = () => randomBytes(8).toString('hex');

/** Deterministic PRNG (mulberry32) keyed by a string. */
export function seededRandom(seed: string): () => number {
  let state = createHash('sha256').update(seed).digest().readUInt32LE(0);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Seed groups drawn by lot together: [1], [2], [3,4], [5..8], [9..16]… */
const seedGroups = (count: number): number[][] => {
  const starts = [1, 2, 3, 5, 9, 17, 33, 65];
  return starts
    .map((from, i) => {
      const to = Math.min(count, (starts[i + 1] ?? 129) - 1);
      return Array.from({ length: Math.max(0, to - from + 1) }, (_, k) => from + k);
    })
    .filter((group) => group.length > 0);
};

export interface PlanInput {
  entries: readonly DrawEntry[];
  placeholders?: readonly Placeholder[];
  seedCount: number;
  seed: string;
  /** Force a bigger draw than needed (e.g. a 32 draw for 20 players). */
  size?: number;
}

export function planDraw({ entries, placeholders = [], seedCount, seed, size: forced }: PlanInput): PlannedSlot[] {
  const lines = entries.length + placeholders.length;
  const size = drawSizeFor(lines);
  if (forced !== undefined && forced < size) throw new DrawError('SIZE_TOO_SMALL');
  const drawSize = forced ?? size;
  if (drawSize > MAX_DRAW) throw new DrawError('TOO_MANY');
  const random = seededRandom(seed);
  const order = seedingOrder(drawSize);
  const positionOfLine = new Map(order.map((line, position) => [line, position]));
  const slots: (PlannedSlot | null)[] = Array.from({ length: drawSize }, () => null);
  const put = (position: number, slot: Omit<PlannedSlot, 'position'>) => (slots[position] = { position, ...slot });

  // Seeds: best `seedCount` seeded entries, at most half the draw.
  const seeded = entries
    .filter((e) => e.seed !== null)
    .sort((a, b) => a.seed! - b.seed!)
    .slice(0, Math.min(seedCount, drawSize / 2));
  const seededIds = new Set(seeded.map((e) => e.participantId));
  for (const group of seedGroups(seeded.length)) {
    const positions = shuffle(
      group.map((line) => positionOfLine.get(line)!),
      random,
    );
    group.forEach((line, i) => {
      const entry = seeded[line - 1];
      put(positions[i], { kind: 'ENTRY', participantId: entry.participantId, seed: line, label: null, sourceEventId: null });
    });
  }

  // Byes, opposite the strongest lines first.
  const byes = drawSize - lines;
  const byeReceivers = new Set<number>();
  for (let line = 1; line <= byes; line++) {
    const position = positionOfLine.get(line)!;
    byeReceivers.add(position);
    put(position ^ 1, { kind: 'BYE', participantId: null, seed: null, label: null, sourceEventId: null });
  }

  // Reserved places avoid bye lines; then everyone else.
  const free = slots.flatMap((slot, position) => (slot ? [] : [position]));
  const open = shuffle(free.filter((p) => !byeReceivers.has(p)), random);
  const facingBye = shuffle(free.filter((p) => byeReceivers.has(p)), random);
  const placeholderPositions = open.splice(0, placeholders.length);
  // Not enough lines away from byes (tiny draws): take what's left.
  while (placeholderPositions.length < placeholders.length) placeholderPositions.push(facingBye.pop()!);
  const orderedPlaceholders = placeholderPositions.sort((a, b) => a - b);
  placeholders.forEach((placeholder, i) =>
    put(orderedPlaceholders[i], {
      kind: placeholder.kind,
      participantId: null,
      seed: null,
      label: null,
      sourceEventId: placeholder.sourceEventId ?? null,
    }),
  );
  const rest = [...facingBye, ...open];
  const unseeded = shuffle(
    entries.filter((e) => !seededIds.has(e.participantId)),
    random,
  );
  unseeded.forEach((entry, i) =>
    put(rest[i], { kind: 'ENTRY', participantId: entry.participantId, seed: null, label: null, sourceEventId: null }),
  );

  return labelQualifiers(slots as PlannedSlot[]);
}

/** Qualifier places are called Q1, Q2… from the top of the draw. */
export function labelQualifiers<T extends { kind: SlotKind; label: string | null }>(slots: T[]): T[] {
  let q = 0;
  return slots.map((slot) => (slot.kind === 'QUALIFIER' ? { ...slot, label: `Q${++q}` } : slot));
}

// ---------------------------------------------------------------------------
// Bracket shape
// ---------------------------------------------------------------------------

export const roundCount = (size: number) => Math.log2(size);

/** Stored English round names; the UI words them itself. */
export function roundName(round: number, rounds: number): string {
  const remaining = rounds - round;
  if (remaining === 0) return 'Final';
  if (remaining === 1) return 'Semi-finals';
  if (remaining === 2) return 'Quarter-finals';
  return `Round of ${2 ** (remaining + 1)}`;
}

/** Where the winner of match `position` of a round goes. */
export const nextOf = (position: number) => ({ position: Math.floor(position / 2), slot: (position % 2) + 1 });

export interface FirstRoundSide {
  kind: SlotKind;
  participantId: string | null;
}

/**
 * State of a first-round match from its two draw places: a bye lets the
 * other entry through; an unfilled place keeps the match waiting.
 */
export function firstRoundState(a: FirstRoundSide, b: FirstRoundSide): { status: 'PENDING' | 'READY' | 'BYE'; winnerId: string | null } {
  if (a.kind === 'BYE' && b.kind === 'ENTRY') return { status: 'BYE', winnerId: b.participantId };
  if (b.kind === 'BYE' && a.kind === 'ENTRY') return { status: 'BYE', winnerId: a.participantId };
  if (a.kind === 'ENTRY' && b.kind === 'ENTRY') return { status: 'READY', winnerId: null };
  return { status: 'PENDING', winnerId: null };
}
