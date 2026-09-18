import { Logger } from '@nestjs/common';
import { AdminAction, AdminTargetType } from '@prisma/client';

import { AuditRepository } from './audit.repository';
import { AuditService } from './audit.service';

function createMockRepository(): jest.Mocked<AuditRepository> {
  return {
    create: jest.fn(),
    findManyPaginated: jest.fn(),
  } as unknown as jest.Mocked<AuditRepository>;
}

const entry = {
  actorId: 'admin-1',
  action: AdminAction.VENDOR_VERIFIED,
  targetType: AdminTargetType.VENDOR,
  targetId: 'vendor-1',
};

describe('AuditService', () => {
  let service: AuditService;
  let repository: jest.Mocked<AuditRepository>;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    repository = createMockRepository();
    service = new AuditService(repository);
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  describe('record', () => {
    it('writes the entry through the repository', async () => {
      repository.create.mockResolvedValue(undefined);

      await service.record(entry);

      expect(repository.create).toHaveBeenCalledWith(entry);
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('resolves and logs the full entry when the repository throws', async () => {
      repository.create.mockRejectedValue(new Error('connection reset'));

      await expect(service.record(entry)).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const [message] = errorSpy.mock.calls[0];
      expect(message).toContain('admin-1');
      expect(message).toContain('VENDOR_VERIFIED');
      expect(message).toContain('vendor-1');
    });
  });

  describe('list', () => {
    it('wraps repository results in the { data, meta } page shape', async () => {
      repository.findManyPaginated.mockResolvedValue({ data: [], total: 45 });

      const result = await service.list({ targetType: AdminTargetType.PRODUCT }, 2, 20);

      expect(repository.findManyPaginated).toHaveBeenCalledWith(
        { targetType: AdminTargetType.PRODUCT },
        2,
        20,
      );
      expect(result.meta).toEqual({ total: 45, page: 2, limit: 20, totalPages: 3 });
    });
  });
});
