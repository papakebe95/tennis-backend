import { AccessRequestStatus, OrganizationType } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsStrongPassword,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PageQueryDto } from '../common/pagination.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** A new organization the applicant wants to administer (created on approval). */
export class ProposedOrganizationDto {
  @IsIn(Object.values(OrganizationType))
  type!: OrganizationType;

  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  // Required for clubs (every club is in a city).
  @IsOptional()
  @IsString()
  cityId?: string;

  @IsOptional()
  @IsString()
  countryId?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  address?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(30)
  phone?: string;

  @IsOptional()
  @IsEmail()
  email?: string;
}

export class CreateAccessRequestDto {
  @IsString()
  @MaxLength(60)
  roleKey!: string;

  @IsOptional()
  @IsString()
  organizationId?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ProposedOrganizationDto)
  proposedOrganization?: ProposedOrganizationDto;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  message?: string;
}

/** Back-office sign-up: a new account plus its first access request. */
export class RegisterApplicantDto extends CreateAccessRequestDto {
  @Transform(trim)
  @IsString()
  @MaxLength(30)
  msisdn!: string;

  @IsEmail()
  email!: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  firstname!: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  lastname!: string;

  @IsStrongPassword({ minLength: 10, minLowercase: 1, minUppercase: 1, minNumbers: 1, minSymbols: 1 })
  @MaxLength(72)
  password!: string;
}

export class RespondAccessRequestDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  response!: string;
}

export class ReviewDecisionDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

export class RequestInfoDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  message!: string;
}

export class ListAccessRequestsQueryDto extends PageQueryDto {
  /** Default: open requests (PENDING and INFO_REQUESTED). */
  @IsOptional()
  @IsIn([...Object.values(AccessRequestStatus), 'OPEN', 'ALL'])
  status?: AccessRequestStatus | 'OPEN' | 'ALL';

  @IsOptional()
  @IsString()
  roleKey?: string;
}

export class OrganizationSearchQueryDto {
  @IsIn(Object.values(OrganizationType))
  type!: OrganizationType;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;
}
