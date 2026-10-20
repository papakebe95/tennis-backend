import { ConflictException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MatchesService } from './matches.service.js';

// A tiny in-memory Prisma: enough of `match` and `user` for the service, with
// plain-equality and OR filters, so confirm/reject really change state.

type Row = Record<string, unknown>;
const USERS: Row[] = [
  { id: 'awa', firstname: 'Awa', lastname: 'Diop' },
  { id: 'moussa', firstname: 'Moussa', lastname: 'Fall' },
  { id: 'ibou', firstname: 'Ibou', lastname: 'Ndiaye' },
  { id: 'fatou', firstname: 'Fatou', lastname: 'Sow' },
];
const user = (id: unknown) => USERS.find((u) => u.id === id) ?? null;

const matches = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([key, value]) =>
    key === 'OR'
      ? (value as Row[]).some((w) => matches(row, w))
      : value instanceof Date
        ? (row[key] as Date)?.getTime() === value.getTime()
        : row[key] === value,
  );

function fakePrisma() {
  const store: Row[] = [];
  const withRelations = (m: Row) => ({
    ...m,
    player1: user(m.player1Id),
    player2: user(m.player2Id),
    recordedBy: user(m.recordedById),
  });
  const match = {
    findFirst: vi.fn(async ({ where }: { where: Row }) => {
      const found = store.find((m) => matches(m, where));
      return found ? withRelations(found) : null;
    }),
    findMany: vi.fn(async ({ where }: { where: Row }) =>
      store.filter((m) => matches(m, where)).map(withRelations),
    ),
    count: vi.fn(async ({ where }: { where: Row }) =>
      store.filter((m) => matches(m, where)).length,
    ),
    create: vi.fn(async ({ data }: { data: Row & { sets: { create: Row[] } } }) => {
      const row: Row = {
        id: `m${store.length + 1}`,
        player1RespondedAt: null,
        player2RespondedAt: null,
        player1RejectReason: null,
        player2RejectReason: null,
        ...data,
        sets: data.sets.create,
      };
      store.push(row);
      return withRelations(row);
    }),
    update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const row = store.find((m) => m.id === where.id)!;
      Object.assign(row, data);
      return withRelations(row);
    }),
  };
  const prisma = {
    match,
    user: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        USERS.filter((u) => where.id.in.includes(u.id as string)),
      ),
    },
    $queryRaw: vi.fn(async () => []),
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
  };
  return { prisma, store };
}

const notifications = { notify: vi.fn().mockResolvedValue(undefined) };

let prisma: ReturnType<typeof fakePrisma>['prisma'];
let store: Row[];
let service: MatchesService;
beforeEach(() => {
  ({ prisma, store } = fakePrisma());
  notifications.notify.mockClear();
  service = new MatchesService(prisma as never, notifications as never);
});

let clock = 0;
const dto = (over: Record<string, unknown>) =>
  ({
    matchType: 'FRIENDLY',
    bestOf: 3,
    noAd: false,
    finalSet: 'TIEBREAK',
    status: 'COMPLETED',
    winner: 'ME',
    sets: [
      { me: 6, opp: 4 },
      { me: 6, opp: 3 },
    ],
    startedAt: new Date(Date.UTC(2026, 9, 1, 10, clock++)).toISOString(),
    endedAt: new Date(Date.UTC(2026, 9, 1, 12)).toISOString(),
    totalSeconds: 3600,
    playSeconds: 1800,
    myPoints: 60,
    oppPoints: 40,
    ...over,
  }) as never;

const notified = () =>
  notifications.notify.mock.calls.map(([to, note]) => ({ to, body: note.body as string }));

