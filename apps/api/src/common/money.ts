import { Prisma } from '@prisma/client';

/**
 * Money is integer piastres (EGP cents) everywhere it is summed or compared.
 * Decimal columns are converted at the edges with these two helpers; JS
 * floats never touch a price (fix.js PAY-04).
 */
export type Cents = number;

export function toCents(amount: Prisma.Decimal | number | string): Cents {
  return new Prisma.Decimal(amount).mul(100).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber();
}

export function fromCents(cents: Cents): Prisma.Decimal {
  return new Prisma.Decimal(cents).div(100);
}
