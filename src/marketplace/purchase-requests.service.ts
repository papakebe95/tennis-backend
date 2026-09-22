import {
  ConflictException,
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
import {
  purchaseRequestAnswered,
  purchaseRequestReceived,
} from '../notifications/notification-messages.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { CreatePurchaseRequestDto } from './dto/create-purchase-request.dto.js';
import { RespondPurchaseRequestDto } from './dto/respond-purchase-request.dto.js';
import {
  categoryCodeSelect,
  sellerContactFor,
  withCategoryCode,
} from './marketplace.shared.js';

const ownerRequestSelect = {
  id: true,
  status: true,
  message: true,
  createdAt: true,
  buyer: {
    select: { id: true, firstname: true, lastname: true, msisdn: true },
  },
} as const;

type OwnerRequestRow = Prisma.PurchaseRequestGetPayload<{
  select: typeof ownerRequestSelect;
}>;

// Buyer's phone number is revealed to the seller only after acceptance.
function toOwnerRequest({ buyer, ...request }: OwnerRequestRow) {
  return {
    ...request,
    buyer: {
      id: buyer.id,
      firstname: buyer.firstname,
      lastname: buyer.lastname,
      msisdn:
        request.status === PurchaseRequestStatus.ACCEPTED ? buyer.msisdn : null,
    },
  };
}

@Injectable()
export class PurchaseRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async create(
    userId: string,
    productId: string,
    dto: CreatePurchaseRequestDto,
  ) {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { id: true, sellerId: true, status: true, title: true },
    });
    if (!product || product.status === ProductStatus.REMOVED) {
      throw new NotFoundException('Product not found');
    }
    if (product.sellerId === userId) {
      throw new ForbiddenException(
        'You cannot send a purchase request for your own product',
      );
    }
    if (product.status !== ProductStatus.AVAILABLE) {
      throw new ConflictException('This item is no longer available');
    }

    const existing = await this.prisma.purchaseRequest.findFirst({
      where: {
        productId,
        buyerId: userId,
        status: {
          in: [PurchaseRequestStatus.PENDING, PurchaseRequestStatus.ACCEPTED],
        },
      },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(
        'You already have an active purchase request for this item',
      );
    }

    const created = await this.prisma.purchaseRequest.create({
      data: { productId, buyerId: userId, message: dto.message },
      select: {
        id: true,
        productId: true,
        status: true,
        message: true,
        createdAt: true,
        buyer: { select: { firstname: true, lastname: true } },
      },
    });

    const { buyer, ...request } = created;
    await this.notifications.notify(
      product.sellerId,
      purchaseRequestReceived(
        productId,
        product.title,
        `${buyer.firstname} ${buyer.lastname}`.trim(),
      ),
    );
    return request;
  }

  async listForProduct(userId: string, productId: string) {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { sellerId: true, status: true },
    });
    if (!product || product.status === ProductStatus.REMOVED) {
      throw new NotFoundException('Product not found');
    }
    if (product.sellerId !== userId) {
      throw new ForbiddenException('You do not own this product');
    }

    const requests = await this.prisma.purchaseRequest.findMany({
      where: { productId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: ownerRequestSelect,
    });
    return requests.map(toOwnerRequest);
  }

  async respond(
    userId: string,
    requestId: string,
    dto: RespondPurchaseRequestDto,
  ) {
    const request = await this.prisma.purchaseRequest.findUnique({
      where: { id: requestId },
      select: {
        id: true,
        productId: true,
        buyerId: true,
        status: true,
        product: { select: { sellerId: true, title: true } },
      },
    });
    if (!request) {
      throw new NotFoundException('Purchase request not found');
    }
    if (request.product.sellerId !== userId) {
      throw new ForbiddenException(
        'Only the seller can respond to this purchase request',
      );
    }
    if (request.status !== PurchaseRequestStatus.PENDING) {
      throw new ConflictException('This purchase request is no longer pending');
    }

    if (dto.status === PurchaseRequestStatus.DECLINED) {
      const declined = await this.prisma.purchaseRequest.updateMany({
        where: { id: requestId, status: PurchaseRequestStatus.PENDING },
        data: { status: PurchaseRequestStatus.DECLINED },
      });
      if (declined.count === 0) {
        throw new ConflictException(
          'This purchase request is no longer pending',
        );
      }
      await this.notifications.notify(
        request.buyerId,
        purchaseRequestAnswered(request.productId, request.product.title, false),
      );
      return this.findOwnerRequest(requestId);
    }

    // ACCEPTED: reserve the product, accept this request and decline every
    // other pending one atomically. Each guarded updateMany re-checks its
    // precondition inside the transaction, so a concurrent accept/cancel makes
    // it throw and roll everything back.
    const autoDeclinedBuyerIds = await this.prisma.$transaction(async (tx) => {
      const reserved = await tx.product.updateMany({
        where: { id: request.productId, status: ProductStatus.AVAILABLE },
        data: { status: ProductStatus.RESERVED },
      });
      if (reserved.count === 0) {
        throw new ConflictException('This item is no longer available');
      }

      const accepted = await tx.purchaseRequest.updateMany({
        where: { id: requestId, status: PurchaseRequestStatus.PENDING },
        data: { status: PurchaseRequestStatus.ACCEPTED },
      });
      if (accepted.count === 0) {
        throw new ConflictException(
          'This purchase request is no longer pending',
        );
      }

      const othersWhere = {
        productId: request.productId,
        status: PurchaseRequestStatus.PENDING,
        id: { not: requestId },
      };
      const others = await tx.purchaseRequest.findMany({
        where: othersWhere,
        select: { buyerId: true },
      });
      await tx.purchaseRequest.updateMany({
        where: othersWhere,
        data: { status: PurchaseRequestStatus.DECLINED },
      });
      return others.map((o) => o.buyerId);
    });

    // After commit: the winner hears "accepted", everyone else "declined".
    await this.notifications.notify(
      request.buyerId,
      purchaseRequestAnswered(request.productId, request.product.title, true),
    );
    for (const buyerId of autoDeclinedBuyerIds) {
      await this.notifications.notify(
        buyerId,
        purchaseRequestAnswered(request.productId, request.product.title, false),
      );
    }

    return this.findOwnerRequest(requestId);
  }

  async cancel(userId: string, requestId: string) {
    const request = await this.prisma.purchaseRequest.findUnique({
      where: { id: requestId },
      select: { id: true, buyerId: true, status: true },
    });
    if (!request) {
      throw new NotFoundException('Purchase request not found');
    }
    if (request.buyerId !== userId) {
      throw new ForbiddenException('This is not your purchase request');
    }
    if (request.status !== PurchaseRequestStatus.PENDING) {
      throw new ConflictException('Only pending requests can be cancelled');
    }

    const cancelled = await this.prisma.purchaseRequest.updateMany({
      where: { id: requestId, status: PurchaseRequestStatus.PENDING },
      data: { status: PurchaseRequestStatus.CANCELLED },
    });
    if (cancelled.count === 0) {
      throw new ConflictException('Only pending requests can be cancelled');
    }
    return { id: requestId, status: PurchaseRequestStatus.CANCELLED };
  }

  async findMine(userId: string) {
    const requests = await this.prisma.purchaseRequest.findMany({
      where: { buyerId: userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        status: true,
        message: true,
        createdAt: true,
        product: {
          select: {
            id: true,
            title: true,
            price: true,
            photos: true,
            category: categoryCodeSelect,
            condition: true,
            status: true,
            seller: {
              select: { firstname: true, lastname: true, msisdn: true },
            },
          },
        },
      },
    });

    return requests.map(({ product: { seller, ...product }, ...request }) => ({
      ...request,
      product: withCategoryCode(product),
      sellerContact: sellerContactFor(request.status, seller),
    }));
  }

  private async findOwnerRequest(requestId: string) {
    const request = await this.prisma.purchaseRequest.findUniqueOrThrow({
      where: { id: requestId },
      select: ownerRequestSelect,
    });
    return toOwnerRequest(request);
  }
}
