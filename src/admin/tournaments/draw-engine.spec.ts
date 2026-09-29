import { describe, expect, it } from 'vitest';
import {
  drawSizeFor,
  firstRoundState,
  nextOf,
  planDraw,
  roundName,
  seededRandom,
  seedingOrder,
  type DrawEntry,
  type PlannedSlot,
} from './draw-engine.js';

const entries = (count: number, seeds = 0): DrawEntry[] =>
  Array.from({ length: count }, (_, i) => ({ participantId: `p${i + 1}`, seed: i < seeds ? i + 1 : null }));
const at = (slots: PlannedSlot[], participantId: string) => slots.find((s) => s.participantId === participantId)!.position;
const opponent = (slots: PlannedSlot[], position: number) => slots[position ^ 1];

describe('draw size and seed lines', () => {
  it('uses the next power of two, 2 to 128', () => {
    expect(drawSizeFor(2)).toBe(2);
    expect(drawSizeFor(5)).toBe(8);
    expect(drawSizeFor(33)).toBe(64);
    expect(drawSizeFor(128)).toBe(128);
    expect(() => drawSizeFor(1)).toThrow('TOO_FEW');
    expect(() => drawSizeFor(129)).toThrow('TOO_MANY');
  });

  it('keeps top seeds apart until the late rounds', () => {
    expect(seedingOrder(8)).toEqual([1, 8, 5, 4, 3, 6, 7, 2]);
    const order = seedingOrder(128);
    expect(order[0]).toBe(1);
    expect(order[127]).toBe(2);
    expect(new Set(order).size).toBe(128);
  });

  it('is reproducible from the stored seed', () => {
    const a = planDraw({ entries: entries(20, 4), seedCount: 4, seed: 'abc' });
    const b = planDraw({ entries: entries(20, 4), seedCount: 4, seed: 'abc' });
    const c = planDraw({ entries: entries(20, 4), seedCount: 4, seed: 'abd' });
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(seededRandom('x')()).toBe(seededRandom('x')());
  });
});

describe('planDraw', () => {
  it('places seeds 1 and 2 at the ends and 3–4 in the other quarters', () => {
    for (const seed of ['s1', 's2', 's3', 's4', 's5']) {
      const slots = planDraw({ entries: entries(16, 4), seedCount: 4, seed });
      expect(at(slots, 'p1')).toBe(0);
      expect(at(slots, 'p2')).toBe(15);
      const quarters = ['p1', 'p2', 'p3', 'p4'].map((p) => Math.floor(at(slots, p) / 4));
      expect(new Set(quarters).size).toBe(4);
    }
  });

  it('gives byes to the top seeds first', () => {
    const slots = planDraw({ entries: entries(13, 4), seedCount: 4, seed: 'byes' });
    expect(slots).toHaveLength(16);
    expect(slots.filter((s) => s.kind === 'BYE')).toHaveLength(3);
    for (const p of ['p1', 'p2', 'p3']) expect(opponent(slots, at(slots, p)).kind).toBe('BYE');
    expect(opponent(slots, at(slots, 'p4')).kind).toBe('ENTRY');
  });

  it('never pairs two byes and places every entry once', () => {
    for (let n = 2; n <= 128; n += 7) {
      const slots = planDraw({ entries: entries(n, Math.min(8, n)), seedCount: 8, seed: `n${n}` });
      for (let p = 0; p < slots.length; p += 2) {
        expect(slots[p].kind === 'BYE' && slots[p + 1].kind === 'BYE').toBe(false);
      }
      const placed = slots.filter((s) => s.participantId).map((s) => s.participantId);
      expect(new Set(placed).size).toBe(n);
    }
  });

  it('reserves qualifier and empty places away from byes, labelled from the top', () => {
    const slots = planDraw({
      entries: entries(9, 2),
      placeholders: [{ kind: 'QUALIFIER', sourceEventId: 'low' }, { kind: 'QUALIFIER', sourceEventId: 'low' }, { kind: 'EMPTY' }],
      seedCount: 2,
      seed: 'q',
    });
    const reserved = slots.filter((s) => s.kind === 'QUALIFIER' || s.kind === 'EMPTY');
    expect(reserved).toHaveLength(3);
    for (const slot of reserved) expect(opponent(slots, slot.position).kind).not.toBe('BYE');
    const qualifiers = slots.filter((s) => s.kind === 'QUALIFIER');
    expect(qualifiers.map((s) => s.label)).toEqual(['Q1', 'Q2']);
    expect(qualifiers.every((s) => s.sourceEventId === 'low')).toBe(true);
  });

  it('only counts the requested number of seeds', () => {
    const slots = planDraw({ entries: entries(8, 8), seedCount: 2, seed: 'x' });
    expect(slots.filter((s) => s.seed !== null).map((s) => s.seed)).toEqual([1, 2]);
  });

  it('can make a bigger draw than needed, but not a smaller one', () => {
    expect(planDraw({ entries: entries(10), seedCount: 0, seed: 'x', size: 32 })).toHaveLength(32);
    expect(() => planDraw({ entries: entries(10), seedCount: 0, seed: 'x', size: 8 })).toThrow('SIZE_TOO_SMALL');
  });
});

describe('bracket shape', () => {
  it('names rounds from the final backwards', () => {
    expect([1, 2, 3, 4, 5].map((r) => roundName(r, 5))).toEqual(['Round of 32', 'Round of 16', 'Quarter-finals', 'Semi-finals', 'Final']);
  });

  it('sends winners to the right side of the next match', () => {
    expect(nextOf(0)).toEqual({ position: 0, slot: 1 });
    expect(nextOf(1)).toEqual({ position: 0, slot: 2 });
    expect(nextOf(6)).toEqual({ position: 3, slot: 1 });
  });

  it('lets an entry through a bye and waits for places to fill', () => {
    const entry = { kind: 'ENTRY' as const, participantId: 'a' };
    expect(firstRoundState(entry, { kind: 'BYE', participantId: null })).toEqual({ status: 'BYE', winnerId: 'a' });
    expect(firstRoundState(entry, { kind: 'QUALIFIER', participantId: null })).toEqual({ status: 'PENDING', winnerId: null });
    expect(firstRoundState(entry, { kind: 'ENTRY', participantId: 'b' })).toEqual({ status: 'READY', winnerId: null });
  });
});
