import { IsIn } from 'class-validator';
import { PurchaseRequestStatus } from '@prisma/client';

export const SELLER_RESPONSE_STATUSES = [
  PurchaseRequestStatus.ACCEPTED,
  PurchaseRequestStatus.DECLINED,
] as const;

export class RespondPurchaseRequestDto {
  @IsIn(SELLER_RESPONSE_STATUSES)
  status!: (typeof SELLER_RESPONSE_STATUSES)[number];
}
