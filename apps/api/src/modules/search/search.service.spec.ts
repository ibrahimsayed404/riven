import { BadRequestException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { FavorableType } from '@prisma/client';
import { MeiliSearchApiError, MeiliSearchRequestError } from 'meilisearch';

import { SearchIndexBootstrap } from '../../infra/search/search-index.bootstrap';
import { SearchIndexRegistry } from '../../infra/search/search-index.registry';
import { SocialService } from '../social/social.service';
import { SearchBazaarsQueryDto } from './dto/search-bazaars-query.dto';
import { SearchOverviewQueryDto } from './dto/search-overview-query.dto';
import { SearchProductsQueryDto } from './dto/search-products-query.dto';
import { SearchVendorsQueryDto } from './dto/search-vendors-query.dto';
import { SearchService } from './search.service';

const emptyResponse = { hits: [], estimatedTotalHits: 0 };

describe('SearchService', () => {
  let search: jest.Mock;
  let multiSearch: jest.Mock;
  let batchCheckFavorites: jest.Mock;
  let bootstrap: { ready: boolean };
  let service: SearchService;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    search = jest.fn().mockResolvedValue(emptyResponse);
    multiSearch = jest.fn().mockResolvedValue({ results: [] });
    batchCheckFavorites = jest.fn().mockResolvedValue(new Set<string>());
    bootstrap = { ready: true };

    const registry = {
      prefix: 'riven_test_',
      uid: (name: string) => `riven_test_${name}`,
      index: () => ({ search }),
      client: { multiSearch },
    } as unknown as SearchIndexRegistry;

    service = new SearchService(
      registry,
      bootstrap as SearchIndexBootstrap,
      { batchCheckFavorites } as unknown as SocialService,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  const lastSearchParams = () => search.mock.calls[search.mock.calls.length - 1][1];

  // ---------------------------------------------------------------------------
  // Availability
  // ---------------------------------------------------------------------------

  describe('availability', () => {
    it('returns 503 SEARCH_UNAVAILABLE when the index bootstrap never succeeded', async () => {
      bootstrap.ready = false;

      await expect(service.searchProducts({ q: 'dress' } as SearchProductsQueryDto)).rejects.toMatchObject({
        constructor: ServiceUnavailableException,
        response: { code: 'SEARCH_UNAVAILABLE' },
      });
      expect(search).not.toHaveBeenCalled();
    });

    it('maps a transport error to 503, never a 500', async () => {
      search.mockRejectedValue(new MeiliSearchRequestError('http://localhost:7700', new Error('ECONNREFUSED')));

      await expect(service.searchProducts({ q: 'dress' } as SearchProductsQueryDto)).rejects.toMatchObject({
        response: { code: 'SEARCH_UNAVAILABLE' },
      });
    });

    it('lets a Meilisearch API error (a bug in our query) surface unchanged', async () => {
      const apiError = new MeiliSearchApiError(new Response(null, { status: 400 }), {
        message: 'Invalid filter',
        code: 'invalid_search_filter',
        type: 'invalid_request',
        link: '',
      });
      search.mockRejectedValue(apiError);

      await expect(service.searchProducts({ q: 'dress' } as SearchProductsQueryDto)).rejects.toBe(apiError);
    });
  });

  // ---------------------------------------------------------------------------
  // Pagination
  // ---------------------------------------------------------------------------

  describe('pagination', () => {
    it('translates page/limit to offset/limit and echoes them in the envelope', async () => {
      search.mockResolvedValue({ hits: [], estimatedTotalHits: 57, processingTimeMs: 3, query: 'x' });

      const result = await service.searchProducts({ q: 'x', page: 3, limit: 20 } as SearchProductsQueryDto);

      expect(lastSearchParams()).toMatchObject({ offset: 40, limit: 20 });
      expect(result).toEqual({ hits: [], estimatedTotalHits: 57, page: 3, limit: 20 });
    });

    it('rejects a page at or beyond the 1000-hit window with 400 SEARCH_QUERY_INVALID', async () => {
      await expect(
        service.searchProducts({ q: 'x', page: 51, limit: 20 } as SearchProductsQueryDto),
      ).rejects.toMatchObject({ constructor: BadRequestException, response: { code: 'SEARCH_QUERY_INVALID' } });
      expect(search).not.toHaveBeenCalled();
    });

    it('clamps limit so the last window stays reachable', async () => {
      await service.searchProducts({ q: 'x', page: 20, limit: 50 } as SearchProductsQueryDto);
      expect(lastSearchParams()).toMatchObject({ offset: 950, limit: 50 });

      await service.searchProducts({ q: 'x', page: 34, limit: 30 } as SearchProductsQueryDto);
      // offset 990: only 10 hits remain inside the window.
      expect(lastSearchParams()).toMatchObject({ offset: 990, limit: 10 });
    });
  });

  // ---------------------------------------------------------------------------
  // Products
  // ---------------------------------------------------------------------------

  describe('searchProducts', () => {
    it('builds the price filter as a range overlap and sorts on minPrice', async () => {
      await service.searchProducts({
        q: 'dress',
        minPrice: 600,
        maxPrice: 900,
        sort: 'price:desc',
      } as SearchProductsQueryDto);

      expect(lastSearchParams()).toMatchObject({
        filter: 'maxPrice >= 600 AND minPrice <= 900',
        sort: ['minPrice:desc'],
      });
    });

    it('maps category (subtree) and categoryId (exact) to their attributes and quotes values', async () => {
      await service.searchProducts({
        q: 'dress',
        category: 'women',
        categoryId: 'cat-1',
        vendorId: 'v-1',
        size: 'M',
        color: 'Sa"nd',
      } as SearchProductsQueryDto);

      expect(lastSearchParams().filter).toBe(
        'vendorId = "v-1" AND categoryId = "cat-1" AND categoryPath = "women" AND sizes = "M" AND colors = "Sa\\"nd"',
      );
    });

    it('sends no filter and no sort when nothing is requested', async () => {
      await service.searchProducts({ q: 'dress' } as SearchProductsQueryDto);

      expect(lastSearchParams()).toEqual({ limit: 20, offset: 0 });
    });

    it('rejects maxPrice below minPrice', async () => {
      await expect(
        service.searchProducts({ q: 'x', minPrice: 900, maxPrice: 100 } as SearchProductsQueryDto),
      ).rejects.toMatchObject({ response: { code: 'SEARCH_QUERY_INVALID' } });
    });

    it('accepts and ignores coordinates but still rejects radiusKm without them', async () => {
      await service.searchProducts({ q: 'x', lat: 30, lng: 31, radiusKm: 5 } as SearchProductsQueryDto);
      expect(lastSearchParams()).toEqual({ limit: 20, offset: 0 });

      await expect(
        service.searchProducts({ q: 'x', radiusKm: 5 } as SearchProductsQueryDto),
      ).rejects.toMatchObject({ response: { code: 'SEARCH_QUERY_INVALID' } });
    });

    it('attaches isFavorite from one batch lookup when a user is present', async () => {
      search.mockResolvedValue({
        hits: [{ id: 'p1', title: 'A' }, { id: 'p2', title: 'B' }],
        estimatedTotalHits: 2,
      });
      batchCheckFavorites.mockResolvedValue(new Set(['p2']));

      const result = await service.searchProducts({ q: 'x' } as SearchProductsQueryDto, 'user-1');

      expect(batchCheckFavorites).toHaveBeenCalledTimes(1);
      expect(batchCheckFavorites).toHaveBeenCalledWith('user-1', FavorableType.PRODUCT, ['p1', 'p2']);
      expect(result.hits.map((hit) => hit.isFavorite)).toEqual([false, true]);
    });

    it('skips the favorites lookup for anonymous callers', async () => {
      search.mockResolvedValue({ hits: [{ id: 'p1' }], estimatedTotalHits: 1 });

      const result = await service.searchProducts({ q: 'x' } as SearchProductsQueryDto);

      expect(batchCheckFavorites).not.toHaveBeenCalled();
      expect(result.hits[0].isFavorite).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Vendors
  // ---------------------------------------------------------------------------

  describe('searchVendors', () => {
    it('applies _geoRadius with the default 25 km and sorts by _geoPoint', async () => {
      await service.searchVendors({ q: 'atelier', lat: 30.79, lng: 31 } as SearchVendorsQueryDto);

      expect(lastSearchParams()).toMatchObject({
        filter: '_geoRadius(30.79, 31, 25000)',
        sort: ['_geoPoint(30.79, 31):asc'],
      });
    });

    it('combines category/vendorType with an explicit radius', async () => {
      await service.searchVendors({
        q: 'x',
        category: 'FASHION',
        vendorType: 'BOTH',
        lat: 30,
        lng: 31,
        radiusKm: 2.5,
      } as SearchVendorsQueryDto);

      expect(lastSearchParams().filter).toBe(
        'category = "FASHION" AND vendorType = BOTH AND _geoRadius(30, 31, 2500)',
      );
    });

    it('strips _geo, maps _geoDistance to distanceMeters/distanceKm', async () => {
      search.mockResolvedValue({
        hits: [{ id: 'v1', name: 'A', _geo: { lat: 1, lng: 2 }, _geoDistance: 1234 }],
        estimatedTotalHits: 1,
      });

      const result = await service.searchVendors({ q: 'x', lat: 30, lng: 31 } as SearchVendorsQueryDto);

      expect(result.hits[0]).toEqual({
        id: 'v1',
        name: 'A',
        distanceMeters: 1234,
        distanceKm: 1.23,
        isFavorite: false,
      });
      expect(result.hits[0]).not.toHaveProperty('_geo');
    });

    it('reports null distance when no coordinates were supplied', async () => {
      search.mockResolvedValue({ hits: [{ id: 'v1', _geo: { lat: 1, lng: 2 } }], estimatedTotalHits: 1 });

      const result = await service.searchVendors({ q: 'x' } as SearchVendorsQueryDto);

      expect(result.hits[0]).toMatchObject({ distanceMeters: null, distanceKm: null });
      expect(lastSearchParams()).not.toHaveProperty('sort');
    });
  });

  // ---------------------------------------------------------------------------
  // Bazaars
  // ---------------------------------------------------------------------------

  describe('searchBazaars', () => {
    beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000));

    it('applies the upcoming filter by default, mirroring discovery (RECURRING kept, 1-day grace)', async () => {
      await service.searchBazaars({ q: 'winter', upcomingOnly: true } as SearchBazaarsQueryDto);

      expect(lastSearchParams().filter).toBe(
        '(scheduleType = RECURRING OR endDate >= 1700000000 OR (endDate IS NULL AND startDate >= 1699913600))',
      );
    });

    it('drops the upcoming clause when upcomingOnly=false and adds scheduleType + geo', async () => {
      await service.searchBazaars({
        q: 'x',
        upcomingOnly: false,
        scheduleType: 'ONE_OFF',
        lat: 30,
        lng: 31,
        radiusKm: 10,
      } as SearchBazaarsQueryDto);

      expect(lastSearchParams()).toMatchObject({
        filter: 'scheduleType = ONE_OFF AND _geoRadius(30, 31, 10000)',
        sort: ['_geoPoint(30, 31):asc'],
      });
    });

    it('converts unix-second dates back to ISO strings on the wire', async () => {
      search.mockResolvedValue({
        hits: [{ id: 'b1', startDate: 1_700_000_000, endDate: null, _geo: { lat: 1, lng: 2 } }],
        estimatedTotalHits: 1,
      });

      const result = await service.searchBazaars({ q: 'x' } as SearchBazaarsQueryDto);

      expect(result.hits[0]).toMatchObject({
        startDate: '2023-11-14T22:13:20.000Z',
        endDate: null,
        distanceMeters: null,
      });
      expect(result.hits[0]).not.toHaveProperty('_geo');
    });
  });

  // ---------------------------------------------------------------------------
  // Overview (grouped multi-index)
  // ---------------------------------------------------------------------------

  describe('searchAll', () => {
    it('issues one multi-search with one query per index, prefixed uids, and returns grouped results', async () => {
      multiSearch.mockResolvedValue({
        results: [
          { indexUid: 'riven_test_products', hits: [{ id: 'p1' }], estimatedTotalHits: 1 },
          { indexUid: 'riven_test_vendors', hits: [], estimatedTotalHits: 0 },
          { indexUid: 'riven_test_bazaars', hits: [], estimatedTotalHits: 0 },
        ],
      });

      const result = await service.searchAll({ q: 'dress', limit: 10 } as SearchOverviewQueryDto);

      expect(multiSearch).toHaveBeenCalledTimes(1);
      const queries = multiSearch.mock.calls[0][0].queries;
      expect(queries.map((query: { indexUid: string }) => query.indexUid)).toEqual([
        'riven_test_products',
        'riven_test_vendors',
        'riven_test_bazaars',
      ]);
      expect(queries[0]).toMatchObject({ q: 'dress', limit: 10, offset: 0 });
      expect(queries[2].filter).toMatch(/^\(scheduleType = RECURRING OR /);

      expect(Object.keys(result)).toEqual(['products', 'vendors', 'bazaars']);
      expect(result.products).toEqual({ hits: [{ id: 'p1', isFavorite: false }], estimatedTotalHits: 1, page: 1, limit: 10 });
    });

    it('only queries and returns the requested types', async () => {
      multiSearch.mockResolvedValue({
        results: [{ indexUid: 'riven_test_bazaars', hits: [], estimatedTotalHits: 0 }],
      });

      const result = await service.searchAll({ q: 'x', types: 'bazaars', limit: 5 } as SearchOverviewQueryDto);

      expect(multiSearch.mock.calls[0][0].queries).toHaveLength(1);
      expect(Object.keys(result)).toEqual(['bazaars']);
    });

    it('rejects an unknown type with 400 SEARCH_TYPE_INVALID', async () => {
      await expect(
        service.searchAll({ q: 'x', types: 'products,events' } as SearchOverviewQueryDto),
      ).rejects.toMatchObject({ response: { code: 'SEARCH_TYPE_INVALID' } });
      expect(multiSearch).not.toHaveBeenCalled();
    });

    it('passes geo to vendors and bazaars but not products', async () => {
      multiSearch.mockResolvedValue({
        results: [
          { hits: [], estimatedTotalHits: 0 },
          { hits: [], estimatedTotalHits: 0 },
          { hits: [], estimatedTotalHits: 0 },
        ],
      });

      await service.searchAll({ q: 'x', lat: 30, lng: 31 } as SearchOverviewQueryDto);

      const [products, vendors, bazaars] = multiSearch.mock.calls[0][0].queries;
      expect(products).not.toHaveProperty('filter');
      expect(products).not.toHaveProperty('sort');
      expect(vendors).toMatchObject({ filter: '_geoRadius(30, 31, 25000)', sort: ['_geoPoint(30, 31):asc'] });
      expect(bazaars.filter).toContain('_geoRadius(30, 31, 25000)');
      expect(bazaars.sort).toEqual(['_geoPoint(30, 31):asc']);
    });
  });
});
