import {
  generateInternalValue,
  isReservedNamespace,
  isValidInternalValue,
  luhnCheckChar,
  normalizeBarcode,
} from './barcode-normalizer';

describe('barcode normalizer (riven-barcode-inventory-plan §F.1)', () => {
  it('strips keyboard-wedge suffixes and surrounding spaces', () => {
    expect(normalizeBarcode('0012345678905\r\n')).toEqual({ ok: true, value: '0012345678905' });
    expect(normalizeBarcode('  ABC-123\t')).toEqual({ ok: true, value: 'ABC-123' });
  });

  it('strips an AIM symbology identifier', () => {
    expect(normalizeBarcode(']E00012345678905')).toEqual({ ok: true, value: '0012345678905' });
    expect(normalizeBarcode(']C1ABC')).toEqual({ ok: true, value: 'ABC' });
  });

  it('keeps leading zeros and case — never numeric-casts or case-folds', () => {
    expect(normalizeBarcode('000123')).toEqual({ ok: true, value: '000123' });
    expect(normalizeBarcode('aBc123')).toEqual({ ok: true, value: 'aBc123' });
    expect(normalizeBarcode('012345678905')).not.toEqual(normalizeBarcode('0012345678905')); // no GTIN equivalence (P-2)
  });

  it('rejects empty, too long, control and non-ASCII input', () => {
    expect(normalizeBarcode('\r\n')).toMatchObject({ ok: false });
    expect(normalizeBarcode('A'.repeat(129))).toMatchObject({ ok: false });
    expect(normalizeBarcode('AB\u0007C')).toMatchObject({ ok: false });
    expect(normalizeBarcode('ABÇ')).toMatchObject({ ok: false });
  });

  it('the RVN namespace is reserved, case-insensitively', () => {
    expect(isReservedNamespace('RVN123')).toBe(true);
    expect(isReservedNamespace('rvn123')).toBe(true);
    expect(isReservedNamespace('R123')).toBe(false);
  });
});

describe('internal barcode values (P-1: RVN + 9 Crockford base-32 + Luhn mod 32)', () => {
  it('generates 13-character values that validate', () => {
    for (let i = 0; i < 200; i++) {
      const value = generateInternalValue();
      expect(value).toMatch(/^RVN[0-9A-HJKMNP-TV-Z]{10}$/);
      expect(isValidInternalValue(value)).toBe(true);
    }
  });

  it('the check character catches a single substitution and an adjacent transposition', () => {
    const body = '7K2M9Q4XA';
    const value = `RVN${body}${luhnCheckChar(body)}`;
    expect(isValidInternalValue(value)).toBe(true);
    expect(isValidInternalValue(`RVN7K2M9Q4XB${value.slice(-1)}`)).toBe(false);
    expect(isValidInternalValue(`RVNK72M9Q4XA${value.slice(-1)}`)).toBe(false);
  });
});
