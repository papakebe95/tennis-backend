import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedUser } from '../auth/jwt.strategy.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { CreatePhoneDto, UpdatePhoneDto } from './dto/phone.dto.js';
import { RankingQueryDto } from './dto/ranking-query.dto.js';
import { UpdateProfileDto } from './dto/update-profile.dto.js';
import { UsersService } from './users.service.js';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  @UseGuards(JwtAuthGuard)
  getMe(@CurrentUser() currentUser: AuthenticatedUser) {
    return this.usersService.getMeWithProfile(currentUser.userId);
  }

  @Patch('me')
  @UseGuards(JwtAuthGuard)
  updateMe(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.usersService.updateMe(currentUser.userId, dto);
  }

  @Get('me/ranking')
  @UseGuards(JwtAuthGuard)
  ranking(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Query() query: RankingQueryDto,
  ) {
    return this.usersService.ranking(currentUser.userId, query.year);
  }

  @Post('me/phones')
  @UseGuards(JwtAuthGuard)
  addPhone(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Body() dto: CreatePhoneDto,
  ) {
    return this.usersService.addPhone(currentUser.userId, dto);
  }

  @Patch('me/phones/:id')
  @UseGuards(JwtAuthGuard)
  updatePhone(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdatePhoneDto,
  ) {
    return this.usersService.updatePhone(currentUser.userId, id, dto.label);
  }

  @Post('me/phones/:id/primary')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  makePrimary(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.usersService.makePhonePrimary(currentUser.userId, id);
  }

  // Returns the refreshed profile (not 204) so the client needs no refetch.
  @Delete('me/phones/:id')
  @UseGuards(JwtAuthGuard)
  removePhone(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.usersService.removePhone(currentUser.userId, id);
  }

  // Player lookup for picking an opponent. Returns names only.
  @Get('search')
  @UseGuards(JwtAuthGuard)
  search(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Query('q') q?: string,
  ) {
    return this.usersService.search(currentUser.userId, q ?? '');
  }
}
