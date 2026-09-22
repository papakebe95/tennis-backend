import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedUser } from '../auth/jwt.strategy.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { RespondPurchaseRequestDto } from './dto/respond-purchase-request.dto.js';
import { PurchaseRequestsService } from './purchase-requests.service.js';

@Controller('purchase-requests')
@UseGuards(JwtAuthGuard)
export class PurchaseRequestsController {
  constructor(
    private readonly purchaseRequestsService: PurchaseRequestsService,
  ) {}

  // Literal route: must be declared before ':id'.
  @Get('mine')
  findMine(@CurrentUser() currentUser: AuthenticatedUser) {
    return this.purchaseRequestsService.findMine(currentUser.userId);
  }

  @Patch(':id')
  respond(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: RespondPurchaseRequestDto,
  ) {
    return this.purchaseRequestsService.respond(currentUser.userId, id, dto);
  }

  @Delete(':id')
  cancel(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.purchaseRequestsService.cancel(currentUser.userId, id);
  }
}
