import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AdminAction, AdminTargetType, Barcode, BarcodeScope, BarcodeStatus, PackagingType, Prisma } from '@prisma/client';

import { pageMeta } from '../../common/dto/pagination-query.dto';
import { AuditService } from '../audit/audit.service';
import { generateInternalValue, isReservedNamespace, normalizeBarcode } from './barcode-normalizer';
import { BarcodesRepository, VariantOwnership } from './barcodes.repository';

export type ResolutionOutcome =
  | 'RESOLVED'
  | 'BARCODE_INVALID_FORMAT'
  | 'BARCODE_UNKNOWN'
  | 'VENDOR_MISMATCH'
  | 'BARCODE_INACTIVE'
  | 'BARCODE_NOT_APPROVED'
  | 'BARCODE_AMBIGUOUS'
  | 'VARIANT_UNAVAILABLE';

export interface Resolution {
  outcome: ResolutionOutcome;
  normalizedValue: string | null;
  barcode?: { id: string; scope: BarcodeScope; packagingType: PackagingType; unitsPerPackage: number; configVersion: number };
  variant?: { id: string; sku: string; productId: string; productActive: boolean };
}

const notFound = () => new NotFoundException({ code: 'BARCODE_NOT_FOUND', message: 'Barcode not found.' });
const stateConflict = (current: BarcodeStatus, action: string) =>
  new ConflictException({ code: 'BARCODE_STATE_CONFLICT', message: `Cannot ${action} a barcode that is ${current}.` });
const alreadyRegistered = () =>
  new ConflictException({ code: 'BARCODE_ALREADY_REGISTERED', message: 'This barcode value is already registered.' });

/**
 * Barcode registry (riven-barcode-inventory-plan B1). Vendors propose, admins
 * decide; nothing a vendor submits becomes active on its own. Every change is
 * in BarcodeEvent (same transaction); every admin write is also audited.
 */
@Injectable()
export class BarcodesService {
  constructor(
    private readonly barcodesRepository: BarcodesRepository,
    private readonly auditService: AuditService,
  ) {}

  // ------------------------------------------------------------------ vendor

  async propose(ownerId: string, input: { variantId: string; value: string; packagingType: PackagingType; unitsPerPackage?: number }) {
    const vendorId = await this.vendorIdOf(ownerId);
    const value = this.vendorValue(input.value);
    await this.assertVariantOf(input.variantId, vendorId);
    const units = this.units(input.packagingType, input.unitsPerPackage);
    return this.insert(
      { value, scope: BarcodeScope.VENDOR, vendorId, variantId: input.variantId, packagingType: input.packagingType, unitsPerPackage: units, status: BarcodeStatus.PENDING_APPROVAL, source: 'VENDOR_PROPOSED', proposedById: ownerId },
      { type: 'PROPOSED', actorId: ownerId, actorRole: 'VENDOR' },
    );
  }

  async listOwn(ownerId: string, filter: { status?: BarcodeStatus; page: number; limit: number }) {
    const vendorId = await this.vendorIdOf(ownerId);
    // Vendors see only their own vendor-scope barcodes and decisions — not internal ones.
    const { data, total } = await this.barcodesRepository.list({ ...filter, vendorId, scope: BarcodeScope.VENDOR });
    return { data: data.map(toVendorView), meta: pageMeta(total, filter.page, filter.limit) };
  }

  async withdraw(ownerId: string, barcodeId: string) {
    const vendorId = await this.vendorIdOf(ownerId);
    const barcode = await this.barcodesRepository.findById(barcodeId);
    if (!barcode || barcode.vendorId !== vendorId || barcode.scope !== BarcodeScope.VENDOR) throw notFound();
    const withdrawn = await this.barcodesRepository.transition(
      barcodeId,
      [BarcodeStatus.PENDING_APPROVAL],
      BarcodeStatus.REJECTED,
      { rejectionReason: 'withdrawn by vendor' },
      { type: 'PROPOSAL_WITHDRAWN', actorId: ownerId, actorRole: 'VENDOR' },
    );
    if (!withdrawn) throw stateConflict(barcode.status, 'withdraw');
    return toVendorView(withdrawn);
  }

