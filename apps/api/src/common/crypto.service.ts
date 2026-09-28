import { Inject, Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppConfig, CONFIG } from '../config/config';

const KEY_VERSION = 1;

/**
 * Application-level encryption for restricted fields (doc 11 §4.2).
 * Envelope: [version:1][iv:12][tag:16][ciphertext]. The AAD binds a ciphertext to its column,
 * so a value copied into another column fails to decrypt.
 * Production swaps the static key for a KMS-wrapped data key; the envelope already carries a version.
 */
@Injectable()
export class CryptoService {
  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  readonly keyVersion = KEY_VERSION;

  encrypt(plaintext: string, aad: string): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.config.dataKey, iv);
    cipher.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([Buffer.from([KEY_VERSION]), iv, cipher.getAuthTag(), ct]);
  }

  decrypt(blob: Buffer, aad: string): string {
    if (blob[0] !== KEY_VERSION) throw new Error(`Unknown key version ${blob[0]}`);
    const iv = blob.subarray(1, 13);
    const tag = blob.subarray(13, 29);
    const decipher = createDecipheriv('aes-256-gcm', this.config.dataKey, iv);
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(blob.subarray(29)), decipher.final()]).toString('utf8');
  }

  /** Deterministic keyed hash for exact-match lookup of an encrypted value. */
  blindIndex(kind: string, normalisedValue: string): Buffer {
    return createHmac('sha256', this.config.blindIndexKey).update(`${kind}:${normalisedValue}`).digest();
  }

  static token(bytes = 32): string {
    return randomBytes(bytes).toString('base64url');
  }

  static sha256(value: string | Buffer): Buffer {
    return createHash('sha256').update(value).digest();
  }

  static safeEqual(a: Buffer, b: Buffer): boolean {
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
