import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { StoriesController } from './stories.controller.js';
import { StoriesService } from './stories.service.js';

@Module({
  imports: [PassportModule.register({ defaultStrategy: 'jwt' })],
  controllers: [StoriesController],
  providers: [StoriesService],
})
export class StoriesModule {}
