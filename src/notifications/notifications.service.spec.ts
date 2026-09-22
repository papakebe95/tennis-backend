import { NotificationType } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import {
  bookingCancelled,
  bookingConfirmed,
  matchRecorded,
  purchaseRequestAnswered,
  purchaseRequestReceived,
  scoreLine,
  tournamentRegistered,
} from './notification-messages.js';
import { NotificationsService } from './notifications.service.js';

const makeService = (create = vi.fn().mockResolvedValue({})) => {
  const prisma = { notification: { create } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { service: new NotificationsService(prisma as any), create };
};

describe('NotificationsService.notify', () => {
  it('stores the type and wraps the route in `data`', async () => {
    const { service, create } = makeService();
    await service.notify('u1', {
      type: NotificationType.BOOKING,
      title: 'Court booked',
      body: 'Court 1',
      route: '/club/bookings',
    });
    expect(create).toHaveBeenCalledWith({
      data: {
        userId: 'u1',
        type: 'BOOKING',
        title: 'Court booked',
        body: 'Court 1',
        data: { route: '/club/bookings' },
      },
    });
  });

  it('leaves `data` unset when there is no route', async () => {
    const { service, create } = makeService();
    await service.notify('u1', {
      type: NotificationType.SYSTEM,
      title: 'Hi',
      body: 'Welcome',
    });
    expect(create.mock.calls[0][0].data.data).toBeUndefined();
  });

  it('never throws when the write fails', async () => {
    const { service } = makeService(vi.fn().mockRejectedValue(new Error('db down')));
    await expect(
      service.notify('u1', {
        type: NotificationType.SYSTEM,
        title: 't',
        body: 'b',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('notification messages', () => {
  const start = new Date('2026-09-21T18:00:00Z');

  it('speaks booking slots in UTC and opens the bookings list', () => {
    const n = bookingConfirmed({ courtName: 'Court 1', clubName: 'Dakar TC', start });
    expect(n.type).toBe(NotificationType.BOOKING);
    expect(n.body).toContain('Court 1 at Dakar TC');
    expect(n.body).toContain('18:00');
    expect(n.route).toBe('/club/bookings');
    expect(
      bookingCancelled({ courtName: 'Court 1', clubName: 'Dakar TC', start }).title,
    ).toBe('Booking cancelled');
  });

  it('points marketplace notifications at the product', () => {
    expect(purchaseRequestReceived('p1', 'Wilson Pro', 'Awa Diop')).toMatchObject({
      type: NotificationType.MARKETPLACE,
      route: '/marketplace/product/p1',
    });
    expect(purchaseRequestAnswered('p1', 'Wilson Pro', true).title).toBe(
      'Request accepted',
    );
    expect(purchaseRequestAnswered('p1', 'Wilson Pro', false).title).toBe(
      'Request declined',
    );
  });

  it('points a tournament confirmation at the tournament', () => {
    expect(tournamentRegistered('c1', 'Dakar Open')).toMatchObject({
      type: NotificationType.TOURNAMENT,
      route: '/tournaments/c1',
    });
  });

  it('shows a match tiebreak by its points, not its 1-0 games', () => {
    expect(
      scoreLine([
        { me: 6, opp: 4, superTiebreak: false, tiebreak: null },
        { me: 3, opp: 6, superTiebreak: false, tiebreak: null },
        { me: 1, opp: 0, superTiebreak: true, tiebreak: { me: 10, opp: 7 } },
      ]),
    ).toBe('6-4 3-6 [10-7]');
  });

  it('words a recorded match from the notified player’s side', () => {
    const sets = [{ me: 6, opp: 3, superTiebreak: false, tiebreak: null }];
    const win = matchRecorded('m1', 'Awa Diop', 'WIN', sets);
    expect(win.body).toBe('Awa Diop recorded a match with you. You won 6-3.');
    expect(win.route).toBe('/play/match/m1');
    expect(matchRecorded('m1', 'Awa Diop', 'LOSS', sets).body).toContain('You lost');
    expect(matchRecorded('m1', 'Awa Diop', null, []).body).toBe(
      'Awa Diop recorded a match with you. Unfinished.',
    );
  });
});
