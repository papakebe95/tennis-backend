import { Injectable, NotFoundException } from '@nestjs/common';
import { BookingStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { t } from '../i18n/i18n.js';

// Business hours are fixed for now (no per-club overrides yet): 08:00-22:00
// in 1-hour slots, treated as UTC. This is a known simplification - a real
// implementation would resolve this against the club's actual timezone.
const OPENING_HOUR_UTC = 8;
const CLOSING_HOUR_UTC = 22;

export interface AvailabilitySlotBookedBy {
  firstname: string;
  lastname: string;
  lookingForPartner: boolean;
  msisdn: string | null;
}

export interface AvailabilitySlot {
  start: string;
  end: string;
  available: boolean;
  bookedBy?: AvailabilitySlotBookedBy;
}

export interface CourtAvailability {
  courtId: string;
  date: string;
  slots: AvailabilitySlot[];
}

const ACTIVE_BOOKING_STATUSES: BookingStatus[] = [
  BookingStatus.PENDING,
  BookingStatus.CONFIRMED,
];

@Injectable()
export class CourtsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAvailability(
    courtId: string,
    date: string,
  ): Promise<CourtAvailability> {
    const court = await this.prisma.court.findUnique({
      where: { id: courtId },
    });
    if (!court) {
      throw new NotFoundException(t('errors.courts.notFound'));
    }

    // `date` has already passed @IsDateString() validation; take just the
    // calendar day and anchor slot generation at UTC midnight.
    const day = date.slice(0, 10);
    const dayStart = new Date(`${day}T00:00:00.000Z`);
    const windowStart = new Date(`${day}T00:00:00.000Z`);
    windowStart.setUTCHours(OPENING_HOUR_UTC, 0, 0, 0);
    const windowEnd = new Date(`${day}T00:00:00.000Z`);
    windowEnd.setUTCHours(CLOSING_HOUR_UTC, 0, 0, 0);

    const bookings = await this.prisma.booking.findMany({
      where: {
        courtId,
        status: { in: ACTIVE_BOOKING_STATUSES },
        startTime: { lt: windowEnd },
        endTime: { gt: windowStart },
      },
      select: {
        startTime: true,
        endTime: true,
        lookingForPartner: true,
        user: {
          select: { firstname: true, lastname: true, msisdn: true },
        },
      },
    });

    const slots: AvailabilitySlot[] = [];
    for (
      let hour = OPENING_HOUR_UTC;
      hour < CLOSING_HOUR_UTC;
      hour += 1
    ) {
      const start = new Date(dayStart);
      start.setUTCHours(hour, 0, 0, 0);
      const end = new Date(dayStart);
      end.setUTCHours(hour + 1, 0, 0, 0);

      const occupyingBooking = bookings.find(
        (booking) => booking.startTime < end && booking.endTime > start,
      );

      const slot: AvailabilitySlot = {
        start: start.toISOString(),
        end: end.toISOString(),
        available: !occupyingBooking,
      };

      if (occupyingBooking) {
        slot.bookedBy = {
          firstname: occupyingBooking.user.firstname,
          lastname: occupyingBooking.user.lastname,
          lookingForPartner: occupyingBooking.lookingForPartner,
          msisdn: occupyingBooking.lookingForPartner
            ? occupyingBooking.user.msisdn
            : null,
        };
      }

      slots.push(slot);
    }

    return { courtId, date: day, slots };
  }
}
