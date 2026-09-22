import {
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedUser } from '../auth/jwt.strategy.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { CompetitionsService } from './competitions.service.js';
import { ListCompetitionsQueryDto } from './dto/list-competitions-query.dto.js';

@Controller('competitions')
@UseGuards(JwtAuthGuard)
export class CompetitionsController {
  constructor(private readonly competitionsService: CompetitionsService) {}

  @Get()
  list(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Query() query: ListCompetitionsQueryDto,
  ) {
    return this.competitionsService.list(currentUser.userId, query);
  }

  @Get(':id')
  findOne(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.competitionsService.findOne(currentUser.userId, id);
  }

  @Post(':id/register')
  register(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.competitionsService.register(currentUser.userId, id);
  }

  @Delete(':id/register')
  unregister(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.competitionsService.unregister(currentUser.userId, id);
  }
}