describe('recording (one case per rule)', () => {
  it('player vs registered opponent: the opponent is asked', async () => {
    const view = await service.create('awa', dto({ opponentUserId: 'moussa' }));
    expect(store[0]).toMatchObject({
      recordedById: 'awa',
      refereed: false,
      player1Confirmation: 'CONFIRMED',
      player2Confirmation: 'PENDING',
      validation: 'PENDING',
      winnerId: 'awa',
    });
    expect(notified()).toEqual([
      { to: 'moussa', body: 'Awa Diop recorded your loss 4-6 3-6. Confirm it?' },
    ]);
    expect(view).toMatchObject({ role: 'PLAYER', recordedByMe: true, canRespond: false, canDelete: true });
  });

  it('player vs guest: validated at once, nobody asked', async () => {
    await service.create('awa', dto({ opponentName: 'Guest Gary' }));
    expect(store[0]).toMatchObject({ player2Confirmation: 'NOT_REGISTERED', validation: 'VALIDATED' });
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('referee, registered vs registered: both players are asked', async () => {
    const view = await service.create(
      'ibou',
      dto({ refereeMode: true, playerUserId: 'awa', opponentUserId: 'moussa' }),
    );
    expect(store[0]).toMatchObject({
      recordedById: 'ibou',
      refereed: true,
      player1Id: 'awa',
      player2Id: 'moussa',
      player1Confirmation: 'PENDING',
      player2Confirmation: 'PENDING',
      validation: 'PENDING',
      winnerId: 'awa',
    });
    expect(notified()).toEqual([
      { to: 'awa', body: 'Ibou Ndiaye refereed your match: you won 6-4 6-3. Confirm the result?' },
      { to: 'moussa', body: 'Ibou Ndiaye refereed your match: you lost 4-6 3-6. Confirm the result?' },
    ]);
    // The referee sees side 1 as "me".
    expect(view).toMatchObject({
      role: 'REFEREE',
      me: { userId: 'awa', name: 'Awa Diop', confirmation: 'PENDING' },
      opponent: { userId: 'moussa', confirmation: 'PENDING' },
      referee: { userId: 'ibou', name: 'Ibou Ndiaye' },
      result: 'WIN',
      canRespond: false,
      canDelete: true,
    });
  });

  it('referee, registered vs guest: only the registered player is asked', async () => {
    await service.create(
      'ibou',
      dto({ refereeMode: true, playerName: 'Guest Gary', opponentUserId: 'moussa', winner: 'OPPONENT' }),
    );
    expect(store[0]).toMatchObject({
      player1Id: null,
      player1Name: 'Guest Gary',
      player1Confirmation: 'NOT_REGISTERED',
      player2Confirmation: 'PENDING',
      validation: 'PENDING',
      winnerId: 'moussa',
    });
    expect(notified().map((n) => n.to)).toEqual(['moussa']);
  });

  it('referee, guest vs guest: validated at once, nobody asked', async () => {
    const view = await service.create(
      'ibou',
      dto({ refereeMode: true, playerName: 'Gary', opponentName: 'Lou' }),
    );
    expect(store[0]).toMatchObject({
      player1Confirmation: 'NOT_REGISTERED',
      player2Confirmation: 'NOT_REGISTERED',
      validation: 'VALIDATED',
      winnerId: null,
    });
    expect(notifications.notify).not.toHaveBeenCalled();
    expect(view.me.name).toBe('Gary');
  });
});

describe('recording checks', () => {
  it("won't let the referee be a player", async () => {
    await expect(
      service.create('ibou', dto({ refereeMode: true, playerUserId: 'ibou', opponentUserId: 'moussa' })),
    ).rejects.toThrow('referee a match you play in');
    await expect(
      service.create('ibou', dto({ refereeMode: true, playerName: 'Gary', opponentUserId: 'ibou' })),
    ).rejects.toThrow('referee a match you play in');
  });

  it("won't put the same person on both sides", async () => {
    await expect(
      service.create('ibou', dto({ refereeMode: true, playerUserId: 'awa', opponentUserId: 'awa' })),
    ).rejects.toThrow('different people');
  });

  it('needs exactly one side-1 player in referee mode', async () => {
    await expect(
      service.create('ibou', dto({ refereeMode: true, opponentUserId: 'moussa' })),
    ).rejects.toThrow('Pick the first player');
    await expect(
      service.create('ibou', dto({ refereeMode: true, playerUserId: 'awa', playerName: 'X', opponentUserId: 'moussa' })),
    ).rejects.toThrow('Pick the first player');
  });

  it('refuses referee fields in player mode', async () => {
    await expect(
      service.create('awa', dto({ playerUserId: 'moussa', opponentName: 'Gary' })),
    ).rejects.toThrow('only be chosen when you referee');
  });

  it('rejects an unknown player id', async () => {
    await expect(
      service.create('ibou', dto({ refereeMode: true, playerUserId: 'ghost', opponentUserId: 'moussa' })),
    ).rejects.toThrow('Opponent not found');
  });

  it('treats a retried save (same recorder + start) as the same match', async () => {
    const body = dto({ refereeMode: true, playerUserId: 'awa', opponentUserId: 'moussa' });
    const first = await service.create('ibou', body);
    const again = await service.create('ibou', body);
    expect(again.id).toBe(first.id);
    expect(store).toHaveLength(1);
    expect(prisma.match.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { recordedById: 'ibou', startedAt: expect.any(Date) },
      }),
    );
  });
});

