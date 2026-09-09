import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { BazaarStatus, ScheduleType } from '@prisma/client';

import { DiscoveryService } from './discovery.service';
import { BazaarsService } from '../bazaars/bazaars.service';

describe('DiscoveryService', () => {
  let service: DiscoveryService;
  let bazaarsService: jest.Mocked<BazaarsService>;

  const mockRow = {
    id: 'bazaar-1',
    organizerId: 'org-1',
    name: 'Zamalek Craft Market',
    description: null,
    coverMedia: [],
    scheduleType: ScheduleType.ONE_OFF,
    recurrenceRule: null,
    startDate: new Date('2026-10-01T10:00:00.000Z'),
    endDate: new Date('2026-10-02T10:00:00.000Z'),
    status: BazaarStatus.PUBLISHED,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    deletedAt: null,
    location: { lat: 30.0626, lng: 31.2197 },
    distanceMeters: 1423.77,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DiscoveryService,
        {
          provide: BazaarsService,
          useValue: {
            findNearby: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<DiscoveryService>(DiscoveryService);
    bazaarsService = module.get(BazaarsService);
  });

  describe('filter defaults', () => {
    it('applies the spec defaults when the query omits them', async () => {
      bazaarsService.findNearby.mockResolvedValue({ data: [], hasMore: false });

      await service.discoverBazaars({});

      expect(bazaarsService.findNearby).toHaveBeenCalledWith(
        expect.objectContaining({ radiusKm: 25, upcomingOnly: true }),
        20,
        undefined,
      );
    });

    it('passes lat/lng and scheduleType straight through', async () => {
      bazaarsService.findNearby.mockResolvedValue({ data: [], hasMore: false });

      await service.discoverBazaars({
        lat: 30.0444,
        lng: 31.2357,
        radiusKm: 5,
        scheduleType: ScheduleType.RECURRING,
        upcomingOnly: false,
        limit: 10,
      });

      expect(bazaarsService.findNearby).toHaveBeenCalledWith(
        {
          lat: 30.0444,
          lng: 31.2357,
          radiusKm: 5,
          scheduleType: ScheduleType.RECURRING,
          upcomingOnly: false,
        },
        10,
        undefined,
      );
    });
  });

  describe('response shaping', () => {
    it('derives distanceKm from distanceMeters at 2dp', async () => {
      bazaarsService.findNearby.mockResolvedValue({ data: [mockRow], hasMore: false });

      const result = await service.discoverBazaars({ lat: 30.0444, lng: 31.2357 });

      expect(result.data[0].distanceMeters).toBe(1423.77);
      expect(result.data[0].distanceKm).toBe(1.42);
    });

    it('leaves distanceKm null when there is no origin', async () => {
      bazaarsService.findNearby.mockResolvedValue({
        data: [{ ...mockRow, distanceMeters: null }],
        hasMore: false,
      });

      const result = await service.discoverBazaars({});

      expect(result.data[0].distanceMeters).toBeNull();
      expect(result.data[0].distanceKm).toBeNull();
    });

    it('stubs isFavorite until the social module lands', async () => {
      bazaarsService.findNearby.mockResolvedValue({ data: [mockRow], hasMore: false });

      const result = await service.discoverBazaars({});

      expect(result.data[0].isFavorite).toBe(false);
    });

    it('does not leak internal columns on a public feed', async () => {
      bazaarsService.findNearby.mockResolvedValue({ data: [mockRow], hasMore: false });

      const result = await service.discoverBazaars({});

      expect(result.data[0]).not.toHaveProperty('status');
      expect(result.data[0]).not.toHaveProperty('deletedAt');
      expect(result.data[0]).not.toHaveProperty('createdAt');
      expect(result.data[0]).not.toHaveProperty('updatedAt');
    });
  });

  describe('cursor emission', () => {
    it('returns nextCursor = null when there is no further page', async () => {
      bazaarsService.findNearby.mockResolvedValue({ data: [mockRow], hasMore: false });

      const result = await service.discoverBazaars({ lat: 30.0444, lng: 31.2357 });

      expect(result.nextCursor).toBeNull();
    });

    it('round-trips a distance cursor back into the repository filters', async () => {
      bazaarsService.findNearby.mockResolvedValue({ data: [mockRow], hasMore: true });

      const first = await service.discoverBazaars({ lat: 30.0444, lng: 31.2357 });
      expect(first.nextCursor).not.toBeNull();

      await service.discoverBazaars({
        lat: 30.0444,
        lng: 31.2357,
        cursor: first.nextCursor as string,
      });

      expect(bazaarsService.findNearby).toHaveBeenLastCalledWith(
        expect.anything(),
        20,
        { sortValue: 1423.77, id: 'bazaar-1' },
      );
    });

    it('round-trips a startDate cursor when no origin was supplied', async () => {
      bazaarsService.findNearby.mockResolvedValue({
        data: [{ ...mockRow, distanceMeters: null }],
        hasMore: true,
      });

      const first = await service.discoverBazaars({});
      await service.discoverBazaars({ cursor: first.nextCursor as string });

      expect(bazaarsService.findNearby).toHaveBeenLastCalledWith(
        expect.anything(),
        20,
        { sortValue: new Date('2026-10-01T10:00:00.000Z'), id: 'bazaar-1' },
      );
    });
  });

  describe('cursor rejection', () => {
    it('rejects a cursor that is not base64 JSON', async () => {
      await expect(service.discoverBazaars({ cursor: 'not-a-cursor' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects a cursor missing its id', async () => {
      const cursor = Buffer.from(JSON.stringify({ s: 12 }), 'utf8').toString('base64url');

      await expect(
        service.discoverBazaars({ lat: 30.0444, lng: 31.2357, cursor }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a date cursor once the client starts sorting by distance', async () => {
      const cursor = Buffer.from(
        JSON.stringify({ s: '2026-10-01T10:00:00.000Z', id: 'bazaar-1' }),
        'utf8',
      ).toString('base64url');

      await expect(
        service.discoverBazaars({ lat: 30.0444, lng: 31.2357, cursor }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a distance cursor once the client drops its coordinates', async () => {
      const cursor = Buffer.from(
        JSON.stringify({ s: 1423.77, id: 'bazaar-1' }),
        'utf8',
      ).toString('base64url');

      await expect(service.discoverBazaars({ cursor })).rejects.toThrow(BadRequestException);
    });

    it('surfaces INVALID_CURSOR as the error code', async () => {
      await expect(service.discoverBazaars({ cursor: '!!!' })).rejects.toMatchObject({
        response: { code: 'INVALID_CURSOR' },
      });
    });
  });
});
