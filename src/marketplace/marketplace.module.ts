import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { ProductsController } from './products.controller.js';
import { ProductsService } from './products.service.js';
import { PurchaseRequestsController } from './purchase-requests.controller.js';
import { PurchaseRequestsService } from './purchase-requests.service.js';
import { NotificationsModule } from '../notifications/notifications.module.js';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    NotificationsModule,
  ],
  controllers: [ProductsController, PurchaseRequestsController],
  providers: [ProductsService, PurchaseRequestsService],
  exports: [ProductsService, PurchaseRequestsService],
})
export class MarketplaceModule {}
