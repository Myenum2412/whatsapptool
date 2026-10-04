import { compareSemver } from './semver';

describe('compareSemver', () => {
  it('orders by major, minor, then patch', () => {
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
    expect(compareSemver('1.2.0', '1.1.9')).toBe(1);
    expect(compareSemver('0.9.9', '1.0.0')).toBe(-1);
    expect(compareSemver('2.0.0', '1.9.9')).toBe(1);
  });

  it('ignores a pre-release suffix and missing segments', () => {
    expect(compareSemver('1.2.0-beta.1', '1.2.0')).toBe(0);
    expect(compareSemver('1.2', '1.2.0')).toBe(0);
    expect(compareSemver('garbage', '0.0.0')).toBe(0);
  });
});
