import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { currentRequestContext } from '../common/request-context.js';
import { PrismaService } from '../prisma/prisma.service.js';

export interface AuditEntry {
  actorId: string | null;
  /** Dotted verb, e.g. "user.password.changed", "tournament.draw.published". */
  action: string;
  entityType: string;
  entityId: string;
  organizationId?: string | null;
  competitionId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
}

// Never written to the log, whatever entity is being described.
const SECRET_KEYS = new Set(['passwordHash', 'password', 'tokenHash', 'refreshToken', 'accessToken']);

/** Deep copy of `value` with secrets replaced, safe to store as JSON. */
export function redact(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Prisma.Decimal) return value.toString();
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, v]) => [
        key,
        SECRET_KEYS.has(key) ? '[redacted]' : redact(v),
      ]),
    );
  }
  return value;
}

type Db = Pick<Prisma.TransactionClient, 'auditLog'>;

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records an entry. Pass the transaction client when the change is made in
   * a transaction, so the change and its audit row commit (or not) together.
   */
  async record(entry: AuditEntry, db: Db = this.prisma): Promise<void> {
    const context = currentRequestContext();
    const json = (v: unknown) =>
      v === undefined ? undefined : ((redact(v) ?? Prisma.JsonNull) as Prisma.InputJsonValue);
    await db.auditLog.create({
      data: {
        actorId: entry.actorId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        organizationId: entry.organizationId ?? null,
        competitionId: entry.competitionId ?? null,
        before: json(entry.before),
        after: json(entry.after),
        reason: entry.reason ?? null,
        ip: context?.ip ?? null,
        userAgent: context?.userAgent ?? null,
      },
    });
  }
}
