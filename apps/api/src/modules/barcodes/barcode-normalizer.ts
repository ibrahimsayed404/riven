import { randomInt } from 'node:crypto';

// Barcode value rules (riven-barcode-inventory-plan §F.1, §F.3). Pure functions.

export const BARCODE_MAX_LENGTH = 128;
export const INTERNAL_PREFIX = 'RVN';

export type NormalizeResult = { ok: true; value: string } | { ok: false; reason: string };

/**
 * Keyboard-wedge scanners (USB / Bluetooth HID) append CR / LF / TAB; some send
 * an AIM symbology identifier (`]E0`, `]C1` …). Both are stripped. Nothing else
 * changes: no numeric cast, leading zeros kept, case kept (Code 128 / QR are
 * case-sensitive). Only printable ASCII is accepted.
 */
export function normalizeBarcode(raw: string): NormalizeResult {
  let value = raw.replace(/[\r\n\t]+$/g, '').trim();
  value = value.replace(/^\][A-Za-z][0-9A-Za-z]/, '');
  if (value.length === 0) return { ok: false, reason: 'empty' };
  if (value.length > BARCODE_MAX_LENGTH) return { ok: false, reason: `longer than ${BARCODE_MAX_LENGTH} characters` };
  if (!/^[\x20-\x7E]+$/.test(value)) return { ok: false, reason: 'contains control or non-ASCII characters' };
  return { ok: true, value };
}

/** Values in the RVN namespace are Riven's (case-insensitive), never a vendor's. */
export function isReservedNamespace(value: string): boolean {
  return value.toUpperCase().startsWith(INTERNAL_PREFIX);
}

// Crockford base-32 (no I, L, O, U) + Luhn mod N check character (P-1).
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const N = ALPHABET.length;

export function luhnCheckChar(body: string): string {
  let sum = 0;
  let factor = 2;
  for (let i = body.length - 1; i >= 0; i--) {
    const code = ALPHABET.indexOf(body[i]);
    if (code < 0) throw new Error(`invalid character ${body[i]}`);
    let addend = factor * code;
    factor = factor === 2 ? 1 : 2;
    addend = Math.floor(addend / N) + (addend % N);
    sum += addend;
  }
  return ALPHABET[(N - (sum % N)) % N];
}

export function isValidInternalValue(value: string): boolean {
  if (!/^RVN[0-9A-HJKMNP-TV-Z]{10}$/.test(value)) return false;
  return luhnCheckChar(value.slice(3, -1)) === value.slice(-1);
}

/** RVN + 9 random characters + check character (13 characters, Code 128 friendly). */
export function generateInternalValue(): string {
  let body = '';
  for (let i = 0; i < 9; i++) body += ALPHABET[randomInt(N)];
  return `${INTERNAL_PREFIX}${body}${luhnCheckChar(body)}`;
}
