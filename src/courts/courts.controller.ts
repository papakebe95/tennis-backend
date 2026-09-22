import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { CourtsService } from './courts.service.js';
import { AvailabilityQueryDto } from './dto/availability-query.dto.js';

@Controller('courts')
export class CourtsController {
  constructor(private readonly courtsService: CourtsService) {}

  // Guarded: booked slots now surface the booker's identity (and, when they
  // opted in to partner-finding, their phone number), so this can no longer
  // be anonymous.
  @Get(':id/availability')
  @UseGuards(JwtAuthGuard)
  getAvailability(
    @Param('id') id: string,
    @Query() query: AvailabilityQueryDto,
  ) {
    return this.courtsService.findAvailability(id, query.date);
  }
}
