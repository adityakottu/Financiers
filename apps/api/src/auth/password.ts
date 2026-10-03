import { hash, verify } from '@node-rs/argon2';

// argon2id (algorithm 2), 64 MiB, 3 passes — doc 11 §2.
const OPTIONS = { algorithm: 2 as const, memoryCost: 65536, timeCost: 3, parallelism: 1 };

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  try {
    return await verify(stored, password);
  } catch {
    return false;
  }
}

/** Verified against when the username is unknown, so response time doesn't reveal which accounts exist. */
let dummy: Promise<string> | undefined;
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword('dummy-password-for-timing-0');
  return dummy;
}
