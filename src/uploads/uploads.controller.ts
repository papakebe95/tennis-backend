import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Param,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedUser } from '../auth/jwt.strategy.js';
import { AuthzService } from '../authz/authz.service.js';
import type { PermissionKey } from '../authz/permissions.js';
import { holdsAnywhere } from '../authz/scope.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { UploadsService } from './uploads.service.js';
// See uploads.service.ts for why this type-only import is needed for
// Express.Multer.File to resolve under this project's tsconfig.
import type {} from 'multer';
import { t } from '../i18n/i18n.js';

// Small, fixed allowlist of upload contexts - anything else is rejected
// rather than letting the client write into an arbitrary folder name.
const ALLOWED_UPLOAD_FOLDERS = ['clubs', 'courts', 'avatars', 'products', 'organizations', 'tournaments'] as const;
type Folder = (typeof ALLOWED_UPLOAD_FOLDERS)[number];

// Back-office folders take one of these permissions (held anywhere; saving
// the image on a record checks the exact scope). Players' own folders are
// open to any signed-in user.
const FOLDER_PERMISSIONS: Record<Folder, readonly PermissionKey[]> = {
  clubs: ['club.update'],
  courts: ['court.manage'],
  organizations: ['organization.create', 'organization.manage', 'federation.update', 'club.update'],
  tournaments: ['tournament.create', 'tournament.update'],
  avatars: [],
  products: [],
};

@Controller('uploads')
@UseGuards(JwtAuthGuard)
export class UploadsController {
  constructor(
    private readonly uploadsService: UploadsService,
    private readonly authz: AuthzService,
  ) {}

  @Post(':folder')
  @UseInterceptors(FileInterceptor('file'))
  async upload(
    @CurrentUser() user: AuthenticatedUser,
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

    const required = FOLDER_PERMISSIONS[folder as Folder];
    if (required.length) {
      const grants = await this.authz.loadGrants(user.userId);
      if (!required.some((permission) => holdsAnywhere(grants, permission))) {
        throw new ForbiddenException({ message: t('errors.uploads.folderForbidden'), code: 'FORBIDDEN' });
      }
    }

    const { url } = await this.uploadsService.save(file, folder);
    return { url };
  }
}
