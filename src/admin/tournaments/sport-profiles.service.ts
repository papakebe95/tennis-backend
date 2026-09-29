import { Injectable, NotFoundException } from '@nestjs/common';
import { PlayerLevel } from '@prisma/client';
import { AuditService } from '../../audit/audit.service.js';
import { t } from '../../i18n/i18n.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { SportProfileDto } from './tournaments.dto.js';

/**
 * The national classification scale and each player's sport identity
 * (classification, gender, birth date), which tournament eligibility reads.
 * Set by the federation, not by players.
 */
@Injectable()
export class SportProfilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  classifications() {
    return this.prisma.classification.findMany({
      orderBy: { rank: 'asc' },
      select: { id: true, code: true, label: true, rank: true, series: true },
    });
  }

  async update(actorId: string, userId: string, dto: SportProfileDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, playerProfile: { select: { gender: true, birthDate: true, classificationId: true } } },
    });
    if (!user) throw new NotFoundException(t('errors.tournaments.playerNotFound'));
    if (dto.classificationId) {
      const exists = await this.prisma.classification.count({ where: { id: dto.classificationId } });
      if (!exists) throw new NotFoundException(t('errors.tournaments.classificationNotFound'));
    }
    const data = {
      ...(dto.classificationId !== undefined ? { classificationId: dto.classificationId } : {}),
      ...(dto.gender !== undefined ? { gender: dto.gender } : {}),
      ...(dto.birthDate !== undefined ? { birthDate: dto.birthDate } : {}),
    };
    return this.prisma.$transaction(async (tx) => {
      const profile = await tx.playerProfile.upsert({
        where: { userId },
        update: data,
        // Accounts made from the back-office may have no player profile yet.
        create: { userId, level: PlayerLevel.BEGINNER, ...data },
        select: { gender: true, birthDate: true, classification: { select: { id: true, code: true } } },
      });
      await this.audit.record(
        {
          actorId,
          action: 'player.sport_profile.updated',
          entityType: 'User',
          entityId: userId,
          before: user.playerProfile,
          after: data,
        },
        tx,
      );
      return profile;
    });
  }
}
