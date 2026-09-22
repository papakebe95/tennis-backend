import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ProductCondition } from '@prisma/client';

export const MAX_PRODUCT_PRICE = 100_000_000;

export class CreateProductDto {
  @IsString()
  @MinLength(3)
  @MaxLength(80)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(MAX_PRODUCT_PRICE)
  price!: number;

  // A ProductCategory.code ("RACKET"); checked against the table in the service.
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  category!: string;

  @IsEnum(ProductCondition)
  condition!: ProductCondition;

  // `require_tld: false` so locally-served upload URLs (http://localhost:3000/...)
  // are accepted.
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  @IsUrl({ require_tld: false }, { each: true })
  photos!: string[];

  @IsOptional()
  @IsString()
  @MaxLength(60)
  city?: string;
}
