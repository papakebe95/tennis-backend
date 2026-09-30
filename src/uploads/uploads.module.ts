import { Global, Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { UploadsController } from './uploads.controller.js';
import { MediaService } from './media.service.js';
import { UploadsService } from './uploads.service.js';

// Global: any module saving images uses MediaService.
@Global()
@Module({
  imports: [PassportModule.register({ defaultStrategy: 'jwt' })],
  controllers: [UploadsController],
  providers: [UploadsService, MediaService],
  exports: [UploadsService, MediaService],
})
export class UploadsModule {}
