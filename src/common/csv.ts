import { Prisma } from '@prisma/client';

type Cell = string | number | boolean | Date | Prisma.Decimal | null | undefined;

const text = (value: Cell): string => {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  return value.toString();
};

/** One CSV line (RFC 4180 quoting). */
export const csvLine = (cells: Cell[]) =>
  cells
    .map((cell) => {
      const value = text(cell);
      return /[",\n;]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
    })
    .join(',');

/** A CSV document with a UTF-8 BOM, so spreadsheet apps read accents correctly. */
export const csvDocument = (header: string[], rows: Cell[][]) =>
  `\uFEFF${[header.join(','), ...rows.map(csvLine)].join('\n')}`;
