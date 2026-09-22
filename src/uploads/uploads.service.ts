import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
// Type-only import: pulls in @types/multer's `declare global { namespace
// Express { namespace Multer { ... } } }` augmentation so Express.Multer.File
// resolves below, without a runtime `require('multer')`. The project's
// tsconfig `types` array is an explicit allowlist (only vitest/globals +
// node), so this ambient type wouldn't otherwise be picked up automatically.
import type {} from 'multer';

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

// mimetype -> file extension. Only these image types are accepted; the
// extension is derived from the (validated) mimetype rather than trusted
// from the client-supplied original filename.
const ALLOWED_MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export interface SavedUpload {
  url: string;
  path: string;
}

// Local-disk implementation of file storage. Everything storage-specific
// (where bytes land, how the URL is built) lives in this one class - swapping
// to S3/Cloudinary later means replacing this class's internals, not
// touching UploadsController or any other caller.
@Injectable()
export class UploadsService {
  private readonly uploadsRoot = join(process.cwd(), 'uploads');

  constructor(private readonly configService: ConfigService) {}

  async save(file: Express.Multer.File, folder: string): Promise<SavedUpload> {
    if (!file) {
      throw new BadRequestException('No file provided');
    }

    const extension = ALLOWED_MIME_EXTENSIONS[file.mimetype];
    if (!extension) {
      throw new BadRequestException(
        `Unsupported file type "${file.mimetype}". Allowed types: ${Object.keys(ALLOWED_MIME_EXTENSIONS).join(', ')}`,
      );
    }

    if (file.size > MAX_FILE_SIZE_BYTES) {
      throw new BadRequestException(
        `File too large: max size is ${MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB`,
      );
    }

    const targetDir = join(this.uploadsRoot, folder);
    if (!existsSync(targetDir)) {
      await mkdir(targetDir, { recursive: true });
    }

    const filename = `${randomUUID()}.${extension}`;
    const diskPath = join(targetDir, filename);
    await writeFile(diskPath, file.buffer);

    const baseUrl =
      this.configService.get<string>('APP_BASE_URL') ??
      `http://localhost:${this.configService.get<string>('PORT') ?? 3000}`;

    return {
      url: `${baseUrl}/uploads/${folder}/${filename}`,
      path: diskPath,
    };
  }
}
