import { BookingStatus } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BookingsService } from '../bookings/bookings.service.js';
import { MatchesService } from '../matches/matches.service.js';
import { PurchaseRequestsService } from '../marketplace/purchase-requests.service.js';

// These check that the feature services raise the right notifications; the
// notification text itself is covered in notifications.service.spec.ts.

const notifications = { notify: vi.fn().mockResolvedValue(undefined) };
beforeEach(() => notifications.notify.mockClear());

const inHours = (h: number) => new Date(Date.now() + h * 3_600_000);

describe('bookings', () => {
  const court = { id: 'court1', clubId: 'club1', pricePerHour: 20 };
  const booked = (
    start: Date,
    status: BookingStatus = BookingStatus.CONFIRMED,
  ) => ({
    id: 'b1',
    userId: 'u1',
    startTime: start,
    endTime: new Date(start.getTime() + 3_600_000),
    status,
    court: { name: 'Court 1', club: { name: 'Dakar TC' } },
  });

  it('confirms a new booking to the player who made it', async () => {
    const start = inHours(24);
    const prisma = {
      court: { findUnique: vi.fn().mockResolvedValue(court) },
      booking: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(booked(start)),
      },
    };
    const service = new BookingsService(prisma as never, notifications as never);

    await service.create('u1', {
      courtId: 'court1',
      startTime: start.toISOString(),
      endTime: new Date(start.getTime() + 3_600_000).toISOString(),
    });

    expect(notifications.notify).toHaveBeenCalledTimes(1);
    expect(notifications.notify).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ type: 'BOOKING', title: 'Court booked' }),
    );
  });

  it('does not notify when the court is already taken', async () => {
    const start = inHours(24);
    const prisma = {
      court: { findUnique: vi.fn().mockResolvedValue(court) },
      booking: { findFirst: vi.fn().mockResolvedValue({ id: 'other' }) },
    };
    const service = new BookingsService(prisma as never, notifications as never);

    await expect(
      service.create('u1', {
        courtId: 'court1',
        startTime: start.toISOString(),
        endTime: new Date(start.getTime() + 3_600_000).toISOString(),
      }),
    ).rejects.toThrow();
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('announces a cancellation once, not on a repeat cancel', async () => {
    const start = inHours(24);
    const prisma = {
      booking: {
        findUnique: vi.fn().mockResolvedValue(booked(start)),
        update: vi.fn().mockResolvedValue(booked(start, BookingStatus.CANCELLED)),
      },
    };
    const service = new BookingsService(prisma as never, notifications as never);

    await service.cancel('u1', 'b1');
    expect(notifications.notify).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ title: 'Booking cancelled' }),
    );

    notifications.notify.mockClear();
    prisma.booking.findUnique.mockResolvedValue(
      booked(start, BookingStatus.CANCELLED),
    );
    await service.cancel('u1', 'b1');
    expect(notifications.notify).not.toHaveBeenCalled();
  });
});

describe('purchase requests', () => {
  it('tells the seller about a new request', async () => {
    const prisma = {
      product: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'p1',
          sellerId: 'seller',
          status: 'AVAILABLE',
          title: 'Wilson Pro',
        }),
      },
      purchaseRequest: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({
          id: 'r1',
          productId: 'p1',
          status: 'PENDING',
          message: null,
          createdAt: new Date(),
          buyer: { firstname: 'Awa', lastname: 'Diop' },
        }),
      },
    };
    const service = new PurchaseRequestsService(
      prisma as never,
      notifications as never,
    );

    const result = await service.create('buyer', 'p1', {});

    expect(notifications.notify).toHaveBeenCalledWith(
      'seller',
      expect.objectContaining({
        type: 'MARKETPLACE',
        body: 'Awa Diop wants your Wilson Pro.',
      }),
    );
    // The buyer's name is for the notification only; the response is unchanged.
    expect(result).not.toHaveProperty('buyer');
  });

  it('accepting one request declines the rest and tells every buyer', async () => {
    const tx = {
      product: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      purchaseRequest: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findMany: vi
          .fn()
          .mockResolvedValue([{ buyerId: 'loser1' }, { buyerId: 'loser2' }]),
      },
    };
    const prisma = {
      purchaseRequest: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'r1',
          productId: 'p1',
          buyerId: 'winner',
          status: 'PENDING',
          product: { sellerId: 'seller', title: 'Wilson Pro' },
        }),
        // The final re-read of the accepted request for the response.
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: 'r1',
          status: 'ACCEPTED',
          message: null,
          createdAt: new Date(),
          buyer: { id: 'winner', firstname: 'A', lastname: 'B', msisdn: '1' },
        }),
      },
      $transaction: vi.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    const service = new PurchaseRequestsService(
      prisma as never,
      notifications as never,
    );

    await service.respond('seller', 'r1', { status: 'ACCEPTED' } as never);

    const sent = notifications.notify.mock.calls.map(
      ([userId, n]) => `${userId}:${n.title}`,
    );
    expect(sent).toEqual([
      'winner:Request accepted',
      'loser1:Request declined',
      'loser2:Request declined',
    ]);
  });
});

describe('matches', () => {
  const dto = (opponent: { opponentUserId?: string; opponentName?: string }) =>
    ({
      ...opponent,
      matchType: 'FRIENDLY',
      bestOf: 3,
      noAd: false,
      finalSet: 'TIEBREAK',
      status: 'COMPLETED',
      winner: 'ME',
      sets: [
        { me: 6, opp: 3 },
        { me: 6, opp: 4 },
      ],
      startedAt: '2026-09-21T10:00:00Z',
      endedAt: '2026-09-21T11:00:00Z',
      totalSeconds: 3600,
      playSeconds: 1800,
      myPoints: 50,
      oppPoints: 40,
    }) as never;

  const created = (player2Id: string | null) => ({
    id: 'm1',
    player1Id: 'me',
    player2Id,
    player2Name: player2Id ? null : 'Guest Gary',
    player1: { id: 'me', firstname: 'Awa', lastname: 'Diop' },
    player2: player2Id
      ? { id: player2Id, firstname: 'Omar', lastname: 'Fall' }
      : null,
    status: 'COMPLETED',
    matchType: 'FRIENDLY',
    bestOf: 3,
    noAd: false,
    finalSet: 'TIEBREAK',
    playedAt: new Date(),
    winnerSide: 'PLAYER1',
    sets: [
      {
        setNumber: 1,
        player1Games: 6,
        player2Games: 3,
        isTiebreak: false,
        isSuperTiebreak: false,
        tiebreakPlayer1Points: null,
        tiebreakPlayer2Points: null,
      },
    ],
  });

  const build = (player2Id: string | null) => {
    const prisma = {
      user: { findUnique: vi.fn().mockResolvedValue({ id: player2Id }) },
      match: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(created(player2Id)),
      },
    };
    return new MatchesService(prisma as never, notifications as never);
  };

  it('tells a registered opponent, from their side of the score', async () => {
    await build('opp').create('me', dto({ opponentUserId: 'opp' }));

    expect(notifications.notify).toHaveBeenCalledTimes(1);
    const [userId, note] = notifications.notify.mock.calls[0];
    expect(userId).toBe('opp');
    expect(note.type).toBe('MATCH');
    expect(note.body).toBe('Awa Diop recorded a match with you. You lost 3-6.');
    expect(note.route).toBe('/play/match/m1');
  });

  it('stays quiet for a guest opponent', async () => {
    await build(null).create('me', dto({ opponentName: 'Guest Gary' }));
    expect(notifications.notify).not.toHaveBeenCalled();
  });
});
