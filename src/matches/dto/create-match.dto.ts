import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { FinalSetFormat } from '@prisma/client';

const MAX_SECONDS = 24 * 60 * 60;

export class TiebreakScoreDto {
  @IsInt()
  @Min(0)
  @Max(99)
  me!: number;

  @IsInt()
  @Min(0)
  @Max(99)
  opp!: number;
}

// Scores are always from the recording user's point of view ("me" / "opp").
export class SetScoreDto {
  @IsInt()
  @Min(0)
  @Max(50)
  me!: number;

  @IsInt()
  @Min(0)
  @Max(50)
  opp!: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => TiebreakScoreDto)
  tiebreak?: TiebreakScoreDto;

  @IsOptional()
  @IsBoolean()
  superTiebreak?: boolean;
}

export class CreateMatchDto {
  // Registered opponent...
  @IsOptional()
  @IsString()
  opponentUserId?: string;

  // ...or a guest typed by hand.
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  opponentName?: string;

  @IsIn(['FRIENDLY', 'TRAINING'])
  matchType!: 'FRIENDLY' | 'TRAINING';

  @IsIn([1, 3, 5])
  bestOf!: number;

  @IsBoolean()
  noAd!: boolean;

  @IsEnum(FinalSetFormat)
  finalSet!: FinalSetFormat;

  @IsIn(['COMPLETED', 'UNFINISHED'])
  status!: 'COMPLETED' | 'UNFINISHED';

  // Required when COMPLETED; optional when the match ended early.
  @IsOptional()
  @IsIn(['ME', 'OPPONENT'])
  winner?: 'ME' | 'OPPONENT';

  @IsArray()
  @ArrayMaxSize(5)
  @ValidateNested({ each: true })
  @Type(() => SetScoreDto)
  sets!: SetScoreDto[];

  @IsDateString()
  startedAt!: string;

  @IsDateString()
  endedAt!: string;

  // Wall-clock length, and time the ball was actually in play.
  @IsInt()
  @Min(0)
  @Max(MAX_SECONDS)
  totalSeconds!: number;

  @IsInt()
  @Min(0)
  @Max(MAX_SECONDS)
  playSeconds!: number;

  @IsInt()
  @Min(0)
  @Max(5000)
  myPoints!: number;

  @IsInt()
  @Min(0)
  @Max(5000)
  oppPoints!: number;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  location?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
