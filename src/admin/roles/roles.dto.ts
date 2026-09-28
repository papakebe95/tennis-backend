import { OrganizationType, RoleScope } from '@prisma/client';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class RolePermissionsDto {
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  permissions!: string[];
}

export class UpdateRoleDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsBoolean()
  selfRegistrable?: boolean;

  @IsOptional()
  @IsIn(Object.values(RoleScope))
  scope?: RoleScope;

  @IsOptional()
  @IsIn([...Object.values(OrganizationType), null])
  organizationType?: OrganizationType | null;
}

export class CreateRoleDto extends RolePermissionsDto {
  // Stable machine key, e.g. LEAGUE_ORGANIZER.
  @Matches(/^[A-Z][A-Z0-9_]{2,40}$/)
  key!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsIn(Object.values(RoleScope))
  scope!: RoleScope;

  @IsOptional()
  @IsIn(Object.values(OrganizationType))
  organizationType?: OrganizationType;

  @IsOptional()
  @IsBoolean()
  selfRegistrable?: boolean;
}
