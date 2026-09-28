import { UserStatus } from '@prisma/client';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PageQueryDto } from '../../common/pagination.js';

export class ListUsersQueryDto extends PageQueryDto {
  @IsOptional()
  @IsIn(Object.values(UserStatus))
  status?: UserStatus;

  /** Users holding this role (active grant), e.g. CLUB_ADMIN. */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  roleKey?: string;

  /** Users holding any role in this organization. */
  @IsOptional()
  @IsString()
  organizationId?: string;
}

// PENDING and REJECTED are reached through access requests only.
export const SETTABLE_STATUSES = [UserStatus.ACTIVE, UserStatus.SUSPENDED, UserStatus.DISABLED] as const;

export class SetUserStatusDto {
  @IsIn(SETTABLE_STATUSES)
  status!: (typeof SETTABLE_STATUSES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class GrantRoleDto {
  @IsString()
  roleId!: string;

  @IsOptional()
  @IsString()
  organizationId?: string;

  @IsOptional()
  @IsString()
  competitionId?: string;
}

export class RevokeRoleDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
