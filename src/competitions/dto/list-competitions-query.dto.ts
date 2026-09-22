import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

export const COMPETITION_STATUS_FILTERS = [
  'UPCOMING',
  'ONGOING',
  'COMPLETED',
] as const;

export class ListCompetitionsQueryDto {
  @IsOptional()
  @IsIn(COMPETITION_STATUS_FILTERS)
  status?: (typeof COMPETITION_STATUS_FILTERS)[number];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number = 20;
}
