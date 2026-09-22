import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

const citySelect = {
  id: true,
  name: true,
  country: { select: { code: true, name: true } },
} as const;

interface CityWithCountry {
  id: string;
  name: string;
  country: { code: string; name: string };
}

// The API keeps sending `city` and `country` as plain names (what the app
// reads), now derived from the City -> Country rows, plus their ids/code.
function withLocation<T extends { city: CityWithCountry }>({
  city,
  ...club
}: T) {
  return {
    ...club,
    cityId: city.id,
    city: city.name,
    country: city.country.name,
    countryCode: city.country.code,
  };
}

@Injectable()
export class ClubsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    const clubs = await this.prisma.club.findMany({
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        description: true,
        logoUrl: true,
        bannerUrl: true,
        address: true,
        city: { select: citySelect },
        latitude: true,
        longitude: true,
        amenities: true,
        _count: { select: { courts: true } },
      },
    });

    return clubs.map(({ _count, ...club }) => ({
      ...withLocation(club),
      courtsCount: _count.courts,
    }));
  }

  async findOneWithCourts(id: string) {
    const club = await this.prisma.club.findUnique({
      where: { id },
      include: {
        city: { select: citySelect },
        courts: {
          select: {
            id: true,
            cityId: true,
            name: true,
            surface: true,
            indoor: true,
            pricePerHour: true,
            photos: true,
          },
        },
      },
    });

    if (!club) {
      throw new NotFoundException('Club not found');
    }

    // `cityId` (the club's own column) is replaced by the one from `city`.
    const { cityId: _cityId, ...rest } = club;
    return withLocation(rest);
  }
}
