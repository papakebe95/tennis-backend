import { describe, expect, it } from 'vitest';
import { nextAffiliationStatus } from '../admin/organizations/organizations.service.js';
import {
  fitsWindows,
  hourlySlots,
  HoursError,
  parseOpeningHours,
  toStoredHours,
  validateWindows,
  windowsFor,
} from './opening-hours.js';

const monday = new Date('2026-10-05T00:00:00Z');
const sunday = new Date('2026-10-04T00:00:00Z');

describe('parseOpeningHours', () => {
  it('reads the legacy range-key format', () => {
    const week = parseOpeningHours({ 'mon-fri': '07:00-22:00', 'sat-sun': '08:00-20:00' })!;
    expect(week.wed).toEqual([{ opensAt: '07:00', closesAt: '22:00' }]);
    expect(week.sun).toEqual([{ opensAt: '08:00', closesAt: '20:00' }]);
  });

  it('reads the canonical format, with several windows and closed days', () => {
    const week = parseOpeningHours({ mon: ['07:00-12:00', '14:00-22:00'], sun: [], tue: null })!;
    expect(week.mon).toHaveLength(2);
    expect(week.sun).toEqual([]);
    expect(week.tue).toEqual([]);
    expect(toStoredHours(week).mon).toEqual(['07:00-12:00', '14:00-22:00']);
  });

  it('ignores junk and returns null when nothing is set', () => {
    expect(parseOpeningHours(null)).toBeNull();
    expect(parseOpeningHours({ holidays: '10:00-12:00' })).toBeNull();
    expect(parseOpeningHours({ mon: 'soon' })!.mon).toEqual([]);
  });
});

describe('validateWindows', () => {
  it('sorts valid windows', () => {
    expect(validateWindows([{ opensAt: '14:00', closesAt: '22:00' }, { opensAt: '07:00', closesAt: '12:00' }])[0].opensAt).toBe('07:00');
  });

  it.each([
    [[{ opensAt: '7h', closesAt: '22:00' }], 'invalidTime'],
    [[{ opensAt: '22:00', closesAt: '07:00' }], 'closesBeforeOpens'],
    [[{ opensAt: '07:00', closesAt: '13:00' }, { opensAt: '12:00', closesAt: '20:00' }], 'overlap'],
  ])('rejects %j (%s)', (windows, reason) => {
    expect(() => validateWindows(windows)).toThrow(new HoursError(reason as HoursError['reason']));
  });
});

describe('windowsFor', () => {
  const club = parseOpeningHours({ mon: ['07:00-22:00'], sun: [] });

  it("uses the court's own windows when it has any (other days closed)", () => {
    const court = [{ weekday: 0, opensAt: '17:00', closesAt: '23:00' }];
    expect(windowsFor(monday, court, club)).toEqual([{ opensAt: '17:00', closesAt: '23:00' }]);
    expect(windowsFor(sunday, court, club)).toEqual([]);
  });

  it("falls back to the club's hours, then to 08:00-22:00", () => {
    expect(windowsFor(monday, [], club)).toEqual([{ opensAt: '07:00', closesAt: '22:00' }]);
    expect(windowsFor(sunday, [], club)).toEqual([]);
    expect(windowsFor(monday, [], null)).toEqual([{ opensAt: '08:00', closesAt: '22:00' }]);
  });
});

describe('slots and bookings', () => {
  const windows = [
    { opensAt: '07:00', closesAt: '12:00' },
    { opensAt: '14:30', closesAt: '17:00' },
  ];

  it('makes whole-hour slots that fit each window', () => {
    const starts = hourlySlots(monday, windows).map((s) => s.start.toISOString().slice(11, 16));
    expect(starts).toEqual(['07:00', '08:00', '09:00', '10:00', '11:00', '14:30', '15:30']);
  });

  it('accepts a booking inside one window only', () => {
    const at = (h: string) => new Date(`2026-10-05T${h}:00Z`);
    expect(fitsWindows(at('08:00'), at('10:00'), windows)).toBe(true);
    expect(fitsWindows(at('11:00'), at('15:00'), windows)).toBe(false); // spans the break
    expect(fitsWindows(at('16:30'), at('17:30'), windows)).toBe(false); // past closing
  });
});

describe('nextAffiliationStatus', () => {
  it.each([
    ['PENDING', 'approve', 'ACTIVE'],
    ['SUSPENDED', 'approve', 'ACTIVE'],
    ['ACTIVE', 'suspend', 'SUSPENDED'],
    ['PENDING', 'end', 'ENDED'],
    ['ACTIVE', 'end', 'ENDED'],
  ] as const)('%s + %s → %s', (from, action, to) => {
    expect(nextAffiliationStatus(from, action)).toBe(to);
  });

  it.each([
    ['ACTIVE', 'approve'],
    ['PENDING', 'suspend'],
    ['ENDED', 'approve'],
    ['ENDED', 'end'],
  ] as const)('refuses %s + %s', (from, action) => {
    expect(nextAffiliationStatus(from, action)).toBeNull();
  });
});
