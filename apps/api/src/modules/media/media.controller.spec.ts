import { autoMock, expectPassThrough, loose, routesOf, userOf } from '../../test-utils/controller-test.helpers';
import { Role } from '@prisma/client';

import { MediaController } from './media.controller';

// Unit tests for every route of MediaController: the route definition (method, path,
// guards, roles, status code) and delegation to the service with pass-through.
describe('MediaController (unit)', () => {
  let mediaService: ReturnType<typeof autoMock>;
  let controller: MediaController;

  beforeEach(() => {
    mediaService = autoMock('mediaService');
    controller = new MediaController(mediaService as never);
  });

  it('declares exactly these routes, guards and roles', () => {
    expect(routesOf(MediaController)).toEqual([
      {
        "handler": "createUploadUrl",
        "method": "POST",
        "path": "/media/upload-url",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "VENDOR",
          "ORGANIZER"
        ],
        "httpCode": 200
      }
    ]);
  });

  it('POST /media/upload-url → mediaService.createUploadUrl', async () => {
    const userId = userOf(Role.VENDOR).id;
    const dto = loose({ sample: 'body' });
    const result = await controller.createUploadUrl(userId, dto);
    expect(mediaService.createUploadUrl).toHaveBeenCalledWith(userId, dto.purpose, dto.contentType, dto.contentLength);
    expect(mediaService.createUploadUrl).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, mediaService.createUploadUrl);
  });
});
