import { Controller, Get, Param } from '@nestjs/common';
import { ClubsService } from './clubs.service.js';

@Controller('clubs')
export class ClubsController {
  constructor(private readonly clubsService: ClubsService) {}

  @Get()
  findAll() {
    return this.clubsService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.clubsService.findOneWithCourts(id);
  }
}
