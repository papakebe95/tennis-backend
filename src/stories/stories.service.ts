import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class StoriesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Stories that have not expired yet, newest first. */
  list() {
    return this.prisma.story.findMany({
      where: { expiresAt: { gt: new Date() } },
      orderBy: { publishedAt: 'desc' },
      take: 20,
      select: {
        id: true,
        title: true,
        kind: true,
        coverUrl: true,
        slides: true,
        publishedAt: true,
      },
    });
  }
}
