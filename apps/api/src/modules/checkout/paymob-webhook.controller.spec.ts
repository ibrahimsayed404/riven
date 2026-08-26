import { Test, TestingModule } from '@nestjs/testing';
import { PaymobWebhookController } from './paymob-webhook.controller';
import { PaymobService } from '../../infra/paymob/paymob.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { UnauthorizedException } from '@nestjs/common';

describe('PaymobWebhookController', () => {
  let controller: PaymobWebhookController;
  let paymobService: jest.Mocked<PaymobService>;
  let prisma: jest.Mocked<PrismaService>;

  beforeEach(async () => {
    const mockPaymobService = {
      verifyWebhookHmac: jest.fn(),
    };

    const mockPrisma = {
      $transaction: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PaymobWebhookController],
      providers: [
        { provide: PaymobService, useValue: mockPaymobService },
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    controller = module.get<PaymobWebhookController>(PaymobWebhookController);
    paymobService = module.get(PaymobService) as any;
    prisma = module.get(PrismaService) as any;
  });

  it('should throw UnauthorizedException if HMAC header is missing', async () => {
    await expect(controller.handleWebhook({}, '')).rejects.toThrow(UnauthorizedException);
  });

  it('should throw UnauthorizedException if HMAC signature is invalid', async () => {
    paymobService.verifyWebhookHmac.mockReturnValue(false);
    await expect(controller.handleWebhook({}, 'invalid-hmac')).rejects.toThrow(UnauthorizedException);
  });

  it('should transition orders to PAID on success event with matching amount', async () => {
    paymobService.verifyWebhookHmac.mockReturnValue(true);
    const payload = {
      obj: {
        success: true,
        order: { id: 123 },
        amount_cents: 1000,
      },
    };

    const mockTx = {
      orderGroup: { findFirst: jest.fn().mockResolvedValue({ 
        id: 'group-1', 
        orders: [{ status: 'PENDING', subtotal: 10 }] 
      }) },
      order: { updateMany: jest.fn() },
    };

    prisma.$transaction.mockImplementation(async (cb) => {
      return await cb(mockTx as any);
    });

    const response = await controller.handleWebhook(payload, 'valid-hmac');
    
    expect(response).toEqual({ received: true });
    expect(mockTx.orderGroup.findFirst).toHaveBeenCalledWith({
      where: {
        OR: [
          { paymobIntentId: '123' },
          { id: 'non-existent-fallback' }
        ]
      },
      include: { orders: true },
    });
    expect(mockTx.order.updateMany).toHaveBeenCalledWith({
      where: { orderGroupId: 'group-1' },
      data: { status: 'PAID' },
    });
  });

  it('should be idempotent and skip if already paid', async () => {
    paymobService.verifyWebhookHmac.mockReturnValue(true);
    const payload = {
      obj: {
        success: true,
        order: { id: 123 },
        amount_cents: 1000,
      },
    };

    const mockTx = {
      orderGroup: { findFirst: jest.fn().mockResolvedValue({ id: 'group-1', orders: [{ status: 'PAID', subtotal: 10 }] }) },
      order: { updateMany: jest.fn() },
    };

    prisma.$transaction.mockImplementation(async (cb) => {
      return await cb(mockTx as any);
    });

    const response = await controller.handleWebhook(payload, 'valid-hmac');
    
    expect(response).toEqual({ received: true });
    expect(mockTx.orderGroup.findFirst).toHaveBeenCalled();
    expect(mockTx.order.updateMany).not.toHaveBeenCalled();
  });
});
