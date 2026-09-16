import { Logger } from '@nestjs/common';
import { MeiliSearchApiError } from 'meilisearch';

import { SearchIndexBootstrap } from './search-index.bootstrap';
import { SEARCH_INDEXES, SEARCH_INDEX_SETTINGS } from './search-index.config';
import { SearchIndexRegistry } from './search-index.registry';

// Builds a MeiliSearchApiError the way the SDK does for a 404 on GET /indexes/:uid.
function indexNotFound(uid: string): MeiliSearchApiError {
  return new MeiliSearchApiError(new Response(null, { status: 404 }), {
    message: `Index \`${uid}\` not found.`,
    code: 'index_not_found',
    type: 'invalid_request',
    link: '',
  });
}

function resolvedTask() {
  const p = Promise.resolve({ taskUid: 1 }) as any;
  p.waitTask = jest.fn().mockResolvedValue({ status: 'succeeded' });
  return p;
}

describe('SearchIndexBootstrap', () => {
  let client: { getIndex: jest.Mock; createIndex: jest.Mock };
  let updateSettings: jest.Mock;
  let registry: SearchIndexRegistry;
  let bootstrap: SearchIndexBootstrap;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    updateSettings = jest.fn().mockImplementation(() => resolvedTask());
    client = {
      getIndex: jest.fn().mockResolvedValue({}),
      createIndex: jest.fn().mockImplementation(() => resolvedTask()),
    };
    registry = {
      client,
      prefix: 'riven_test_',
      uid: (name: string) => `riven_test_${name}`,
      index: () => ({ updateSettings }),
    } as unknown as SearchIndexRegistry;

    bootstrap = new SearchIndexBootstrap(registry);
  });

  afterEach(() => jest.restoreAllMocks());

  it('applies settings to every index and becomes ready', async () => {
    await bootstrap.onModuleInit();

    expect(bootstrap.ready).toBe(true);
    expect(client.createIndex).not.toHaveBeenCalled();
    expect(updateSettings).toHaveBeenCalledTimes(SEARCH_INDEXES.length);
    for (const name of SEARCH_INDEXES) {
      expect(updateSettings).toHaveBeenCalledWith(SEARCH_INDEX_SETTINGS[name]);
    }
  });

  it('creates a missing index with id as primary key', async () => {
    client.getIndex.mockImplementation((uid: string) =>
      uid === 'riven_test_products' ? Promise.reject(indexNotFound(uid)) : Promise.resolve({}),
    );

    await bootstrap.onModuleInit();

    expect(client.createIndex).toHaveBeenCalledTimes(1);
    expect(client.createIndex).toHaveBeenCalledWith('riven_test_products', { primaryKey: 'id' });
    expect(bootstrap.ready).toBe(true);
  });

  it('does not throw at boot when Meilisearch is unreachable, and stays not-ready', async () => {
    client.getIndex.mockRejectedValue(new Error('fetch failed: ECONNREFUSED'));

    await expect(bootstrap.onModuleInit()).resolves.toBeUndefined();

    expect(bootstrap.ready).toBe(false);
    expect(Logger.prototype.error).toHaveBeenCalledTimes(1);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('rethrows non-404 API errors instead of trying to create the index', async () => {
    const forbidden = new MeiliSearchApiError(new Response(null, { status: 403 }), {
      message: 'The provided API key is invalid.',
      code: 'invalid_api_key',
      type: 'auth',
      link: '',
    });
    client.getIndex.mockRejectedValue(forbidden);

    await expect(bootstrap.ensureReady()).rejects.toBe(forbidden);
    expect(client.createIndex).not.toHaveBeenCalled();
  });

  it('ensureReady retries after a failed boot and flips to ready on success', async () => {
    client.getIndex.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await bootstrap.onModuleInit();
    expect(bootstrap.ready).toBe(false);

    client.getIndex.mockResolvedValue({});
    await bootstrap.ensureReady();

    expect(bootstrap.ready).toBe(true);
  });

  it('collapses concurrent ensureReady calls into a single bootstrap', async () => {
    await Promise.all([bootstrap.ensureReady(), bootstrap.ensureReady(), bootstrap.ensureReady()]);

    expect(updateSettings).toHaveBeenCalledTimes(SEARCH_INDEXES.length);
  });

  it('is a no-op once ready', async () => {
    await bootstrap.ensureReady();
    await bootstrap.ensureReady();

    expect(updateSettings).toHaveBeenCalledTimes(SEARCH_INDEXES.length);
  });
});
