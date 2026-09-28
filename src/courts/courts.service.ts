import { Injectable, NotFoundException } from '@nestjs/common';
import { BookingStatus, CourtStatus, OrganizationStatus } from '@prisma/client';
import { hourlySlots, parseOpeningHours, windowsFor } from '../clubs/opening-hours.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { t } from '../i18n/i18n.js';

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
  /** False when the court can't be booked at all (maintenance, closed…). */
  bookable: boolean;
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
      include: {
        availability: true,
        club: { select: { openingHours: true, organization: { select: { status: true } } } },
      },
    });
    if (!court || court.archivedAt || court.club.organization.status !== OrganizationStatus.ACTIVE) {
      throw new NotFoundException(t('errors.courts.notFound'));
    }

    // `date` has already passed @IsDateString() validation; take just the
    // calendar day. Slots come from the court's own windows, else its club's
    // opening hours (see clubs/opening-hours.ts).
    const day = date.slice(0, 10);
    const dayStart = new Date(`${day}T00:00:00.000Z`);
    if (court.status !== CourtStatus.AVAILABLE) {
      return { courtId, date: day, bookable: false, slots: [] };
    }
    const hourSlots = hourlySlots(
      dayStart,
      windowsFor(dayStart, court.availability, parseOpeningHours(court.club.openingHours)),
    );
    if (hourSlots.length === 0) return { courtId, date: day, bookable: true, slots: [] };
    const windowStart = hourSlots[0].start;
    const windowEnd = hourSlots[hourSlots.length - 1].end;

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
    for (const { start, end } of hourSlots) {
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

    return { courtId, date: day, bookable: true, slots };
  }
}
