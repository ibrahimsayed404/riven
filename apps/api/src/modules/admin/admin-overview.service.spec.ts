import { AdminOverviewService } from './admin-overview.service';

describe('AdminOverviewService', () => {
  it('runs the five public-service calls and maps sparse groupBy rows onto every enum key', async () => {
    const vendors = { countPendingForAdmin: jest.fn().mockResolvedValue(3) };
    const organizers = { countPendingForAdmin: jest.fn().mockResolvedValue(1) };
    const users = { countByRole: jest.fn().mockResolvedValue([{ role: 'SHOPPER', count: 120 }, { role: 'ADMIN', count: 1 }]) };
    const orders = { countByStatus: jest.fn().mockResolvedValue([{ status: 'PAID', count: 7 }]) };
    const bazaars = { countByStatus: jest.fn().mockResolvedValue([]) };

    const service = new AdminOverviewService(
      vendors as any, organizers as any, users as any, orders as any, bazaars as any,
    );

    const result = await service.getOverview();

    expect(result.pending).toEqual({ vendors: 3, organizers: 1 });
    // Every enum key present; absent ones are 0, not undefined.
    expect(result.users).toEqual({ SHOPPER: 120, VENDOR: 0, ORGANIZER: 0, ADMIN: 1 });
    expect(result.orders).toEqual({ PENDING: 0, PAID: 7, FULFILLED: 0, SHIPPED: 0, DELIVERED: 0, CANCELLED: 0 });
    expect(result.bazaars).toEqual({ DRAFT: 0, PUBLISHED: 0, CANCELLED: 0, COMPLETED: 0 });

    for (const mock of [vendors.countPendingForAdmin, organizers.countPendingForAdmin, users.countByRole, orders.countByStatus, bazaars.countByStatus]) {
      expect(mock).toHaveBeenCalledTimes(1);
    }
  });
});
