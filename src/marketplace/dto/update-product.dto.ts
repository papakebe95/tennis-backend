import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ProductCondition, ProductStatus } from '@prisma/client';
import { MAX_PRODUCT_PRICE } from './create-product.dto.js';

// The only statuses an owner may set directly: mark sold, or re-list.
// RESERVED is driven by accepting a purchase request; REMOVED by DELETE.
export const OWNER_SETTABLE_STATUSES = [
  ProductStatus.AVAILABLE,
  ProductStatus.SOLD,
] as const;

export class UpdateProductDto {
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(80)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(MAX_PRODUCT_PRICE)
  price?: number;

  // A ProductCategory.code ("RACKET"); checked against the table in the service.
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  category?: string;

  @IsOptional()
  @IsEnum(ProductCondition)
  condition?: ProductCondition;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  @IsUrl({ require_tld: false }, { each: true })
  photos?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(60)
  city?: string;

  @IsOptional()
  @IsIn(OWNER_SETTABLE_STATUSES)
  status?: (typeof OWNER_SETTABLE_STATUSES)[number];
}
