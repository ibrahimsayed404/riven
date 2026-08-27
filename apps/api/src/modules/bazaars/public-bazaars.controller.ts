import { Controller, Get, Param, Query } from '@nestjs/common';
import { BazaarsService } from './bazaars.service';
import { ListBazaarsQueryDto } from './dto/list-bazaars-query.dto';

@Controller('bazaars')
export class PublicBazaarsController {
  constructor(private readonly bazaarsService: BazaarsService) {}

  @Get()
  getBazaars(@Query() query: ListBazaarsQueryDto) {
    const { page = 1, limit = 10, ...filters } = query;
    return this.bazaarsService.getPublicBazaars(page, limit, filters);
  }

  @Get(':id')
  getBazaar(@Param('id') id: string) {
    return this.bazaarsService.getPublicBazaarById(id);
  }
}
