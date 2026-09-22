import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedUser } from '../auth/jwt.strategy.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { CreateMatchDto } from './dto/create-match.dto.js';
import { ListMatchesQueryDto } from './dto/list-matches-query.dto.js';
import { MatchesService } from './matches.service.js';

@Controller('matches')
@UseGuards(JwtAuthGuard)
export class MatchesController {
  constructor(private readonly matchesService: MatchesService) {}

  @Get()
  list(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Query() query: ListMatchesQueryDto,
  ) {
    return this.matchesService.list(currentUser.userId, query);
  }

  // Literal route: declared before ':id' so "summary" isn't read as an id.
  @Get('summary')
  summary(@CurrentUser() currentUser: AuthenticatedUser) {
    return this.matchesService.summary(currentUser.userId);
  }

  @Get(':id')
  findOne(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.matchesService.findOne(currentUser.userId, id);
  }

  @Post()
  create(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Body() dto: CreateMatchDto,
  ) {
    return this.matchesService.create(currentUser.userId, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<void> {
    await this.matchesService.remove(currentUser.userId, id);
  }
}
