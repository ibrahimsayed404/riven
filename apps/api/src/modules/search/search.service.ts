import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { FavorableType } from '@prisma/client';
import { MeiliSearchApiError, MeiliSearchError, SearchParams } from 'meilisearch';

import { SearchIndexBootstrap } from '../../infra/search/search-index.bootstrap';
import { SEARCH_INDEXES, SEARCH_MAX_TOTAL_HITS, SearchIndexName } from '../../infra/search/search-index.config';
import { SearchIndexRegistry } from '../../infra/search/search-index.registry';
import {
  BazaarSearchDocument,
  ProductSearchDocument,
  VendorSearchDocument,
} from '../../infra/search/search-documents';
import { SocialService } from '../social/social.service';
import { SEARCH_DEFAULT_RADIUS_KM } from './dto/search-base-query.dto';
import { SearchBazaarsQueryDto } from './dto/search-bazaars-query.dto';
import { SearchOverviewQueryDto } from './dto/search-overview-query.dto';
import { SearchProductsQueryDto } from './dto/search-products-query.dto';
import { SearchVendorsQueryDto } from './dto/search-vendors-query.dto';

/**
 * The only fields of a Meilisearch response that reach the client. page/limit
 * echo the validated query; everything else Meilisearch returns is dropped.
 */
export type SearchResult<T> = {
  hits: T[];
  estimatedTotalHits: number;
  page: number;
  limit: number;
};

type WithDistance = { distanceMeters: number | null; distanceKm: number | null };
type WithFavorite = { isFavorite: boolean };

export type ProductHit = ProductSearchDocument & WithFavorite;
export type VendorHit = Omit<VendorSearchDocument, '_geo'> & WithDistance & WithFavorite;
export type BazaarHit = Omit<BazaarSearchDocument, '_geo' | 'startDate' | 'endDate'> & {
  // Back to ISO strings on the wire, matching GET /discovery/bazaars.
  startDate: string;
  endDate: string | null;
} & WithDistance &
  WithFavorite;

export type SearchOverview = {
  products?: SearchResult<ProductHit>;
  vendors?: SearchResult<VendorHit>;
  bazaars?: SearchResult<BazaarHit>;
};

type Geo = { lat: number; lng: number; radiusKm: number };
type Page = { page: number; limit: number; offset: number };

// Meilisearch adds this to every hit when the query sorts by _geoPoint.
type GeoHit = { _geoDistance?: number; _geo?: unknown };

