import { BadRequestException, Injectable } from '@nestjs/common';
import { t } from '../i18n/i18n.js';
import { UploadsService } from './uploads.service.js';

/** One image URL, a list of them, or nothing. */
export type MediaRefs = string | null | undefined | readonly (string | null | undefined)[];

const urls = (refs: MediaRefs): string[] =>
  (Array.isArray(refs) ? refs : [refs]).filter((u): u is string => typeof u === 'string' && u.length > 0);

/**
 * Rules for images saved on records (logos, banners, photos, avatars):
 * - a newly set image must be one uploaded here (our Cloudflare R2 bucket),
 *   so records can't point at arbitrary third-party URLs; images already on
 *   the record (e.g. seeded ones) may stay;
 * - once a change is saved, our images it no longer uses are deleted from
 *   the bucket.
 * Every image URL is unique (a new key per upload), so an image dropped from
 * its record is used nowhere else — except a club's logo, which its
 * organization shares and which both update together.
 */
@Injectable()
export class MediaService {
  constructor(private readonly uploads: UploadsService) {}

  /** Throws when `after` brings in an image that isn't ours. */
  assertOwn(before: MediaRefs, after: MediaRefs) {
    const existing = new Set(urls(before));
    const foreign = urls(after).filter((u) => !existing.has(u) && !this.uploads.keyOf(u));
    if (foreign.length) {
      throw new BadRequestException({ message: t('errors.uploads.foreignUrl'), code: 'MEDIA_NOT_UPLOADED' });
    }
  }

  /** After a successful save: deletes our images in `before` that `after` dropped. */
  async release(before: MediaRefs, after: MediaRefs) {
    const kept = new Set(urls(after));
    const keys = urls(before)
      .filter((u) => !kept.has(u))
      .map((u) => this.uploads.keyOf(u))
      .filter((k): k is string => !!k);
    await this.uploads.remove([...new Set(keys)]);
  }
}
