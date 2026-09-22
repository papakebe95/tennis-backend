import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { BookingStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  bookingCancelled,
  bookingConfirmed,
} from '../notifications/notification-messages.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { CreateBookingDto } from './dto/create-booking.dto.js';

const ACTIVE_BOOKING_STATUSES: BookingStatus[] = [
  BookingStatus.PENDING,
  BookingStatus.CONFIRMED,
];

const bookingInclude = {
  court: { include: { club: true } },
} as const;

@Injectable()
export class BookingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async create(userId: string, dto: CreateBookingDto) {
    const startTime = new Date(dto.startTime);
    const endTime = new Date(dto.endTime);

    if (endTime <= startTime) {
      throw new BadRequestException('endTime must be after startTime');
    }
    if (startTime <= new Date()) {
      throw new BadRequestException('startTime must be in the future');
    }

    const court = await this.prisma.court.findUnique({
      where: { id: dto.courtId },
    });
    if (!court) {
      throw new NotFoundException('Court not found');
    }

    const overlapping = await this.prisma.booking.findFirst({
      where: {
        courtId: dto.courtId,
        status: { in: ACTIVE_BOOKING_STATUSES },
        startTime: { lt: endTime },
        endTime: { gt: startTime },
      },
    });
    if (overlapping) {
      throw new ConflictException(
        'This court is already booked for the requested time range',
      );
    }

    const booking = await this.prisma.booking.create({
      data: {
        courtId: dto.courtId,
        clubId: court.clubId,
        userId,
        startTime,
        endTime,
        status: BookingStatus.CONFIRMED,
        price: court.pricePerHour,
        lookingForPartner: dto.lookingForPartner ?? false,
      },
      include: bookingInclude,
    });

    await this.notifications.notify(
      userId,
      bookingConfirmed({
        courtName: booking.court.name,
        clubName: booking.court.club.name,
        start: booking.startTime,
      }),
    );
    return booking;
  }

  findMineForUser(userId: string) {
    return this.prisma.booking.findMany({
      where: { userId },
      orderBy: { startTime: 'desc' },
      include: bookingInclude,
    });
  }

  async cancel(userId: string, bookingId: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
    });

    if (!booking || booking.userId !== userId) {
      throw new NotFoundException('Booking not found');
    }

    if (booking.startTime <= new Date()) {
      throw new ConflictException(
        'Cannot cancel a booking that has already started or passed',
      );
    }

    const cancelled = await this.prisma.booking.update({
      where: { id: bookingId },
      data: { status: BookingStatus.CANCELLED },
      include: bookingInclude,
    });

    // Cancelling twice is a no-op update; only announce the actual change.
    if (booking.status !== BookingStatus.CANCELLED) {
      await this.notifications.notify(
        userId,
        bookingCancelled({
          courtName: cancelled.court.name,
          clubName: cancelled.court.club.name,
          start: cancelled.startTime,
        }),
      );
    }
    return cancelled;
  }
}
