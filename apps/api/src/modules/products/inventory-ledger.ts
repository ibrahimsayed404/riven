/**
 * Inventory ledger vocabulary (specs/commerce/25 slice S3). Every writer of
 * ProductVariant.stockQuantity records one InventoryMovement in the same
 * transaction as the change; these are the `source` values they use, so the
 * history reads the same whoever wrote it. Constants only — each module writes
 * its own rows through its own repository.
 */
export const MOVEMENT_SOURCE = {
  CHECKOUT: 'checkout',
  SHOPPER_CANCEL: 'shopper_cancel',
  ADMIN_CANCEL: 'admin_cancel',
  EXPIRY: 'expiry',
  VENDOR: 'vendor',
  MIGRATION: 'migration',
} as const;

export type MovementSource = (typeof MOVEMENT_SOURCE)[keyof typeof MOVEMENT_SOURCE];

/** One vendor adjustment moves at most this many units either way (same bound as a variant's stock). */
export const STOCK_ADJUSTMENT_MAX = 1_000_000;
