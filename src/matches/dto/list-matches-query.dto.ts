import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

export class ListMatchesQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  pageSize?: number = 20;

  // Matches I played, or matches I refereed; both when omitted.
  @IsOptional()
  @IsIn(['PLAYER', 'REFEREE'])
  role?: 'PLAYER' | 'REFEREE';
}
