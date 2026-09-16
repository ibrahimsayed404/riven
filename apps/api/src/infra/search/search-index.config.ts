import type { Settings } from 'meilisearch';

/**
 * Logical index names. The physical Meilisearch uid is `${prefix}${name}`,
 * resolved by SearchIndexRegistry, so dev/test/prod never share an index.
 */
export const SEARCH_INDEXES = ['products', 'vendors', 'bazaars'] as const;
export type SearchIndexName = (typeof SEARCH_INDEXES)[number];

/**
 * Hard cap on the reachable result window. The query layer rejects any
 * page whose offset is at or beyond this, so it must match what the index
 * enforces — set explicitly here rather than relying on Meilisearch's default.
 */
export const SEARCH_MAX_TOTAL_HITS = 1000;

// Meilisearch defaults, spelled out so `sort` is visibly *after* the relevance
// rules: an explicit sort (price, _geoPoint) only orders documents that tie on
// relevance. That is the intended behaviour for a search box.
const DEFAULT_RANKING_RULES = ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness'];

/**
 * Per-index settings, per specs/search-module-spec.md §4. Applied idempotently
 * at boot; Meilisearch treats an unchanged settings payload as a no-op task.
 */
export const SEARCH_INDEX_SETTINGS: Record<SearchIndexName, Settings> = {
  products: {
    // Attribute order = relevance weight.
    searchableAttributes: ['title', 'vendorName', 'categorySlug', 'description'],
    filterableAttributes: [
      'vendorId',
      'categoryId',
      'categoryPath',
      'minPrice',
      'maxPrice',
      'sizes',
      'colors',
    ],
    sortableAttributes: ['minPrice'],
    rankingRules: DEFAULT_RANKING_RULES,
    pagination: { maxTotalHits: SEARCH_MAX_TOTAL_HITS },
  },
  vendors: {
    searchableAttributes: ['name', 'category', 'description', 'brandStory'],
    filterableAttributes: ['category', 'vendorType', '_geo'],
    sortableAttributes: ['_geo'],
    rankingRules: DEFAULT_RANKING_RULES,
    pagination: { maxTotalHits: SEARCH_MAX_TOTAL_HITS },
  },
  bazaars: {
    searchableAttributes: ['name', 'description'],
    filterableAttributes: ['scheduleType', 'startDate', 'endDate', '_geo'],
    sortableAttributes: ['startDate', '_geo'],
    rankingRules: DEFAULT_RANKING_RULES,
    pagination: { maxTotalHits: SEARCH_MAX_TOTAL_HITS },
  },
};
