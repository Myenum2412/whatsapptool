import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'crypto';
import { promisify } from 'util';

/**
 * Password hashing for dashboard sign-in (POST /api/auth/login), via Node's builtin scrypt — no new
 * dependency, memory-hard, and the hash is self-describing (`scheme$N$r$p$salt$hash`) so parameters
 * can be raised later without invalidating existing rows.
 *
 * Stored in `users.passwordHash` (varchar 255), which fits the 179-character default encoding with
 * room to spare.
 */
const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

export const SCRYPT_N = 16_384;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
const KEYLEN_BYTES = 64;
const SALT_BYTES = 16;
const SCHEME = 'scrypt';

/** scrypt's own cap defaults to 32 MB, which N=16384/r=8 (16 MB working set) fits; scale with N/r
 * so a future parameter bump is not rejected at runtime, and never go below Node's floor. */
const maxmemFor = (n: number, r: number): number => Math.max(32 * 1024 * 1024, 256 * n * r);

/** A fixed salt for the work-equalizing dummy hash. Never part of a stored credential. */
const DUMMY_SALT = Buffer.alloc(SALT_BYTES, 0x5a);

/** Format a derived key + salt as the stored `scheme$params$salt$hash` string. */
const encode = (salt: Buffer, derived: Buffer, n: number, r: number, p: number): string =>
  `${SCHEME}$${n}$${r}$${p}$${salt.toString('hex')}$${derived.toString('hex')}`;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(password, salt, KEYLEN_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: maxmemFor(SCRYPT_N, SCRYPT_R),
  });
  return encode(salt, derived, SCRYPT_N, SCRYPT_R, SCRYPT_P);
}

interface ParsedHash {
  n: number;
  r: number;
  p: number;
  salt: Buffer;
  expected: Buffer;
}

/**
 * Parse a stored hash, or null when it is absent or malformed. Parameters are bounds-checked
 * before they reach scrypt: a corrupted row must fail closed as "invalid password", never start a
 * resource-exhausting KDF run with attacker-chosen cost parameters.
 */
function parseStored(stored: string | null): ParsedHash | null {
  if (!stored) return null;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== SCHEME) return null;
  const [, nRaw, rRaw, pRaw, saltHex, hashHex] = parts;
  const n = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
  if (n < 2 || n > 1_048_576 || (n & (n - 1)) !== 0) return null; // power of two, bounded
  if (r < 1 || r > 32 || p < 1 || p > 16) return null;
  if (!/^[0-9a-f]+$/i.test(saltHex) || !/^[0-9a-f]+$/i.test(hashHex)) return null;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  if (salt.length === 0 || expected.length === 0) return null;
  return { n, r, p, salt, expected };
}

/**
 * Constant-work outcome for an unusable stored hash: run scrypt against the same fixed dummy salt
 * so an unknown email and a wrong password cost the same wall time, and the response cannot be
 * used to enumerate accounts.
 */
async function dummyVerify(password: string): Promise<false> {
  await scrypt(password, DUMMY_SALT, KEYLEN_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: maxmemFor(SCRYPT_N, SCRYPT_R),
  });
  return false;
}

/** Verify a password against a stored hash. Returns false (never throws) for null/malformed input. */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const parsed = parseStored(stored);
  if (!parsed) return dummyVerify(password);
  const derived = await scrypt(password, parsed.salt, parsed.expected.length, {
    N: parsed.n,
    r: parsed.r,
    p: parsed.p,
    maxmem: maxmemFor(parsed.n, parsed.r),
  });
  return derived.length === parsed.expected.length && timingSafeEqual(derived, parsed.expected);
}