describe('confirm / reject', () => {
  const refereed = () =>
    service.create('ibou', dto({ refereeMode: true, playerUserId: 'awa', opponentUserId: 'moussa' }));

  it('validates once the opponent confirms, and tells the recorder', async () => {
    const { id } = await service.create('awa', dto({ opponentUserId: 'moussa' }));
    notifications.notify.mockClear();
    const view = await service.confirm('moussa', id);
    expect(view).toMatchObject({
      validation: 'VALIDATED',
      me: { userId: 'moussa', confirmation: 'CONFIRMED' },
      canRespond: false,
    });
    expect(view.me.respondedAt).toBeInstanceOf(Date);
    expect(notified()).toEqual([
      { to: 'awa', body: 'Moussa Fall confirmed the result 6-4 6-3. It now counts.' },
    ]);
  });

  it('stays pending until every asked player confirms', async () => {
    const { id } = await refereed();
    expect((await service.confirm('awa', id)).validation).toBe('PENDING');
    expect((await service.confirm('moussa', id)).validation).toBe('VALIDATED');
  });

  it('one rejection out of two rejects the match', async () => {
    const { id } = await refereed();
    await service.confirm('awa', id);
    notifications.notify.mockClear();
    const view = await service.reject('moussa', id, '  The score was 6-4 4-6  ');
    expect(view.validation).toBe('REJECTED');
    expect(view.me.rejectReason).toBe('The score was 6-4 4-6');
    expect(notified()).toEqual([
      {
        to: 'ibou',
        body: 'Moussa Fall rejected the result: "The score was 6-4 4-6". The match won\'t count.',
      },
    ]);
    // The recorder sees the reason; the other player doesn't.
    expect((await service.findOne('ibou', id)).opponent.rejectReason).toBe('The score was 6-4 4-6');
    expect((await service.findOne('awa', id)).opponent.rejectReason).toBeNull();
  });

  it('stores an empty reason as null', async () => {
    const { id } = await refereed();
    expect((await service.reject('awa', id, '   ')).me.rejectReason).toBeNull();
  });

  it('refuses a second answer with 409', async () => {
    const { id } = await refereed();
    await service.confirm('awa', id);
    await expect(service.confirm('awa', id)).rejects.toBeInstanceOf(ConflictException);
    await expect(service.reject('awa', id)).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses the recorder (nothing to confirm) with 409', async () => {
    const { id } = await refereed();
    await expect(service.confirm('ibou', id)).rejects.toBeInstanceOf(ConflictException);
  });

  it('hides the match from a stranger with 404', async () => {
    const { id } = await refereed();
    await expect(service.confirm('fatou', id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('lists what I still have to answer', async () => {
    const { id } = await refereed();
    const awa = await service.pending('awa');
    expect(awa.items.map((m) => [m.id, m.canRespond])).toEqual([[id, true]]);
    await service.confirm('awa', id);
    expect((await service.pending('awa')).items).toEqual([]);
    expect((await service.pending('moussa')).items).toHaveLength(1);
  });
});

describe('summary', () => {
  it('counts only considered matches, plus the two counters', async () => {
    // Counted: vs a guest. Pending: vs Moussa. Rejected: vs Moussa.
    await service.create('awa', dto({ opponentName: 'Gary' }));
    await service.create('awa', dto({ opponentUserId: 'moussa' }));
    const { id: rejected } = await service.create('awa', dto({ opponentUserId: 'moussa', winner: 'OPPONENT' }));
    await service.reject('moussa', rejected);
    // Refereed by Ibou, waiting on Awa.
    await service.create('ibou', dto({ refereeMode: true, playerUserId: 'awa', opponentName: 'Lou' }));

    expect(await service.summary('awa')).toMatchObject({
      matches: 1,
      wins: 1,
      losses: 0,
      pendingConfirmations: 1,
      awaitingOthers: 1,
    });
    expect(await service.summary('moussa')).toMatchObject({
      matches: 0,
      pendingConfirmations: 1,
      awaitingOthers: 0,
    });
  });

  it("never gives the referee stats", async () => {
    const { id } = await service.create(
      'ibou',
      dto({ refereeMode: true, playerUserId: 'awa', opponentUserId: 'moussa' }),
    );
    await service.confirm('awa', id);
    await service.confirm('moussa', id);
    expect(await service.summary('ibou')).toMatchObject({ matches: 0, wins: 0, losses: 0, awaitingOthers: 0 });
    expect(await service.summary('awa')).toMatchObject({ matches: 1, wins: 1 });
    expect(await service.summary('moussa')).toMatchObject({ matches: 1, losses: 1 });
  });
});

describe('deleting', () => {
  it('is for the recorder only', async () => {
    const { id } = await service.create(
      'ibou',
      dto({ refereeMode: true, playerUserId: 'awa', opponentUserId: 'moussa' }),
    );
    await expect(service.remove('awa', id)).rejects.toThrow('Only the player who recorded it');
  });
});
