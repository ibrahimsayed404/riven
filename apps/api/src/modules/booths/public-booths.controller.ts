import { Controller, Get, Param } from '@nestjs/common';
import { BoothsService } from './booths.service';

@Controller('bazaars/:bazaarId/layout')
export class PublicBoothsController {
  constructor(private readonly boothsService: BoothsService) {}

  @Get()
  getPublicLayout(@Param('bazaarId') bazaarId: string) {
    return this.boothsService.getPublicLayout(bazaarId);
  }
}
