// Decorators need the metadata polyfill; NestJS loads it for us everywhere else.
import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreateBazaarDto } from './create-bazaar.dto';
import { UpdateBazaarDto } from './update-bazaar.dto';

async function errorsOf<T extends object>(cls: new () => T, body: Record<string, unknown>) {
  const errors = await validate(plainToInstance(cls, body), { whitelist: true, forbidNonWhitelisted: true });
  return errors.flatMap((e) => Object.keys(e.constraints ?? {}));
}

const valid = {
  name: 'Winter Bazaar',
  lat: 30.05,
  lng: 31.23,
  scheduleType: 'ONE_OFF',
  startDate: '2026-12-01T10:00:00.000Z',
};

describe('bazaar DTOs: coverMedia', () => {
  it('accepts http(s) URLs, including local MinIO hosts without a TLD', async () => {
    expect(await errorsOf(CreateBazaarDto, { ...valid, coverMedia: ['https://cdn.example.com/a.jpg', 'http://localhost:9000/riven/b.png'] })).toEqual([]);
  });

  it.each([['javascript:alert(1)'], ['data:image/png;base64,AAAA'], ['not a url']])(
    'rejects %s, which a client would otherwise render as an image source',
    async (value) => {
      expect(await errorsOf(CreateBazaarDto, { ...valid, coverMedia: [value] })).toContain('isUrl');
      expect(await errorsOf(UpdateBazaarDto, { coverMedia: [value] })).toContain('isUrl');
    },
  );

  it('caps the list at 10 entries, like a vendor coverMedia', async () => {
    const urls = Array.from({ length: 11 }, (_, i) => `https://cdn.example.com/${i}.jpg`);
    expect(await errorsOf(CreateBazaarDto, { ...valid, coverMedia: urls })).toContain('arrayMaxSize');
    expect(await errorsOf(CreateBazaarDto, { ...valid, coverMedia: urls.slice(0, 10) })).toEqual([]);
  });
});
