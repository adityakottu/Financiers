import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, generateSecret, hotp, totp, verifyTotp } from './totp';

describe('TOTP (RFC 6238 / RFC 4226)', () => {
  const rfcKey = Buffer.from('12345678901234567890');

  it('matches RFC 4226 HOTP test vectors', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    expected.forEach((code, i) => expect(hotp(rfcKey, i)).toBe(code));
  });

  it('matches RFC 6238 SHA-1 TOTP vectors (8 digits)', () => {
    const vectors: [number, string][] = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
    ];
    for (const [t, code] of vectors) expect(hotp(rfcKey, Math.floor(t / 30), 8)).toBe(code);
  });

  it('base32 round-trips', () => {
    const buf = Buffer.from('any carnal pleasure');
    expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
  });

  it('verifies current and adjacent steps only', () => {
    const secret = generateSecret();
    const now = 1_760_000_000_000;
    expect(verifyTotp(secret, totp(secret, now), now)).not.toBeNull();
    expect(verifyTotp(secret, totp(secret, now - 30_000), now)).not.toBeNull();
    expect(verifyTotp(secret, totp(secret, now - 90_000), now)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', now)).toBeNull();
  });
});
