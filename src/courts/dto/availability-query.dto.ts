import { IsDateString } from 'class-validator';

export class AvailabilityQueryDto {
  @IsDateString()
  date!: string;
}
