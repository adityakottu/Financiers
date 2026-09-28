import { describe, expect, it } from 'vitest';
import {
  customerCreateSchema,
  mobileSchema,
  panSchema,
  passwordProblems,
  SYSTEM_ROLES,
  ALL_PERMISSIONS,
  widestScope,
  mask,
} from './index';

describe('validators', () => {
  it('normalises Indian mobiles', () => {
    expect(mobileSchema.parse('+91 98765 43210')).toBe('9876543210');
    expect(mobileSchema.parse('09876543210')).toBe('9876543210');
    expect(mobileSchema.safeParse('1234567890').success).toBe(false);
  });

  it('validates PAN', () => {
    expect(panSchema.parse('abcde1234f')).toBe('ABCDE1234F');
    expect(panSchema.safeParse('ABCD1234F').success).toBe(false);
  });

  it('enforces password strength', () => {
    expect(passwordProblems('short1')).toContain('Password must be at least 10 characters');
    expect(passwordProblems('onlyletterslong')).toContain('Password must contain letters and numbers');
    expect(passwordProblems('Password1234')).toContain('Password is too common');
    expect(passwordProblems('ravi2026secure', 'ravi')).toContain('Password must not contain your username');
    expect(passwordProblems('Tulasi#Kakinada88')).toEqual([]);
  });

  it('customer schema rejects unknown fields and full Aadhaar', () => {
    const base = { branchId: '0190a0b0-0000-7000-8000-000000000001', fullName: 'Ravi Kumar', mobile: '9876543210' };
    expect(customerCreateSchema.safeParse(base).success).toBe(true);
    expect(customerCreateSchema.safeParse({ ...base, hacker: 1 }).success).toBe(false);
    expect(
      customerCreateSchema.safeParse({ ...base, kyc: { aadhaarLast4: '123412341234' } }).success,
    ).toBe(false);
  });

  it('masks identifiers', () => {
    expect(mask.mobile('9876543210')).toBe('98XXXXX210');
    expect(mask.aadhaar('1234')).toBe('XXXX XXXX 1234');
    expect(mask.pan('234F')).toBe('XXXXXX234F');
  });
});

describe('roles', () => {
  it('super admin has every permission; collectors cannot manage anything', () => {
    const admin = SYSTEM_ROLES.find((r) => r.code === 'SUPER_ADMIN')!;
    expect(admin.permissions.sort()).toEqual([...ALL_PERMISSIONS].sort());
    const collector = SYSTEM_ROLES.find((r) => r.code === 'COLLECTION_EMPLOYEE')!;
    expect(collector.permissions.some((p) => p.endsWith('.manage'))).toBe(false);
    expect(collector.permissions).not.toContain('kyc.reveal');
  });
  it('picks the widest scope', () => {
    expect(widestScope(['ASSIGNED', 'BRANCH'])).toBe('BRANCH');
    expect(widestScope(['BRANCH', 'ALL'])).toBe('ALL');
    expect(widestScope([])).toBe('ASSIGNED');
  });
});