  // ------------------------------------------------------------------ admin

  async createInternal(adminId: string, input: { variantId: string; packagingType: PackagingType; unitsPerPackage?: number }) {
    const variant = await this.assertVariant(input.variantId);
    const units = this.units(input.packagingType, input.unitsPerPackage);
    // Random 45-bit body: a collision is astronomically rare; the unique index catches it and we retry.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const barcode = await this.insert(
          { value: generateInternalValue(), scope: BarcodeScope.INTERNAL, vendorId: variant.product.vendorId, variantId: input.variantId, packagingType: input.packagingType, unitsPerPackage: units, status: BarcodeStatus.ACTIVE, source: 'RIVEN_GENERATED', decidedById: adminId },
          { type: 'CREATED', actorId: adminId, actorRole: 'ADMIN' },
        );
        await this.audit(adminId, AdminAction.BARCODE_CREATED, barcode.id, `internal ${barcode.value}`);
        return barcode;
      } catch (error) {
        if (!(error instanceof ConflictException) || attempt === 2) throw error;
      }
    }
    throw alreadyRegistered();
  }

  /** Registers a vendor barcode directly (e.g. after an unknown scan) — active at once; the admin is the authority. */
  async registerVendorBarcode(
    adminId: string,
    input: { vendorId: string; variantId: string; value: string; packagingType: PackagingType; unitsPerPackage?: number; reason: string },
  ) {
    if (!(await this.barcodesRepository.vendorExists(input.vendorId))) {
      throw new NotFoundException({ code: 'VENDOR_NOT_FOUND', message: 'Vendor not found.' });
    }
    const value = this.vendorValue(input.value);
    await this.assertVariantOf(input.variantId, input.vendorId);
    const units = this.units(input.packagingType, input.unitsPerPackage);
    const barcode = await this.insert(
      { value, scope: BarcodeScope.VENDOR, vendorId: input.vendorId, variantId: input.variantId, packagingType: input.packagingType, unitsPerPackage: units, status: BarcodeStatus.ACTIVE, source: 'ADMIN_REGISTERED', decidedById: adminId },
      { type: 'CREATED', actorId: adminId, actorRole: 'ADMIN', reason: input.reason },
    );
    await this.audit(adminId, AdminAction.BARCODE_CREATED, barcode.id, input.reason);
    return barcode;
  }

  async approve(adminId: string, barcodeId: string) {
    const barcode = await this.mustFind(barcodeId);
    if (barcode.status === BarcodeStatus.ACTIVE && barcode.decidedById) return barcode; // no-op repeat: nothing recorded
    const approved = await this.barcodesRepository.transition(
      barcodeId,
      [BarcodeStatus.PENDING_APPROVAL],
      BarcodeStatus.ACTIVE,
      { decidedById: adminId, decidedAt: new Date() },
      { type: 'APPROVED', actorId: adminId, actorRole: 'ADMIN' },
    );
    if (!approved) throw stateConflict(barcode.status, 'approve');
    await this.audit(adminId, AdminAction.BARCODE_APPROVED, barcodeId, null);
    return approved;
  }

  async reject(adminId: string, barcodeId: string, reason: string) {
    const barcode = await this.mustFind(barcodeId);
    if (barcode.status === BarcodeStatus.REJECTED) return barcode;
    const rejected = await this.barcodesRepository.transition(
      barcodeId,
      [BarcodeStatus.PENDING_APPROVAL],
      BarcodeStatus.REJECTED,
      { decidedById: adminId, decidedAt: new Date(), rejectionReason: reason },
      { type: 'REJECTED', actorId: adminId, actorRole: 'ADMIN', reason },
    );
    if (!rejected) throw stateConflict(barcode.status, 'reject');
    await this.audit(adminId, AdminAction.BARCODE_REJECTED, barcodeId, reason);
    return rejected;
  }

  async activate(adminId: string, barcodeId: string, reason: string) {
    const barcode = await this.mustFind(barcodeId);
    if (barcode.status === BarcodeStatus.ACTIVE) return barcode;
    const activated = await this.barcodesRepository.transition(barcodeId, [BarcodeStatus.INACTIVE], BarcodeStatus.ACTIVE, {}, {
      type: 'ACTIVATED',
      actorId: adminId,
      actorRole: 'ADMIN',
      reason,
    });
    if (!activated) throw stateConflict(barcode.status, 'activate');
    await this.audit(adminId, AdminAction.BARCODE_ACTIVATED, barcodeId, reason);
    return activated;
  }

  async deactivate(adminId: string, barcodeId: string, reason: string) {
    const barcode = await this.mustFind(barcodeId);
    if (barcode.status === BarcodeStatus.INACTIVE) return barcode;
    const deactivated = await this.barcodesRepository.transition(barcodeId, [BarcodeStatus.ACTIVE], BarcodeStatus.INACTIVE, {}, {
      type: 'DEACTIVATED',
      actorId: adminId,
      actorRole: 'ADMIN',
      reason,
    });
    if (!deactivated) throw stateConflict(barcode.status, 'deactivate');
    await this.audit(adminId, AdminAction.BARCODE_DEACTIVATED, barcodeId, reason);
    return deactivated;
  }

  /** Conversion change only — the mapping itself is immutable (plan §F.3). Scans snapshot the version they used. */
  async changeConversion(adminId: string, barcodeId: string, unitsPerPackage: number, reason: string) {
    const barcode = await this.mustFind(barcodeId);
    if (barcode.packagingType === PackagingType.UNIT) {
      throw new BadRequestException({ code: 'BARCODE_UNIT_CONVERSION_FIXED', message: 'A UNIT barcode is always one base unit.' });
    }
    if (barcode.status === BarcodeStatus.REJECTED) throw stateConflict(barcode.status, 'change');
    this.units(barcode.packagingType, unitsPerPackage);
    if (barcode.unitsPerPackage === unitsPerPackage) return barcode; // no-op
    const changed = await this.barcodesRepository.changeConversion(barcodeId, barcode.configVersion, unitsPerPackage, {
      type: 'CONVERSION_CHANGED',
      actorId: adminId,
      actorRole: 'ADMIN',
      reason,
    });
    if (!changed) {
      throw new ConflictException({ code: 'BARCODE_STATE_CONFLICT', message: 'The barcode changed while this request was in flight. Reload and try again.' });
    }
    await this.audit(adminId, AdminAction.BARCODE_UPDATED, barcodeId, `units ${barcode.unitsPerPackage} → ${unitsPerPackage}: ${reason}`);
    return changed;
  }

  async listForAdmin(filter: { vendorId?: string; variantId?: string; status?: BarcodeStatus; value?: string; page: number; limit: number }) {
    const value = filter.value !== undefined ? normalizeBarcode(filter.value) : undefined;
    const { data, total } = await this.barcodesRepository.list({ ...filter, value: value && value.ok ? value.value : filter.value });
    return { data, meta: pageMeta(total, filter.page, filter.limit) };
  }

  async getForAdmin(barcodeId: string) {
    const barcode = await this.barcodesRepository.findByIdWithHistory(barcodeId);
    if (!barcode) throw notFound();
    return barcode;
  }

  // ------------------------------------------------------------------ resolution (plan §F.2)

  /**
   * Resolves a scanned value within a vendor's scope. Never guesses: anything but
   * exactly one ACTIVE barcode on a live variant of that vendor is a coded outcome.
   */
  async resolve(rawValue: string, vendorId: string): Promise<Resolution> {
    const normalized = normalizeBarcode(rawValue);
    if (!normalized.ok) return { outcome: 'BARCODE_INVALID_FORMAT', normalizedValue: null };
    const value = normalized.value;

    const candidates = await this.barcodesRepository.findCandidates(value, vendorId);
    const active = candidates.filter((c) => c.status === BarcodeStatus.ACTIVE);

    if (active.length > 1) return { outcome: 'BARCODE_AMBIGUOUS', normalizedValue: value };
    if (active.length === 0) {
      if (candidates.length === 0) {
        return {
          outcome: (await this.barcodesRepository.existsForOtherVendor(value, vendorId)) ? 'VENDOR_MISMATCH' : 'BARCODE_UNKNOWN',
          normalizedValue: value,
        };
      }
      if (candidates.some((c) => c.status === BarcodeStatus.PENDING_APPROVAL)) return { outcome: 'BARCODE_NOT_APPROVED', normalizedValue: value };
      return { outcome: 'BARCODE_INACTIVE', normalizedValue: value };
    }

    const match = active[0];
    if (match.variant.product.vendorId !== vendorId) return { outcome: 'VENDOR_MISMATCH', normalizedValue: value };
    if (match.variant.deletedAt || match.variant.product.deletedAt) return { outcome: 'VARIANT_UNAVAILABLE', normalizedValue: value };

    return {
      outcome: 'RESOLVED',
      normalizedValue: value,
      barcode: { id: match.id, scope: match.scope, packagingType: match.packagingType, unitsPerPackage: match.unitsPerPackage, configVersion: match.configVersion },
      variant: { id: match.variant.id, sku: match.variant.sku, productId: match.variant.product.id, productActive: match.variant.product.isActive },
    };
  }

  // ------------------------------------------------------------------ helpers

  private async insert(data: Parameters<BarcodesRepository['create']>[0], event: Parameters<BarcodesRepository['create']>[1]): Promise<Barcode> {
    try {
      return await this.barcodesRepository.create(data, event);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw alreadyRegistered();
      throw error;
    }
  }

  private vendorValue(raw: string): string {
    const normalized = normalizeBarcode(raw);
    if (!normalized.ok) {
      throw new BadRequestException({ code: 'BARCODE_INVALID_FORMAT', message: `Invalid barcode: ${normalized.reason}.` });
    }
    if (isReservedNamespace(normalized.value)) {
      throw new BadRequestException({ code: 'BARCODE_RESERVED_NAMESPACE', message: 'Values starting with RVN are reserved for Riven barcodes.' });
    }
    return normalized.value;
  }

  private units(type: PackagingType, units?: number): number {
    if (type === PackagingType.UNIT) {
      if (units !== undefined && units !== 1) {
        throw new BadRequestException({ code: 'BARCODE_INVALID_CONVERSION', message: 'A UNIT barcode is exactly one base unit.' });
      }
      return 1;
    }
    if (units === undefined || !Number.isInteger(units) || units < 2) {
      throw new BadRequestException({ code: 'BARCODE_INVALID_CONVERSION', message: `A ${type} barcode needs unitsPerPackage ≥ 2.` });
    }
    return units;
  }

  private async vendorIdOf(ownerId: string): Promise<string> {
    const vendor = await this.barcodesRepository.findVendorIdByOwner(ownerId);
    if (!vendor) throw new NotFoundException({ code: 'VENDOR_NOT_FOUND', message: 'Vendor profile not found.' });
    return vendor.id;
  }

  private async assertVariant(variantId: string): Promise<VariantOwnership> {
    const variant = await this.barcodesRepository.findVariantOwnership(variantId);
    if (!variant || variant.deletedAt || variant.product.deletedAt) {
      throw new NotFoundException({ code: 'VARIANT_NOT_FOUND', message: 'Variant not found.' });
    }
    return variant;
  }

  private async assertVariantOf(variantId: string, vendorId: string): Promise<void> {
    const variant = await this.assertVariant(variantId);
    if (variant.product.vendorId !== vendorId) {
      throw new ForbiddenException({ code: 'VARIANT_NOT_OWNED', message: 'This variant does not belong to the vendor.' });
    }
  }

  private async mustFind(barcodeId: string): Promise<Barcode> {
    const barcode = await this.barcodesRepository.findById(barcodeId);
    if (!barcode) throw notFound();
    return barcode;
  }

  private audit(adminId: string, action: AdminAction, barcodeId: string, reason: string | null) {
    return this.auditService.record({ actorId: adminId, action, targetType: AdminTargetType.BARCODE, targetId: barcodeId, reason });
  }
}

/** What a vendor may see about its own barcode: no internal decision actors. */
function toVendorView(b: Barcode) {
  return {
    id: b.id,
    value: b.value,
    variantId: b.variantId,
    packagingType: b.packagingType,
    unitsPerPackage: b.unitsPerPackage,
    status: b.status,
    rejectionReason: b.rejectionReason,
    createdAt: b.createdAt,
    decidedAt: b.decidedAt,
  };
}
