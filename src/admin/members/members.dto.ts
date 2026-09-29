import { BookingStatus, MemberStatus, PaymentPurpose, PaymentStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDate,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PageQueryDto } from '../../common/pagination.js';
import { PAYMENT_STATUSES, type MembershipPaymentStatus } from './membership-rules.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const money = () => [Type(() => Number), IsNumber({ maxDecimalPlaces: 2 }), Min(0), Max(100_000_000)];
const apply = (...decorators: PropertyDecorator[]) => (target: object, key: string) =>
  decorators.forEach((d) => d(target, key));

// Plans ---------------------------------------------------------------

export class PlanDto {
  @IsOptional() @Transform(trim) @IsString() @MinLength(2) @MaxLength(60) name?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(300) description?: string | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(60) durationMonths?: number;
  @IsOptional() @apply(...money()) price?: number;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class CreatePlanDto extends PlanDto {
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(60) declare name: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(60) declare durationMonths: number;
  @apply(...money()) declare price: number;
}

// Members -------------------------------------------------------------

export class ListMembersQueryDto extends PageQueryDto {
  @IsOptional() @IsIn(Object.values(MemberStatus)) status?: MemberStatus;
  @IsOptional() @IsIn(PAYMENT_STATUSES) paymentStatus?: MembershipPaymentStatus;
  @IsOptional() @IsString() planId?: string;
  /** csv: every matching member as a CSV file (capped). */
  @IsOptional() @IsIn(['json', 'csv']) format?: 'json' | 'csv';
}

export class CandidateQueryDto {
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(60) q!: string;
}

/** A first payment recorded together with the membership. */
export class InitialPaymentDto {
  @apply(...money()) amount!: number;
  @IsString() methodKey!: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(80) externalReference?: string;
}

export class CreateMemberDto {
  @IsString() userId!: string;
  @IsString() planId!: string;
  /** Default: today. */
  @IsOptional() @Type(() => Date) @IsDate() startsAt?: Date;
  /** Default: next free number. */
  @IsOptional() @Transform(trim) @Matches(/^[A-Za-z0-9-]{1,20}$/) membershipNumber?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500) notes?: string;
  @IsOptional() @ValidateNested() @Type(() => InitialPaymentDto) payment?: InitialPaymentDto;
}

export class UpdateMemberDto {
  @IsOptional() @Transform(trim) @Matches(/^[A-Za-z0-9-]{1,20}$/) membershipNumber?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500) notes?: string | null;
}

export class MemberStatusDto {
  @IsIn(Object.values(MemberStatus)) status!: MemberStatus;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500) reason?: string;
}

export class RenewMemberDto {
  @IsString() planId!: string;
  @IsOptional() @ValidateNested() @Type(() => InitialPaymentDto) payment?: InitialPaymentDto;
}

// Payments ------------------------------------------------------------

export class ListPaymentsQueryDto extends PageQueryDto {
  @IsOptional() @IsString() organizationId?: string;
  @IsOptional() @IsIn(Object.values(PaymentStatus)) status?: PaymentStatus;
  @IsOptional() @IsIn(Object.values(PaymentPurpose)) purpose?: PaymentPurpose;
  @IsOptional() @IsString() methodKey?: string;
  @IsOptional() @Type(() => Date) @IsDate() from?: Date;
  @IsOptional() @Type(() => Date) @IsDate() to?: Date;
  @IsOptional() @IsIn(['json', 'csv']) format?: 'json' | 'csv';
}

export class RecordPaymentDto {
  @IsIn(Object.values(PaymentPurpose)) purpose!: PaymentPurpose;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(1) @Max(100_000_000) amount!: number;
  @IsString() methodKey!: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(80) externalReference?: string;
  @IsOptional() @IsString() membershipId?: string;
  @IsOptional() @IsString() bookingId?: string;
  @IsOptional() @IsString() payerId?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(120) payerName?: string;
  @IsOptional() @Type(() => Date) @IsDate() paidAt?: Date;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500) notes?: string;
}

export class RefundDto {
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(500) reason!: string;
}

// Bookings ------------------------------------------------------------

export class ListBookingsQueryDto extends PageQueryDto {
  @IsOptional() @Type(() => Date) @IsDate() from?: Date;
  @IsOptional() @Type(() => Date) @IsDate() to?: Date;
  @IsOptional() @IsString() courtId?: string;
  @IsOptional() @IsIn(Object.values(BookingStatus)) status?: BookingStatus;
}

export class CancelBookingDto {
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(500) reason!: string;
}

export class FederationPlayersQueryDto extends PageQueryDto {
  @IsOptional() @IsString() clubId?: string;
}
