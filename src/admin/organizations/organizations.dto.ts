import { AffiliationStatus, CourtStatus, OrganizationStatus, OrganizationType, Surface } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PageQueryDto } from '../../common/pagination.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
/** "" clears an optional field. */
const blankToNull = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? (value.trim() === '' ? null : value.trim()) : value;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;

export class ListOrganizationsQueryDto extends PageQueryDto {
  @IsOptional() @IsIn(Object.values(OrganizationType)) type?: OrganizationType;
  @IsOptional() @IsIn(Object.values(OrganizationStatus)) status?: OrganizationStatus;
}

/** Social links: { facebook, instagram, x, youtube, tiktok, whatsapp } → URLs. */
export class SocialLinksDto {
  @IsOptional() @Transform(blankToNull) @IsUrl() facebook?: string | null;
  @IsOptional() @Transform(blankToNull) @IsUrl() instagram?: string | null;
  @IsOptional() @Transform(blankToNull) @IsUrl() x?: string | null;
  @IsOptional() @Transform(blankToNull) @IsUrl() youtube?: string | null;
  @IsOptional() @Transform(blankToNull) @IsUrl() tiktok?: string | null;
  @IsOptional() @Transform(blankToNull) @IsString() @MaxLength(30) whatsapp?: string | null;
}

/** Social links as stored JSON (known fields only). */
export const socialLinksJson = (links: SocialLinksDto) => ({
  facebook: links.facebook ?? null,
  instagram: links.instagram ?? null,
  x: links.x ?? null,
  youtube: links.youtube ?? null,
  tiktok: links.tiktok ?? null,
  whatsapp: links.whatsapp ?? null,
});

/** Fields every organization has (federation profile, club contact). */
export class OrganizationProfileDto {
  @IsOptional() @Transform(trim) @IsString() @MinLength(2) @MaxLength(120) name?: string;
  @IsOptional() @Transform(blankToNull) @IsString() @MaxLength(2000) description?: string | null;
  @IsOptional() @Transform(blankToNull) @IsUrl() logoUrl?: string | null;
  @IsOptional() @Transform(blankToNull) @IsEmail() email?: string | null;
  @IsOptional() @Transform(blankToNull) @IsString() @MaxLength(30) phone?: string | null;
  @IsOptional() @Transform(blankToNull) @IsUrl() website?: string | null;
  @IsOptional() @Transform(blankToNull) @IsString() @MaxLength(200) address?: string | null;
  @IsOptional() @IsString() countryId?: string;
  @IsOptional() @ValidateNested() @Type(() => SocialLinksDto) socialLinks?: SocialLinksDto;
}

export class CreateOrganizationDto extends OrganizationProfileDto {
  @IsIn(Object.values(OrganizationType)) type!: OrganizationType;
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(120) declare name: string;
  /** Required for a club. */
  @IsOptional() @IsString() cityId?: string;
}

export class SetOrganizationStatusDto {
  @IsIn(Object.values(OrganizationStatus)) status!: OrganizationStatus;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500) reason?: string;
}

export class UpdateClubDto extends OrganizationProfileDto {
  @IsOptional() @Transform(blankToNull) @IsUrl() bannerUrl?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsUrl({}, { each: true }) photos?: string[];
  @IsOptional() @IsString() cityId?: string;
  @IsOptional() @IsLatitude() latitude?: number | null;
  @IsOptional() @IsLongitude() longitude?: number | null;
  /** { mon: ["07:00-22:00"], …, sun: [] } (validated in the service). */
  @IsOptional() @IsObject() openingHours?: Record<string, string[]>;
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) @MaxLength(40, { each: true }) amenities?: string[];
}

export class AffiliationRequestDto {
  @IsString() federationId!: string;
}

export class AddAffiliatedClubDto {
  @IsString() clubOrganizationId!: string;
}

export class AffiliationDecisionDto {
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500) reason?: string;
}

export class ListAffiliationsQueryDto extends PageQueryDto {
  @IsOptional() @IsIn(Object.values(AffiliationStatus)) status?: AffiliationStatus;
}

export class CourtDto {
  @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(60) name?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(999) number?: number | null;
  @IsOptional() @IsIn(Object.values(Surface)) surface?: Surface;
  @IsOptional() @IsBoolean() indoor?: boolean;
  @IsOptional() @IsBoolean() lighting?: boolean;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(10_000_000) pricePerHour?: number | null;
  @IsOptional() @IsArray() @ArrayMaxSize(12) @IsUrl({}, { each: true }) photos?: string[];
}

export class CreateCourtDto extends CourtDto {
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(60) declare name: string;
  @IsIn(Object.values(Surface)) declare surface: Surface;
}

export class SetCourtStatusDto {
  @IsIn(Object.values(CourtStatus)) status!: CourtStatus;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500) reason?: string;
}

export class AvailabilityWindowDto {
  @Type(() => Number) @IsInt() @Min(0) @Max(6) weekday!: number;
  @Matches(HHMM) opensAt!: string;
  @Matches(HHMM) closesAt!: string;
}

export class CourtAvailabilityDto {
  /** Empty: the court follows its club's opening hours. */
  @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => AvailabilityWindowDto)
  windows!: AvailabilityWindowDto[];
}
