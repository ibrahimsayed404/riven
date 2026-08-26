import { Test, TestingModule } from '@nestjs/testing';
import { PaymobService } from './paymob.service';
import { ConfigService } from '@nestjs/config';

describe('PaymobService', () => {
  let service: PaymobService;

  beforeEach(async () => {
    const mockConfigService = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'PAYMOB_HMAC_SECRET') return 'test-hmac-secret';
        if (key === 'PAYMOB_INTEGRATION_ID') return '12345';
        if (key === 'PAYMOB_API_KEY') return 'test-api-key';
        return undefined;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymobService,
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<PaymobService>(PaymobService);
  });

  describe('createIntention', () => {
    it('should format amount to cents/piastres properly', async () => {
      // We spy on global fetch
      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ id: 999, client_url: 'https://paymob.com/checkout' }),
      } as any);

      const result = await service.createIntention(10.50, 'order-123');
      
      expect(result.intentId).toBe(999);
      expect(result.clientUrl).toBe('https://paymob.com/checkout');
      
      // Verify fetch arguments
      const fetchArgs = fetchSpy.mock.calls[0];
      const requestBody = JSON.parse(fetchArgs[1]?.body as string);
      
      // 10.50 EGP * 100 = 1050
      expect(requestBody.amount).toBe(1050);
      expect(requestBody.special_reference).toBe('order-123');
      expect(requestBody.payment_methods).toEqual([12345]);
      
      fetchSpy.mockRestore();
    });

    it('should handle API errors', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: false,
        statusText: 'Bad Request',
        json: async () => ({ message: 'Invalid integration ID' }),
      } as any);

      await expect(service.createIntention(10.50, 'order-123'))
        .rejects.toThrow(/Paymob Intention API failed/);

      fetchSpy.mockRestore();
    });
  });

  describe('verifyWebhookHmac', () => {
    it('should correctly hash the concatenated string and return true for valid signature', () => {
      const payload = {
        obj: {
          amount_cents: 1000,
          created_at: '2023-01-01T00:00:00.000000',
          currency: 'EGP',
          error_occured: false,
          has_parent_transaction: false,
          id: 123,
          integration_id: 12345,
          is_3d_secure: true,
          is_auth: false,
          is_capture: false,
          is_refunded: false,
          is_standalone_payment: true,
          is_voided: false,
          order: {
            id: 456,
          },
          owner: 789,
          pending: false,
          source_data: {
            pan: '1234',
            sub_type: 'MasterCard',
            type: 'card',
          },
          success: true,
        }
      };

      // We recreate the concatenation exactly as Paymob's classic logic dictates:
      // '10002023-01-01T00:00:00.000000EGPfalsefalse12312345truefalsefalsefalsetruefalse456789false1234MasterCardcardtrue'
      // hashed with 'test-hmac-secret'

      const concatenated = '10002023-01-01T00:00:00.000000EGPfalsefalse12312345truefalsefalsefalsetruefalse456789false1234MasterCardcardtrue';
      const crypto = require('crypto');
      const validHash = crypto.createHmac('sha512', 'test-hmac-secret').update(concatenated).digest('hex');

      const isValid = service.verifyWebhookHmac(payload, validHash);
      expect(isValid).toBe(true);
    });

    it('should return false for invalid signature', () => {
      const payload = { obj: { amount_cents: 1000 } };
      const isValid = service.verifyWebhookHmac(payload, 'invalid-hash');
      expect(isValid).toBe(false);
    });
  });
});