/** One-day grace for one-off bazaars with no endDate, mirroring BazaarsRepository.findNearby. */
const UPCOMING_GRACE_SECONDS = 24 * 60 * 60;

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  constructor(
    private readonly registry: SearchIndexRegistry,
    private readonly bootstrap: SearchIndexBootstrap,
    private readonly socialService: SocialService,
  ) {}

  // ---------------------------------------------------------------------------
  // GET /search — grouped multi-index search (separate result sets, never merged)
  // ---------------------------------------------------------------------------

  async searchAll(query: SearchOverviewQueryDto, userId?: string | null): Promise<SearchOverview> {
    const types = this.parseTypes(query.types);
    const geo = this.resolveGeo(query);
    const limit = query.limit ?? 10;
    const now = nowSeconds();

    const params: Record<SearchIndexName, SearchParams> = {
      products: { limit, offset: 0 },
      vendors: { limit, offset: 0, ...this.geoParams(geo) },
      bazaars: {
        limit,
        offset: 0,
        filter: this.bazaarFilter({ upcomingOnly: true }, geo, now),
        ...this.geoSort(geo),
      },
    };

    const response = await this.guard(() =>
      this.registry.client.multiSearch({
        queries: types.map((index) => ({ indexUid: this.registry.uid(index), q: query.q, ...params[index] })),
      }),
    );

    const overview: SearchOverview = {};
    for (const [i, index] of types.entries()) {
      const result = response.results[i];
      const page = { page: 1, limit, offset: 0 };
      switch (index) {
        case 'products':
          overview.products = await this.productResult(result.hits as ProductSearchDocument[], result.estimatedTotalHits ?? 0, page, userId);
          break;
        case 'vendors':
          overview.vendors = await this.vendorResult(result.hits as (VendorSearchDocument & GeoHit)[], result.estimatedTotalHits ?? 0, page, userId);
          break;
        case 'bazaars':
          overview.bazaars = await this.bazaarResult(result.hits as (BazaarSearchDocument & GeoHit)[], result.estimatedTotalHits ?? 0, page, userId);
          break;
      }
    }
    return overview;
  }

  // ---------------------------------------------------------------------------
  // Per-type endpoints
  // ---------------------------------------------------------------------------

  async searchProducts(query: SearchProductsQueryDto, userId?: string | null): Promise<SearchResult<ProductHit>> {
    // Coordinates are accepted and ignored here (products have no _geo in v1),
    // but the cross-field rule still applies so the contract is uniform.
    this.resolveGeo(query);
    const page = this.resolvePage(query);

    if (query.minPrice !== undefined && query.maxPrice !== undefined && query.maxPrice < query.minPrice) {
      throw this.queryInvalid('maxPrice must be greater than or equal to minPrice.');
    }

    const filter: string[] = [];
    if (query.vendorId) filter.push(`vendorId = ${quote(query.vendorId)}`);
    if (query.categoryId) filter.push(`categoryId = ${quote(query.categoryId)}`);
    // categoryPath is an array; "=" on an array attribute means "contains", so
    // this matches the category itself and its whole subtree.
    if (query.category) filter.push(`categoryPath = ${quote(query.category)}`);
    // Range overlap: at least one variant could fall inside [minPrice, maxPrice].
    if (query.minPrice !== undefined) filter.push(`maxPrice >= ${query.minPrice}`);
    if (query.maxPrice !== undefined) filter.push(`minPrice <= ${query.maxPrice}`);
    if (query.size) filter.push(`sizes = ${quote(query.size)}`);
    if (query.color) filter.push(`colors = ${quote(query.color)}`);

    const sort = query.sort ? [query.sort === 'price:asc' ? 'minPrice:asc' : 'minPrice:desc'] : undefined;

    const response = await this.guard(() =>
      this.registry.index<ProductSearchDocument>('products').search(query.q, {
        limit: page.limit,
        offset: page.offset,
        ...(filter.length ? { filter: filter.join(' AND ') } : {}),
        ...(sort ? { sort } : {}),
      }),
    );

    return this.productResult(response.hits, response.estimatedTotalHits, page, userId);
  }

  async searchVendors(query: SearchVendorsQueryDto, userId?: string | null): Promise<SearchResult<VendorHit>> {
    const geo = this.resolveGeo(query);
    const page = this.resolvePage(query);

    const filter: string[] = [];
    if (query.category) filter.push(`category = ${quote(query.category)}`);
    if (query.vendorType) filter.push(`vendorType = ${query.vendorType}`);
    if (geo) filter.push(geoRadius(geo));

    const response = await this.guard(() =>
      this.registry.index<VendorSearchDocument & GeoHit>('vendors').search(query.q, {
        limit: page.limit,
        offset: page.offset,
        ...(filter.length ? { filter: filter.join(' AND ') } : {}),
        ...this.geoSort(geo),
      }),
    );

    return this.vendorResult(response.hits, response.estimatedTotalHits, page, userId);
  }

  async searchBazaars(query: SearchBazaarsQueryDto, userId?: string | null): Promise<SearchResult<BazaarHit>> {
    const geo = this.resolveGeo(query);
    const page = this.resolvePage(query);

    const response = await this.guard(() =>
      this.registry.index<BazaarSearchDocument & GeoHit>('bazaars').search(query.q, {
        limit: page.limit,
        offset: page.offset,
        filter: this.bazaarFilter(query, geo, nowSeconds()),
        ...this.geoSort(geo),
      }),
    );

    return this.bazaarResult(response.hits, response.estimatedTotalHits, page, userId);
  }

  // ---------------------------------------------------------------------------
  // Query building
  // ---------------------------------------------------------------------------

  private parseTypes(raw: string | undefined): SearchIndexName[] {
    if (raw === undefined || raw.trim() === '') return [...SEARCH_INDEXES];

    const requested = raw.split(',').map((value) => value.trim());
    const unknown = requested.filter((value) => !(SEARCH_INDEXES as readonly string[]).includes(value));
    if (unknown.length) {
      throw new BadRequestException({
        code: 'SEARCH_TYPE_INVALID',
        message: `Unknown search type(s): ${unknown.join(', ')}. Allowed: ${SEARCH_INDEXES.join(', ')}.`,
      });
    }
    // Preserve canonical order and drop duplicates.
    return SEARCH_INDEXES.filter((index) => requested.includes(index));
  }

  /**
   * lat/lng are validated pairwise by the DTO. radiusKm alone is meaningless;
   * coordinates alone get the discovery default radius.
   */
  private resolveGeo(query: { lat?: number; lng?: number; radiusKm?: number }): Geo | null {
    const hasCoords = query.lat !== undefined && query.lng !== undefined;
    if (!hasCoords) {
      if (query.radiusKm !== undefined) throw this.queryInvalid('radiusKm requires lat and lng.');
      return null;
    }
    return { lat: query.lat!, lng: query.lng!, radiusKm: query.radiusKm ?? SEARCH_DEFAULT_RADIUS_KM };
  }

  /**
   * offset = (page-1)*limit. A page at or beyond maxTotalHits is rejected, not
   * returned empty — an empty 200 would be indistinguishable from "no more
   * results". The last reachable window is clamped so it can still be read.
   */
  private resolvePage(query: { page?: number; limit?: number }): Page {
    const page = query.page ?? 1;
    const requestedLimit = query.limit ?? 20;
    const offset = (page - 1) * requestedLimit;

    if (offset >= SEARCH_MAX_TOTAL_HITS) {
      throw this.queryInvalid(
        `page is beyond the maximum reachable result window (${SEARCH_MAX_TOTAL_HITS} hits).`,
      );
    }
    const limit = Math.min(requestedLimit, SEARCH_MAX_TOTAL_HITS - offset);
    return { page, limit, offset };
  }

  /** Filter half of geo: only documents that have _geo and fall inside the radius. */
  private geoParams(geo: Geo | null): SearchParams {
    if (!geo) return {};
    return { filter: geoRadius(geo), ...this.geoSort(geo) };
  }

  /**
   * Sort half of geo. `sort` ranks after the relevance rules, so this yields
   * relevance-then-distance and makes Meilisearch attach _geoDistance to hits.
   */
  private geoSort(geo: Geo | null): Pick<SearchParams, 'sort'> {
    return geo ? { sort: [`_geoPoint(${geo.lat}, ${geo.lng}):asc`] } : {};
  }

  /**
   * Mirrors BazaarsRepository.findNearby exactly: RECURRING bazaars are always
   * kept (no RRULE expansion exists), one-offs without an endDate get a
   * one-day grace period.
   */
  private bazaarFilter(
    query: { scheduleType?: string; upcomingOnly?: boolean },
    geo: Geo | null,
    now: number,
  ): string {
    const filter: string[] = [];
    if (query.scheduleType) filter.push(`scheduleType = ${query.scheduleType}`);
    if (query.upcomingOnly ?? true) {
      filter.push(
        `(scheduleType = RECURRING OR endDate >= ${now} OR (endDate IS NULL AND startDate >= ${now - UPCOMING_GRACE_SECONDS}))`,
      );
    }
    if (geo) filter.push(geoRadius(geo));
    return filter.join(' AND ');
  }

  // ---------------------------------------------------------------------------
  // Response mapping
  // ---------------------------------------------------------------------------

  private async productResult(
    hits: ProductSearchDocument[],
    estimatedTotalHits: number,
    page: Page,
    userId?: string | null,
  ): Promise<SearchResult<ProductHit>> {
    const favorites = await this.favorites(userId, FavorableType.PRODUCT, hits);
    return {
      hits: hits.map((hit) => ({ ...hit, isFavorite: favorites.has(hit.id) })),
      estimatedTotalHits,
      page: page.page,
      limit: page.limit,
    };
  }

  private async vendorResult(
    hits: (VendorSearchDocument & GeoHit)[],
    estimatedTotalHits: number,
    page: Page,
    userId?: string | null,
  ): Promise<SearchResult<VendorHit>> {
    const favorites = await this.favorites(userId, FavorableType.VENDOR, hits);
    return {
      hits: hits.map(({ _geo, _geoDistance, ...hit }) => ({
        ...hit,
        ...distance(_geoDistance),
        isFavorite: favorites.has(hit.id),
      })),
      estimatedTotalHits,
      page: page.page,
      limit: page.limit,
    };
  }

  private async bazaarResult(
    hits: (BazaarSearchDocument & GeoHit)[],
    estimatedTotalHits: number,
    page: Page,
    userId?: string | null,
  ): Promise<SearchResult<BazaarHit>> {
    const favorites = await this.favorites(userId, FavorableType.BAZAAR, hits);
    return {
      hits: hits.map(({ _geo, _geoDistance, startDate, endDate, ...hit }) => ({
        ...hit,
        startDate: new Date(startDate * 1000).toISOString(),
        endDate: endDate === null ? null : new Date(endDate * 1000).toISOString(),
        ...distance(_geoDistance),
        isFavorite: favorites.has(hit.id),
      })),
      estimatedTotalHits,
      page: page.page,
      limit: page.limit,
    };
  }

  /** One batch lookup per result set, never per hit. */
  private favorites(
    userId: string | null | undefined,
    type: FavorableType,
    hits: { id: string }[],
  ): Promise<Set<string>> {
    if (!userId || hits.length === 0) return Promise.resolve(new Set<string>());
    return this.socialService.batchCheckFavorites(userId, type, hits.map((hit) => hit.id));
  }

  // ---------------------------------------------------------------------------
  // Availability
  // ---------------------------------------------------------------------------

  /**
   * Runs a Meilisearch call, mapping "not ready" and transport failures to a
   * 503 with a stable code. A Meilisearch *API* error (e.g. a malformed filter)
   * is a bug in this service, not an outage, and is left to surface as a 500.
   */
  private async guard<T>(run: () => Promise<T>): Promise<T> {
    if (!this.bootstrap.ready) throw this.unavailable();
    try {
      return await run();
    } catch (error) {
      if (error instanceof MeiliSearchError && !(error instanceof MeiliSearchApiError)) {
        this.logger.error('search: Meilisearch unreachable during query', error.stack);
        throw this.unavailable();
      }
      throw error;
    }
  }

  private unavailable(): ServiceUnavailableException {
    return new ServiceUnavailableException({
      code: 'SEARCH_UNAVAILABLE',
      message: 'Search is temporarily unavailable.',
    });
  }

  private queryInvalid(message: string): BadRequestException {
    return new BadRequestException({ code: 'SEARCH_QUERY_INVALID', message });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Quote a string for the Meilisearch filter language. */
function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function geoRadius(geo: Geo): string {
  return `_geoRadius(${geo.lat}, ${geo.lng}, ${Math.round(geo.radiusKm * 1000)})`;
}

function distance(meters: number | undefined): WithDistance {
  if (meters === undefined) return { distanceMeters: null, distanceKm: null };
  return { distanceMeters: meters, distanceKm: Number((meters / 1000).toFixed(2)) };
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
