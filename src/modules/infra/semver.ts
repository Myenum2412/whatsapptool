/**
 * Compare two `MAJOR.MINOR.PATCH` strings (pre-release suffixes ignored). Returns -1 | 0 | 1.
 *
 * Used by the update check to decide whether the published release is newer than the running build.
 */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string) =>
    String(v)
      .split('-')[0]
      .split('.')
      .map(n => Number.parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}
