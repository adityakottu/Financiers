import { describe, expect, it } from 'vitest';
import { kycStatusFor, normaliseId } from '../customers/customers.service';
import { safeFileName, sniffMime } from '../files/files.service';
import { testConfig } from '../test/harness';
import { CryptoService } from './crypto.service';

const crypto = new CryptoService(testConfig());

describe('CryptoService', () => {
  it('round-trips and uses a fresh IV each time', () => {
    const a = crypto.encrypt('ABCDE1234F', 'customer_kyc.PAN');
    const b = crypto.encrypt('ABCDE1234F', 'customer_kyc.PAN');
    expect(a.equals(b)).toBe(false);
    expect(crypto.decrypt(a, 'customer_kyc.PAN')).toBe('ABCDE1234F');
  });

  it('detects tampering', () => {
    const blob = crypto.encrypt('ABCDE1234F', 'customer_kyc.PAN');
    blob[blob.length - 1] ^= 1;
    expect(() => crypto.decrypt(blob, 'customer_kyc.PAN')).toThrow();
  });

  it('binds ciphertext to its column (AAD)', () => {
    const blob = crypto.encrypt('secret', 'users.totp_secret');
    expect(() => crypto.decrypt(blob, 'customer_kyc.PAN')).toThrow();
  });

  it('blind index is deterministic, keyed and kind-separated', () => {
    expect(crypto.blindIndex('PAN', 'ABCDE1234F').equals(crypto.blindIndex('PAN', 'ABCDE1234F'))).toBe(true);
    expect(crypto.blindIndex('PAN', 'ABCDE1234F').equals(crypto.blindIndex('VOTER_ID', 'ABCDE1234F'))).toBe(false);
  });

  it('refuses identical data and blind-index keys', () => {
    const k = Buffer.alloc(32, 1).toString('base64');
    expect(() => testConfig({ DATA_ENCRYPTION_KEY: k, BLIND_INDEX_KEY: k })).toThrow(/must be different/);
  });

  it('refuses to disable MFA in production', () => {
    expect(() => testConfig({ NODE_ENV: 'production', ENFORCE_MFA: 'false' })).toThrow(/ENFORCE_MFA/);
  });
});

describe('files', () => {
  it('sniffs real types from magic bytes', () => {
    expect(sniffMime(Buffer.from('%PDF-1.7 ...'))).toBe('application/pdf');
    expect(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffMime(Buffer.from('<html>'))).toBeNull();
    expect(sniffMime(Buffer.from('MZ\x90\x00'))).toBeNull();
  });
  it('builds safe download names with the true extension', () => {
    expect(safeFileName('invoice".exe', 'application/pdf')).toBe('invoice.pdf');
    expect(safeFileName('', 'image/png')).toBe('document.png');
  });
});

describe('KYC rules', () => {
  it('normalises identifiers', () => {
    expect(normaliseId('ap05 2019-0012345')).toBe('AP0520190012345');
  });
  it('derives status from verified documents', () => {
    expect(kycStatusFor([])).toBe('PENDING');
    expect(kycStatusFor([{ verified_at: new Date() }])).toBe('PARTIAL');
    expect(kycStatusFor([{ verified_at: new Date() }, { verified_at: new Date() }])).toBe('VERIFIED');
  });
});
