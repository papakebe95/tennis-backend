import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  ProductStatus,
  PurchaseRequestStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateProductDto } from './dto/create-product.dto.js';
import { ListProductsQueryDto } from './dto/list-products-query.dto.js';
import { UpdateProductDto } from './dto/update-product.dto.js';
import {
  productSummarySelect,
  sellerContactFor,
  withCategoryCode,
} from './marketplace.shared.js';
import { t } from '../i18n/i18n.js';
import { localize } from '../i18n/localize.js';

const PUBLIC_STATUSES: ProductStatus[] = [
  ProductStatus.AVAILABLE,
  ProductStatus.RESERVED,
];

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  // The marketplace's categories, in display order. `value` is the code that
  // products carry and that create/update/list accept.
  async categories() {
    const categories = await this.prisma.productCategory.findMany({
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
      select: { code: true, label: true, icon: true, translations: true },
    });
    return categories.map((category) => localize(category)).map(({ code, label, icon }) => ({
      value: code,
      label,
      icon,
    }));
  }

  async list(query: ListProductsQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const q = query.q?.trim();

    const where: Prisma.ProductWhereInput = {
      status: { in: PUBLIC_STATUSES },
      ...(query.category && { category: { code: query.category } }),
      ...(query.condition && { condition: query.condition }),
      ...(q && {
        OR: [
          { title: { contains: q, mode: 'insensitive' } },
          { description: { contains: q, mode: 'insensitive' } },
        ],
      }),
    };

    // Secondary sort by id keeps pagination stable when the primary key ties.
    const orderBy: Prisma.ProductOrderByWithRelationInput[] =
      query.sort === 'price_asc'
        ? [{ price: 'asc' }, { id: 'asc' }]
        : query.sort === 'price_desc'
          ? [{ price: 'desc' }, { id: 'asc' }]
          : [{ createdAt: 'desc' }, { id: 'asc' }];

    const [total, items] = await this.prisma.$transaction([
      this.prisma.product.count({ where }),
      this.prisma.product.findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: productSummarySelect,
      }),
    ]);

    return {
      items: items.map(withCategoryCode),
      page,
      pageSize,
      total,
      hasMore: page * pageSize < total,
    };
  }

  async findMine(userId: string) {
    const products = await this.prisma.product.findMany({
      where: { sellerId: userId, status: { not: ProductStatus.REMOVED } },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      select: {
        ...productSummarySelect,
        _count: {
          select: {
            requests: { where: { status: PurchaseRequestStatus.PENDING } },
          },
        },
      },
    });

    return products.map(({ _count, ...product }) => ({
      ...withCategoryCode(product),
      pendingRequestsCount: _count.requests,
    }));
  }

  async findOne(userId: string, productId: string) {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: {
        ...productSummarySelect,
        description: true,
        updatedAt: true,
      },
    });
    if (!product || product.status === ProductStatus.REMOVED) {
      throw new NotFoundException(t('errors.products.notFound'));
    }

    const request = await this.prisma.purchaseRequest.findFirst({
      where: { productId, buyerId: userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        status: true,
        message: true,
        createdAt: true,
        product: {
          select: {
            seller: {
              select: { firstname: true, lastname: true, msisdn: true },
            },
          },
        },
      },
    });

    return {
      ...withCategoryCode(product),
      isOwner: product.seller.id === userId,
      myPurchaseRequest: request
        ? {
            id: request.id,
            status: request.status,
            message: request.message,
            createdAt: request.createdAt,
            sellerContact: sellerContactFor(
              request.status,
              request.product.seller,
            ),
          }
        : null,
    };
  }

  async create(userId: string, dto: CreateProductDto) {
    const categoryId = await this.categoryIdFor(dto.category);
    const product = await this.prisma.product.create({
      data: {
        sellerId: userId,
        title: dto.title,
        description: dto.description,
        price: dto.price,
        categoryId,
        condition: dto.condition,
        photos: dto.photos,
        city: dto.city,
        status: ProductStatus.AVAILABLE,
      },
      select: productSummarySelect,
    });
    return withCategoryCode(product);
  }

  async update(userId: string, productId: string, dto: UpdateProductDto) {
    await this.assertOwnedAndActive(userId, productId);
    const categoryId =
      dto.category === undefined
        ? undefined
        : await this.categoryIdFor(dto.category);

    const product = await this.prisma.product.update({
      where: { id: productId },
      data: {
        title: dto.title,
        description: dto.description,
        price: dto.price,
        categoryId,
        condition: dto.condition,
        photos: dto.photos,
        city: dto.city,
        status: dto.status,
      },
      select: productSummarySelect,
    });
    return withCategoryCode(product);
  }

  async remove(userId: string, productId: string) {
    await this.assertOwnedAndActive(userId, productId);

    return this.prisma.product.update({
      where: { id: productId },
      data: { status: ProductStatus.REMOVED },
      select: { id: true, status: true },
    });
  }

  // Resolves a category code to its row; 400 for a code that isn't a category.
  private async categoryIdFor(code: string) {
    const category = await this.prisma.productCategory.findUnique({
      where: { code },
      select: { id: true },
    });
    if (!category) {
      throw new BadRequestException(t('errors.products.unknownCategory', { code }));
    }
    return category.id;
  }

  // 404 if the product doesn't exist / was removed, 403 if not the seller.
  private async assertOwnedAndActive(userId: string, productId: string) {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { id: true, sellerId: true, status: true },
    });
    if (!product || product.status === ProductStatus.REMOVED) {
      throw new NotFoundException(t('errors.products.notFound'));
    }
    if (product.sellerId !== userId) {
      throw new ForbiddenException(t('errors.products.notOwner'));
    }
    return product;
  }
}
