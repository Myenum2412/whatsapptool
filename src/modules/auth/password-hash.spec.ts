import { hashPassword, verifyPassword, SCRYPT_N, SCRYPT_R, SCRYPT_P } from './password-hash';

describe('password-hash', () => {
  it('round-trips a password', async () => {
    const stored = await hashPassword('correct elephant battery-staple');
    expect(await verifyPassword('correct elephant battery-staple', stored)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const stored = await hashPassword('right-password');
    expect(await verifyPassword('wrong-password', stored)).toBe(false);
  });

  it('rejects a null stored hash (the unknown-user path)', async () => {
    expect(await verifyPassword('anything', null)).toBe(false);
  });

  it('rejects a stored hash of an unknown scheme', async () => {
    expect(await verifyPassword('x', 'bcrypt$10$abc')).toBe(false);
  });

  it('rejects a malformed parameter set without throwing', async () => {
    const stored = await hashPassword('pw');
    const [, , , , saltHex, hashHex] = stored.split('$');
    const n = (1 << 20) * 2; // beyond the bound — a corrupted row must fail closed, never start a KDF run
    const evil = `scrypt$${n}$${SCRYPT_R}$${SCRYPT_P}$${saltHex}$${hashHex}`;
    expect(await verifyPassword('pw', evil)).toBe(false);
  });

  it('rejects a tampered hash portion', async () => {
    const stored = await hashPassword('pw');
    const tampered = stored.slice(0, -1) + (stored.endsWith('0') ? '1' : '0');
    expect(await verifyPassword('pw', tampered)).toBe(false);
  });

  it('emits the self-describing scrypt format within the users.passwordHash column width', async () => {
    const stored = await hashPassword('pw');
    expect(stored.startsWith(`scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$`)).toBe(true);
    expect(stored.length).toBeLessThanOrEqual(255);
  });

  it('uses a fresh salt per hash (two hashes of the same password differ)', async () => {
    const a = await hashPassword('same');
    const b = await hashPassword('same');
    expect(a).not.toBe(b);
    expect(await verifyPassword('same', a)).toBe(true);
    expect(await verifyPassword('same', b)).toBe(true);
  });
});
