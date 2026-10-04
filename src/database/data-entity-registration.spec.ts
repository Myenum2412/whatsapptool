import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { globSync } from 'glob';
import dataDataSource from './data-source';

/**
 * A DATA-owned entity that is absent from the runtime connection (`app.module.ts`) does not fail at
 * boot: `TypeOrmModule.forFeature([X], 'data')` resolves a repository lazily, so the app starts and
 * only the first query throws `EntityMetadataNotFoundError` — surfaced to the caller as a bare
 * "Internal server error" 500. That is exactly how the `plans` endpoint shipped broken (the entity
 * was in neither the runtime entity list nor the CLI `data-source.ts` list, so `synchronize` never
 * created the `plans` table).
 *
 * This gate binds both lists to what is actually on disk: every entity file under a DATA-owned
 * module must be matched by the runtime globs AND by the CLI globs. A future module that copies the
 * `plan` module's wiring but forgets an entity glob fails here instead of in production.
 */
describe('DATA-owned entities are registered on the runtime and CLI connections', () => {
  // The always-SQLite MAIN connection (auth/audit/tenancy) is deliberately NOT part of the data
  // glob lists, so those owners are excluded from the expectation.
  const MAIN_OWNED = new Set(['auth', 'audit', 'tenancy']);

  const toPosix = (file: string): string => file.replace(/\\/g, '/');

  const ownerOf = (file: string): string | null => {
    const posix = toPosix(file);
    const moduleOwner = posix.match(/^src\/modules\/([^/]+)\//);
    if (moduleOwner) return moduleOwner[1];
    if (posix.startsWith('src/engine/')) return 'engine';
    return null;
  };

  const dataEntityFilesOnDisk = (): Set<string> =>
    new Set(
      globSync(['src/modules/**/*.entity.ts', 'src/engine/**/*.entity.ts'])
        .map(toPosix)
        .filter(file => {
          const owner = ownerOf(file);
          return owner !== null && !MAIN_OWNED.has(owner);
        }),
    );

  /** Resolved files behind the CLI data connection's entity globs. */
  const cliEntityFiles = (): Set<string> =>
    new Set(
      (dataDataSource.options.entities as string[])
        .flatMap(pattern => globSync(pattern))
        .map(toPosix)
        .map(file => file.replace(/^.*\/src\//, 'src/')),
    );

  /** Resolved files behind the runtime data connection's entity globs, read from app.module.ts. */
  const runtimeEntityFiles = (): Set<string> => {
    const source = readFileSync(join(__dirname, '..', 'app.module.ts'), 'utf8');
    // Runtime globs are `__dirname + '/modules/x/**/*.entity{.ts,.js}'`; __dirname is src/.
    const literals = [...source.matchAll(/__dirname\s*\+\s*'([^']+\.entity[^']*)'/g)].map(match => match[1]);
    return new Set(
      literals
        .map(value => toPosix(`src${value}`))
        .flatMap(pattern => globSync(pattern))
        .map(toPosix),
    );
  };

  it('registers every DATA-owned entity on the runtime connection', () => {
    const runtime = runtimeEntityFiles();
    for (const file of dataEntityFilesOnDisk()) {
      expect(runtime.has(file)).toBe(true);
    }
  });

  it('registers every DATA-owned entity on the migration CLI connection', () => {
    const cli = cliEntityFiles();
    for (const file of dataEntityFilesOnDisk()) {
      expect(cli.has(file)).toBe(true);
    }
  });

  it('keeps the plan entity registered (regression: /flow plan creation 500)', () => {
    const plan = 'src/modules/plan/entities/plan.entity.ts';
    expect(dataEntityFilesOnDisk().has(plan)).toBe(true);
    expect(runtimeEntityFiles().has(plan)).toBe(true);
    expect(cliEntityFiles().has(plan)).toBe(true);
  });
});
