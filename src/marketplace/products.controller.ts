import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedUser } from '../auth/jwt.strategy.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { CreateProductDto } from './dto/create-product.dto.js';
import { CreatePurchaseRequestDto } from './dto/create-purchase-request.dto.js';
import { ListProductsQueryDto } from './dto/list-products-query.dto.js';
import { UpdateProductDto } from './dto/update-product.dto.js';
import { ProductsService } from './products.service.js';
import { PurchaseRequestsService } from './purchase-requests.service.js';

@Controller('products')
@UseGuards(JwtAuthGuard)
export class ProductsController {
  constructor(
    private readonly productsService: ProductsService,
    private readonly purchaseRequestsService: PurchaseRequestsService,
  ) {}

  @Get()
  list(@Query() query: ListProductsQueryDto) {
    return this.productsService.list(query);
  }

  // Literal routes: must be declared before ':id' so they aren't read as one.
  @Get('categories')
  categories() {
    return this.productsService.categories();
  }

  @Get('mine')
  findMine(@CurrentUser() currentUser: AuthenticatedUser) {
    return this.productsService.findMine(currentUser.userId);
  }

  @Get(':id')
  findOne(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.productsService.findOne(currentUser.userId, id);
  }

  @Post()
  create(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Body() dto: CreateProductDto,
  ) {
    return this.productsService.create(currentUser.userId, dto);
  }

  @Patch(':id')
  update(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateProductDto,
  ) {
    return this.productsService.update(currentUser.userId, id, dto);
  }

  @Delete(':id')
  remove(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.productsService.remove(currentUser.userId, id);
  }

  @Post(':id/purchase-requests')
  createPurchaseRequest(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CreatePurchaseRequestDto,
  ) {
    return this.purchaseRequestsService.create(currentUser.userId, id, dto);
  }

  @Get(':id/purchase-requests')
  listPurchaseRequests(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.purchaseRequestsService.listForProduct(currentUser.userId, id);
  }
}
