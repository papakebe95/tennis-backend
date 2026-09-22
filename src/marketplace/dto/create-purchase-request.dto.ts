import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CreatePurchaseRequestDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  message?: string;
}
