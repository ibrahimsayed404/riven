// Decorators need the metadata polyfill; NestJS loads it for us everywhere else.
import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { ReindexDto } from './reindex.dto';
import { SearchBazaarsQueryDto } from './search-bazaars-query.dto';
import { SearchOverviewQueryDto } from './search-overview-query.dto';
import { SearchProductsQueryDto } from './search-products-query.dto';

// Query strings arrive as strings; mirrors ValidationPipe({ transform: true }).
async function check<T extends object>(cls: new () => T, query: Record<string, string>) {
  const dto = plainToInstance(cls, query);
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  return { dto, errors: errors.flatMap((e) => Object.keys(e.constraints ?? {})) };
}

describe('search query DTOs', () => {
  it('requires q, trims it, and caps it at 100 chars', async () => {
    expect((await check(SearchProductsQueryDto, {})).errors).toContain('isLength');
    expect((await check(SearchProductsQueryDto, { q: '   ' })).errors).toContain('isLength');
    expect((await check(SearchProductsQueryDto, { q: 'x'.repeat(101) })).errors).toContain('isLength');

    const { dto, errors } = await check(SearchProductsQueryDto, { q: '  فستان  ' });
    expect(errors).toEqual([]);
    expect(dto.q).toBe('فستان');
  });

  it('coerces page/limit to numbers with defaults and bounds', async () => {
    const { dto, errors } = await check(SearchProductsQueryDto, { q: 'x', page: '3', limit: '25' });
    expect(errors).toEqual([]);
    expect(dto.page).toBe(3);
    expect(dto.limit).toBe(25);

    const defaults = (await check(SearchProductsQueryDto, { q: 'x' })).dto;
    expect(defaults.page).toBe(1);
    expect(defaults.limit).toBe(20);

    expect((await check(SearchProductsQueryDto, { q: 'x', limit: '51' })).errors).toContain('max');
    expect((await check(SearchProductsQueryDto, { q: 'x', page: '0' })).errors).toContain('min');
  });

  it('requires lat and lng together', async () => {
    expect((await check(SearchBazaarsQueryDto, { q: 'x', lat: '30' })).errors).toContain('isNumber');
    expect((await check(SearchBazaarsQueryDto, { q: 'x', lng: '31' })).errors).toContain('isNumber');
    expect((await check(SearchBazaarsQueryDto, { q: 'x', lat: '91', lng: '31' })).errors).toContain('max');
    expect((await check(SearchBazaarsQueryDto, { q: 'x', lat: '30', lng: '31' })).errors).toEqual([]);
  });

  it('bounds radiusKm to 1..150', async () => {
    expect((await check(SearchBazaarsQueryDto, { q: 'x', lat: '30', lng: '31', radiusKm: '0.5' })).errors).toContain('min');
    expect((await check(SearchBazaarsQueryDto, { q: 'x', lat: '30', lng: '31', radiusKm: '151' })).errors).toContain('max');
  });

  it('rejects unknown query params (forbidNonWhitelisted)', async () => {
    expect((await check(SearchProductsQueryDto, { q: 'x', approvalStatus: 'PENDING' })).errors).toContain('whitelistValidation');
  });

  it('validates product filters: uuids, price >= 0, sort enum', async () => {
    expect((await check(SearchProductsQueryDto, { q: 'x', vendorId: 'not-a-uuid' })).errors).toContain('isUuid');
    expect((await check(SearchProductsQueryDto, { q: 'x', minPrice: '-1' })).errors).toContain('min');
    expect((await check(SearchProductsQueryDto, { q: 'x', sort: 'name:asc' })).errors).toContain('isIn');

    const ok = await check(SearchProductsQueryDto, {
      q: 'x',
      vendorId: '3f2b9e2a-1d4b-4c0f-9d9d-9c6b7a1e2f30',
      category: 'women',
      minPrice: '500',
      maxPrice: '900',
      sort: 'price:asc',
    });
    expect(ok.errors).toEqual([]);
    expect(ok.dto.minPrice).toBe(500);
  });

  it('parses upcomingOnly as a strict boolean with default true', async () => {
    expect((await check(SearchBazaarsQueryDto, { q: 'x' })).dto.upcomingOnly).toBe(true);
    expect((await check(SearchBazaarsQueryDto, { q: 'x', upcomingOnly: 'false' })).dto.upcomingOnly).toBe(false);
    expect((await check(SearchBazaarsQueryDto, { q: 'x', upcomingOnly: 'yes' })).errors).toContain('isBoolean');
    expect((await check(SearchBazaarsQueryDto, { q: 'x', scheduleType: 'WEEKLY' })).errors).toContain('isEnum');
  });

  it('overview limit is per-type and capped at 20, types is a free string (validated in the service)', async () => {
    expect((await check(SearchOverviewQueryDto, { q: 'x', limit: '21' })).errors).toContain('max');
    const { dto, errors } = await check(SearchOverviewQueryDto, { q: 'x', types: 'products,bazaars' });
    expect(errors).toEqual([]);
    expect(dto.limit).toBe(10);
    expect(dto.types).toBe('products,bazaars');
  });

  it('reindex body accepts only known index names, no duplicates', async () => {
    const good = plainToInstance(ReindexDto, { types: ['products', 'bazaars'] });
    expect(await validate(good)).toEqual([]);

    const bad = plainToInstance(ReindexDto, { types: ['products', 'events'] });
    expect((await validate(bad)).flatMap((e) => Object.keys(e.constraints ?? {}))).toContain('isIn');

    const dup = plainToInstance(ReindexDto, { types: ['products', 'products'] });
    expect((await validate(dup)).flatMap((e) => Object.keys(e.constraints ?? {}))).toContain('arrayUnique');
  });
});
