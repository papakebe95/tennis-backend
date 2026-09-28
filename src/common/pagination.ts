import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

// Shared list contract of the /admin API:
//   ?page=1&pageSize=20&q=text&sort=field:asc  →  { items, total, page, pageSize }
// Lists are always paginated server-side; pageSize is capped.

export class PageQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 20;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @Matches(/^[a-zA-Z]+:(asc|desc)$/)
  sort?: string;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export const pageArgs = ({ page, pageSize }: PageQueryDto) => ({
  skip: (page - 1) * pageSize,
  take: pageSize,
});

export const toPage = <T>(items: T[], total: number, { page, pageSize }: PageQueryDto): Page<T> => ({
  items,
  total,
  page,
  pageSize,
});

/**
 * `sort=field:dir` as a Prisma orderBy, limited to `allowed` fields (anything
 * else falls back), so clients can't sort on arbitrary columns.
 */
export function orderBy<F extends string>(
  sort: string | undefined,
  allowed: readonly F[],
  fallback: { field: F; direction: 'asc' | 'desc' },
): Record<F, 'asc' | 'desc'> {
  const [field, direction] = (sort ?? '').split(':') as [F, 'asc' | 'desc'];
  const valid = allowed.includes(field) && (direction === 'asc' || direction === 'desc');
  return (valid
    ? { [field]: direction }
    : { [fallback.field]: fallback.direction }) as Record<F, 'asc' | 'desc'>;
}

/** Trimmed search text, or undefined when blank. */
export const searchText = (q?: string) => q?.trim() || undefined;
