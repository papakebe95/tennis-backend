import { randomUUID } from 'node:crypto';
import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
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

// Cloudflare R2 (S3-compatible) implementation of file storage. Everything
// storage-specific (where bytes land, how the URL is built) lives in this one
// class - swapping providers later means replacing this class's internals,
// not touching UploadsController or any other caller.
@Injectable()
export class UploadsService {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicUrl: string;

  constructor(private readonly configService: ConfigService) {
    this.bucket = this.configService.getOrThrow<string>('R2_BUCKET_NAME');
    this.publicUrl = this.configService.getOrThrow<string>('R2_PUBLIC_URL').replace(/\/$/, '');
    this.client = new S3Client({
      region: 'auto',
      endpoint: this.configService.getOrThrow<string>('R2_ENDPOINT'),
      credentials: {
        accessKeyId: this.configService.getOrThrow<string>('R2_ACCESS_KEY_ID'),
        secretAccessKey: this.configService.getOrThrow<string>('R2_SECRET_ACCESS_KEY'),
      },
    });
  }

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

    const key = `${folder}/${randomUUID()}.${extension}`;

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
      }),
    );

    return {
      url: `${this.publicUrl}/${key}`,
      path: key,
    };
  }
}
