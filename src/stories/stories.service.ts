import { Injectable } from '@nestjs/common';
import { localize } from '../i18n/localize.js';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class StoriesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Stories that have not expired yet, newest first. */
  async list() {
    const stories = await this.prisma.story.findMany({
      where: { expiresAt: { gt: new Date() } },
      orderBy: { publishedAt: 'desc' },
      take: 20,
      select: {
        id: true,
        title: true,
        kind: true,
        coverUrl: true,
        slides: true,
        translations: true,
        publishedAt: true,
      },
    });
    return stories.map((story) => localize(story));
  }
}
