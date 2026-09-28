import { describe, expect, it } from 'vitest';
import { fiscalYear, renderNumber } from './numbering.service';

describe('numbering', () => {
  it('uses the April–March Indian financial year in IST', () => {
    expect(fiscalYear(new Date('2026-03-31T18:00:00Z'))).toBe(2025); // 31 Mar 23:30 IST
    expect(fiscalYear(new Date('2026-03-31T18:31:00Z'))).toBe(2026); // 1 Apr 00:01 IST
    expect(fiscalYear(new Date('2026-12-01T00:00:00Z'))).toBe(2026);
  });

  it('renders formats', () => {
    expect(renderNumber('REC-{BR}-{FY}-{SEQ:6}', { fy: 2026, year: 2026, branchCode: 'KKD', seq: 42 })).toBe(
      'REC-KKD-2026-000042',
    );
    expect(renderNumber('CUST/{FYS}/{SEQ:5}', { fy: 2026, year: 2027, seq: 1 })).toBe('CUST/2026-27/00001');
    expect(renderNumber('X{SEQ}', { fy: 2099, year: 2099, seq: 1234567 })).toBe('X1234567');
  });
});
