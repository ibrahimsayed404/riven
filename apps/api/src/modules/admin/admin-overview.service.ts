import { Injectable } from '@nestjs/common';
import { BazaarStatus, OrderStatus, Role } from '@prisma/client';

import { BazaarsService } from '../bazaars/bazaars.service';
import { OrganizersService } from '../bazaars/organizers.service';
import { OrdersService } from '../orders/orders.service';
import { UsersService } from '../users/users.service';
import { VendorsService } from '../vendors/vendors.service';

export interface AdminOverview {
  // Products have no approval gate (specs/vendor-module-spec2.md) — no "pending.products".
  pending: { vendors: number; organizers: number };
  users: Record<Role, number>;
  orders: Record<OrderStatus, number>;
  bazaars: Record<BazaarStatus, number>;
}

/**
 * Every value in `values` appears as a key, absent ones as 0 — the dashboard
 * never has to null-check a status that simply had no rows.
 */
function onEnum<K extends string>(values: readonly K[], rows: { key: K; count: number }[]): Record<K, number> {
  const out = Object.fromEntries(values.map((v) => [v, 0])) as Record<K, number>;
  for (const row of rows) out[row.key] = row.count;
  return out;
}

@Injectable()
export class AdminOverviewService {
  constructor(
    private readonly vendorsService: VendorsService,
    private readonly organizersService: OrganizersService,
    private readonly usersService: UsersService,
    private readonly ordersService: OrdersService,
    private readonly bazaarsService: BazaarsService,
  ) {}

  /** Exactly five queries, in parallel, through the modules' public services. */
  async getOverview(): Promise<AdminOverview> {
    const [pendingVendors, pendingOrganizers, usersByRole, ordersByStatus, bazaarsByStatus] =
      await Promise.all([
        this.vendorsService.countPendingForAdmin(),
        this.organizersService.countPendingForAdmin(),
        this.usersService.countByRole(),
        this.ordersService.countByStatus(),
        this.bazaarsService.countByStatus(),
      ]);

    return {
      pending: { vendors: pendingVendors, organizers: pendingOrganizers },
      users: onEnum(Object.values(Role), usersByRole.map((r) => ({ key: r.role, count: r.count }))),
      orders: onEnum(Object.values(OrderStatus), ordersByStatus.map((r) => ({ key: r.status, count: r.count }))),
      bazaars: onEnum(Object.values(BazaarStatus), bazaarsByStatus.map((r) => ({ key: r.status, count: r.count }))),
    };
  }
}
