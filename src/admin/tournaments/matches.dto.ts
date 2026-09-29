import { CompetitionMatchStatus, MatchOutcome, ResultStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDate,
  IsIn,
  IsInt,
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

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class ListMatchesQueryDto extends PageQueryDto {
  @IsOptional() @IsString() competitionId?: string;
  @IsOptional() @IsString() eventId?: string;
  @IsOptional() @IsIn(Object.values(CompetitionMatchStatus)) status?: CompetitionMatchStatus;
  @IsOptional() @IsIn(Object.values(ResultStatus)) resultStatus?: ResultStatus;
  @IsOptional() @IsString() courtId?: string;
  /** Matches scheduled that day (YYYY-MM-DD, Dakar = UTC). */
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) date?: string;
  /** Only matches I officiate. */
  @IsOptional() @IsIn(['true', 'false']) mine?: 'true' | 'false';
  /** Hide byes (on by default). */
  @IsOptional() @IsIn(['true', 'false']) includeByes?: 'true' | 'false';
}

export class ScheduleMatchDto {
  @Type(() => Date) @IsDate() scheduledAt!: Date;
  @IsString() courtId!: string;
}

export class SetScoreDto {
  @Type(() => Number) @IsInt() @Min(0) @Max(99) side1!: number;
  @Type(() => Number) @IsInt() @Min(0) @Max(99) side2!: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(99) tiebreak1?: number | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(99) tiebreak2?: number | null;
  @IsOptional() @IsBoolean() superTiebreak?: boolean;
}

export class MatchResultDto {
  @IsIn(Object.values(MatchOutcome)) outcome!: MatchOutcome;
  @IsArray() @ArrayMaxSize(5) @ValidateNested({ each: true }) @Type(() => SetScoreDto) sets!: SetScoreDto[];
  /** Side that retired or didn't show. */
  @IsOptional() @Type(() => Number) @IsIn([1, 2]) loserSide?: 1 | 2;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(1000) notes?: string;
  /** Reason for correcting a validated result (audited). */
  @IsOptional() @Transform(trim) @IsString() @MaxLength(300) reason?: string;
  @Type(() => Number) @IsInt() @Min(0) version!: number;
}

export class MatchReasonDto {
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(300) reason!: string;
}

export class MatchOfficialDto {
  @IsOptional() @IsString() userId?: string | null;
}

export class TournamentCourtsDto {
  @IsArray() @ArrayMaxSize(60) @IsString({ each: true }) courtIds!: string[];
}

export class ScheduleQueryDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/) date!: string;
}
