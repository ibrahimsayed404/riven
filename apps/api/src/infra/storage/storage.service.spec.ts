import { ConfigService } from '@nestjs/config';

import { StorageService, UPLOAD_URL_TTL_SECONDS } from './storage.service';

const env: Record<string, string> = {
  S3_ENDPOINT: 'http://localhost:9000',
  S3_REGION: 'us-east-1',
  S3_BUCKET: 'riven-media',
  S3_ACCESS_KEY_ID: 'riven',
  S3_SECRET_ACCESS_KEY: 'riven_dev_password',
  S3_PUBLIC_URL: 'http://localhost:9000/riven-media/',
};

describe('StorageService', () => {
  const configService = {
    getOrThrow: (key: string) => {
      if (!(key in env)) throw new Error(`missing ${key}`);
      return env[key];
    },
  } as unknown as ConfigService;

  it('signs a path-style PUT for the bucket and key with the content type locked in', async () => {
    const service = new StorageService(configService);
    const target = await service.createUploadUrl('product-image/u1/abc.png', 'image/png');

    const url = new URL(target.uploadUrl);
    expect(url.origin).toBe('http://localhost:9000');
    expect(url.pathname).toBe('/riven-media/product-image/u1/abc.png');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(url.searchParams.get('X-Amz-Expires')).toBe(String(UPLOAD_URL_TTL_SECONDS));
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('content-type');
    // No empty-body checksum pinned into the URL — that would reject every real upload.
    expect(url.searchParams.has('x-amz-checksum-crc32')).toBe(false);

    expect(target.key).toBe('product-image/u1/abc.png');
    expect(target.expiresInSeconds).toBe(UPLOAD_URL_TTL_SECONDS);
  });

  it('builds publicUrl from S3_PUBLIC_URL without doubling the slash', async () => {
    const service = new StorageService(configService);
    const target = await service.createUploadUrl('vendor-logo/u1/x.webp', 'image/webp');
    expect(target.publicUrl).toBe('http://localhost:9000/riven-media/vendor-logo/u1/x.webp');
  });
});
