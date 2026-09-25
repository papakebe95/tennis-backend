import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { runWithLang } from '../i18n/i18n.js';
import { ClubsService } from './clubs.service.js';

const city = {
  id: 'city-dakar',
  name: 'Dakar',
  translations: null,
  country: {
    code: 'SN',
    name: 'Senegal',
    translations: { fr: { name: 'Sénégal' } },
  },
};

describe('ClubsService location', () => {
  it('lists clubs with city and country as plain names (what the app reads)', async () => {
    const prisma = {
      club: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'c1', name: 'ASAC', amenities: [], city, _count: { courts: 3 } },
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
          amenities: [],
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

  it('answers in French when asked to: place names, description, amenities', async () => {
    const prisma = {
      club: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'c1',
            name: 'ASAC',
            description: 'A family-friendly club.',
            translations: { fr: { description: 'Un club familial.' } },
            amenities: ['Locker rooms', 'Sauna'],
            city,
            _count: { courts: 3 },
          },
        ]),
      },
    };
    const service = new ClubsService(prisma as never);

    const [fr] = await runWithLang('fr', () => service.findAll());
    expect(fr).toMatchObject({
      description: 'Un club familial.',
      country: 'Sénégal',
      city: 'Dakar',
      amenities: ['Locker rooms', 'Sauna'],
      amenityLabels: ['Vestiaires', 'Sauna'],
    });
    expect(fr).not.toHaveProperty('translations');

    const [en] = await service.findAll();
    expect(en).toMatchObject({
      description: 'A family-friendly club.',
      country: 'Senegal',
      amenityLabels: ['Locker rooms', 'Sauna'],
    });
  });

  it('404s for an unknown club', async () => {
    const prisma = { club: { findUnique: vi.fn().mockResolvedValue(null) } };
    await expect(
      new ClubsService(prisma as never).findOneWithCourts('nope'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('words the 404 in the request language', async () => {
    const prisma = { club: { findUnique: vi.fn().mockResolvedValue(null) } };
    const service = new ClubsService(prisma as never);
    await expect(
      runWithLang('fr', () => service.findOneWithCourts('nope')),
    ).rejects.toThrow('Club introuvable');
    await expect(service.findOneWithCourts('nope')).rejects.toThrow('Club not found');
  });
});
