import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { ClubsService } from './clubs.service.js';

const city = {
  id: 'city-dakar',
  name: 'Dakar',
  country: { code: 'SN', name: 'Senegal' },
};

describe('ClubsService location', () => {
  it('lists clubs with city and country as plain names (what the app reads)', async () => {
    const prisma = {
      club: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'c1', name: 'ASAC', city, _count: { courts: 3 } },
        ]),
      },
    };
    const [club] = await new ClubsService(prisma as never).findAll();

    expect(club).toMatchObject({
      id: 'c1',
      city: 'Dakar',
      country: 'Senegal',
      cityId: 'city-dakar',
      countryCode: 'SN',
      courtsCount: 3,
    });
    expect(club).not.toHaveProperty('_count');
  });

  it('returns a club with its courts, each linked to the city', async () => {
    const prisma = {
      club: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'c1',
          name: 'ASAC',
          cityId: 'city-dakar',
          city,
          courts: [{ id: 'k1', cityId: 'city-dakar', name: 'Court 1' }],
        }),
      },
    };
    const club = await new ClubsService(prisma as never).findOneWithCourts('c1');

    expect(club.city).toBe('Dakar');
    expect(club.country).toBe('Senegal');
    expect(club.cityId).toBe('city-dakar');
    expect(club.courts[0].cityId).toBe('city-dakar');
  });

  it('404s for an unknown club', async () => {
    const prisma = { club: { findUnique: vi.fn().mockResolvedValue(null) } };
    await expect(
      new ClubsService(prisma as never).findOneWithCourts('nope'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
