import { PurchaseRequestStatus } from '@prisma/client';

// Public seller info. Never expose email / msisdn / passwordHash here.
export const sellerSelect = {
  id: true,
  firstname: true,
  lastname: true,
  createdAt: true,
} as const;

// A product's category, selected as its code only.
export const categoryCodeSelect = { select: { code: true } } as const;

// The API exposes a product's category as its code ("RACKET"), as it did when
// it was an enum, so clients don't have to know it is now a linked table row.
export function withCategoryCode<T extends { category: { code: string } }>(
  product: T,
): Omit<T, 'category'> & { category: string } {
  return { ...product, category: product.category.code };
}

// Fields shown in list items (and reused as the base of the detail view).
export const productSummarySelect = {
  id: true,
  title: true,
  price: true,
  category: categoryCodeSelect,
  condition: true,
  status: true,
  photos: true,
  city: true,
  createdAt: true,
  seller: { select: sellerSelect },
} as const;

export interface SellerContact {
  firstname: string;
  lastname: string;
  msisdn: string;
}

// Contact details are revealed only once the seller has accepted the request.
export function sellerContactFor(
  status: PurchaseRequestStatus,
  seller: SellerContact,
): SellerContact | null {
  if (status !== PurchaseRequestStatus.ACCEPTED) {
    return null;
  }
  return {
    firstname: seller.firstname,
    lastname: seller.lastname,
    msisdn: seller.msisdn,
  };
}
