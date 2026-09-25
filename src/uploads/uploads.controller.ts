import {
  BadRequestException,
  Controller,
  Param,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { UploadsService } from './uploads.service.js';
// See uploads.service.ts for why this type-only import is needed for
// Express.Multer.File to resolve under this project's tsconfig.
import type {} from 'multer';
import { t } from '../i18n/i18n.js';

// Small, fixed allowlist of upload contexts - anything else is rejected
// rather than letting the client write into an arbitrary folder name.
const ALLOWED_UPLOAD_FOLDERS = ['clubs', 'courts', 'avatars', 'products'] as const;

@Controller('uploads')
@UseGuards(JwtAuthGuard)
export class UploadsController {
  constructor(private readonly uploadsService: UploadsService) {}

  @Post(':folder')
  @UseInterceptors(FileInterceptor('file'))
  async upload(
    @Param('folder') folder: string,
    @UploadedFile() file: Express.Multer.File,
  ): Promise<{ url: string }> {
    if (!ALLOWED_UPLOAD_FOLDERS.includes(folder as (typeof ALLOWED_UPLOAD_FOLDERS)[number])) {
      throw new BadRequestException(
        t('errors.uploads.invalidFolder', {
          folder,
          allowed: ALLOWED_UPLOAD_FOLDERS.join(', '),
        }),
      );
    }

    const { url } = await this.uploadsService.save(file, folder);
    return { url };
  }
}
