import {
  CompetitionFormat,
  CompetitionStatus,
  CompetitionVisibility,
  EntryType,
  EventDiscipline,
  EventGender,
  FinalSetFormat,
  Gender,
  InterruptionReason,
  RegistrationStatus,
  Surface,
} from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDate,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PageQueryDto } from '../../common/pagination.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
/** "" and null both clear an optional id. */
const nullableId = ({ value }: { value: unknown }) => (value === '' ? null : value);

// Tournaments ---------------------------------------------------------

export class ListTournamentsQueryDto extends PageQueryDto {
  @IsOptional() @IsIn(Object.values(CompetitionStatus)) status?: CompetitionStatus;
  @IsOptional() @IsString() hostOrganizationId?: string;
  /** Tournaments overlapping [from, to]. */
  @IsOptional() @Type(() => Date) @IsDate() from?: Date;
  @IsOptional() @Type(() => Date) @IsDate() to?: Date;
}

export class TournamentDto {
  @IsOptional() @Transform(trim) @IsString() @MinLength(3) @MaxLength(120) name?: string;
  /** Venue club shown to players. */
  @IsOptional() @Transform(nullableId) @IsString() clubId?: string | null;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(200) location?: string | null;
  @IsOptional() @Type(() => Date) @IsDate() startDate?: Date;
  @IsOptional() @Type(() => Date) @IsDate() endDate?: Date;
  @IsOptional() @Type(() => Date) @IsDate() registrationOpensAt?: Date | null;
  @IsOptional() @Type(() => Date) @IsDate() registrationClosesAt?: Date | null;
  @IsOptional() @IsIn(Object.values(Surface)) surface?: Surface | null;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(4000) description?: string | null;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(80) category?: string | null;
  @IsOptional() @IsUrl({ require_tld: false }) @MaxLength(500) bannerUrl?: string | null;
  @IsOptional() @IsIn(Object.values(CompetitionVisibility)) visibility?: CompetitionVisibility;
}

export class EventDto {
  @IsOptional() @Transform(trim) @IsString() @MinLength(2) @MaxLength(80) name?: string;
  @IsOptional() @IsIn(Object.values(EventDiscipline)) discipline?: EventDiscipline;
  @IsOptional() @IsIn(Object.values(EventGender)) gender?: EventGender;
  @IsOptional() @Type(() => Number) @IsInt() @Min(5) @Max(99) ageMin?: number | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(5) @Max(99) ageMax?: number | null;
  /** Weakest classification admitted (e.g. 30/5). */
  @IsOptional() @Transform(nullableId) @IsString() minClassificationId?: string | null;
  /** Strongest classification admitted (e.g. 30). */
  @IsOptional() @Transform(nullableId) @IsString() maxClassificationId?: string | null;
  @IsOptional() @IsIn(Object.values(CompetitionFormat)) format?: CompetitionFormat;
  @IsOptional() @Type(() => Number) @IsInt() @Min(2) @Max(256) maxEntries?: number | null;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(10_000_000) entryFee?: number | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(32) seedCount?: number;
  @IsOptional() @Type(() => Number) @IsIn([1, 3, 5]) bestOf?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(9) gamesPerSet?: number;
  @IsOptional() @IsIn(Object.values(FinalSetFormat)) finalSet?: FinalSetFormat;
  @IsOptional() @IsBoolean() noAd?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(15) @Max(600) matchDurationMinutes?: number;
  @IsOptional() @Transform(nullableId) @IsString() qualifiesIntoEventId?: string | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(64) qualifierCount?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(50) tableOrder?: number;
}

export class CreateEventDto extends EventDto {
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(80) declare name: string;
}

/**
 * An event created together with its tournament. Events don't have ids yet,
 * so successive tables point at each other through client-chosen `ref`s.
 */
export class NewTournamentEventDto extends CreateEventDto {
  @IsOptional() @IsString() @MaxLength(40) ref?: string;
  @IsOptional() @IsString() @MaxLength(40) qualifiesIntoRef?: string;
}

export class CreateTournamentDto extends TournamentDto {
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(120) declare name: string;
  @Type(() => Date) @IsDate() declare startDate: Date;
  @Type(() => Date) @IsDate() declare endDate: Date;
  /** Club, federation or community running it; null = independent organizer. */
  @IsOptional() @Transform(nullableId) @IsString() hostOrganizationId?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => NewTournamentEventDto)
  events?: NewTournamentEventDto[];
}

export class TransitionDto {
  @IsIn(Object.values(CompetitionStatus)) to!: CompetitionStatus;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500) reason?: string;
  /** Tell participants (cancellation). Default true. */
  @IsOptional() @IsBoolean() notify?: boolean;
}

export class InterruptDto {
  @IsIn(Object.values(InterruptionReason)) reason!: InterruptionReason;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500) note?: string;
  @IsOptional() @IsBoolean() notify?: boolean;
}

export class ResumeDto {
  @IsOptional() @IsBoolean() notify?: boolean;
}

export class StaffGrantDto {
  @IsString() userId!: string;
  @IsString() roleKey!: string;
}

export class StaffRevokeQueryDto {
  @IsOptional() @Transform(trim) @IsString() @MaxLength(300) reason?: string;
}

// Registrations -------------------------------------------------------

export class ListRegistrationsQueryDto extends PageQueryDto {
  @IsOptional() @IsIn(Object.values(RegistrationStatus)) status?: RegistrationStatus;
  @IsOptional() @IsIn(Object.values(EntryType)) entryType?: EntryType;
}

export class EntryCandidatesQueryDto {
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(60) q!: string;
}

export class CreateEntryDto {
  @IsString() userId!: string;
  @IsOptional() @Transform(nullableId) @IsString() partnerUserId?: string | null;
  @IsOptional() @IsIn(Object.values(EntryType)) entryType?: EntryType;
  /** Lower table a QUALIFIER / LUCKY_LOSER comes from. */
  @IsOptional() @Transform(nullableId) @IsString() sourceEventId?: string | null;
  /** Default APPROVED: an entry added by the organizer is accepted. */
  @IsOptional() @IsIn([RegistrationStatus.APPROVED, RegistrationStatus.PENDING, RegistrationStatus.WAITLISTED])
  status?: RegistrationStatus;
  /** Accept despite eligibility issues; audited. */
  @IsOptional() @Transform(trim) @IsString() @MaxLength(300) overrideReason?: string;
}

export class DecisionDto {
  @IsOptional() @Transform(trim) @IsString() @MaxLength(300) reason?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(300) overrideReason?: string;
  @IsOptional() @IsBoolean() notify?: boolean;
}

export class SeedDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(64) seed!: number | null;
}

// Players' sport identity ------------------------------------------------

export class SportProfileDto {
  @IsOptional() @Transform(nullableId) @IsString() classificationId?: string | null;
  @IsOptional() @IsIn(Object.values(Gender)) gender?: Gender | null;
  @IsOptional() @Type(() => Date) @IsDate() birthDate?: Date | null;
}
