import { IsOptional, IsString } from 'class-validator';

export class RefreshTokenDto {
  // Optional for browser clients, whose refresh token travels in an
  // httpOnly cookie instead (see AuthController).
  @IsOptional()
  @IsString()
  refreshToken?: string;
}
