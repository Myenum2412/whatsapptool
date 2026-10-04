import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { PluginLoaderService } from './plugin-loader.service';
import { PluginStorageService } from './plugin-storage.service';
import { HookManager } from '../hooks';
import { PluginStatus, PluginType, type PluginManifest } from './plugin.interfaces';
import type { PluginWorkerHost } from './sandbox/plugin-worker-host';

/**
 * The loader scans the legacy plugins directory in addition to the configured one, so a host that
 * has not migrated keeps its plugins. What it did not record was WHICH directory each package came
 * from, and the enable path resolved the worker entry against the configured tree instead â€” so a
 * plugin loaded from the legacy tree could be listed and reported as loaded, but never enabled.
 * Nothing here had test coverage, which is why that went unnoticed.
 */

const manifest: PluginManifest = {
  id: 'legacy-plg',
  name: 'Legacy Plugin',
  version: '1.0.0',
  type: PluginType.EXTENSION,
  main: 'index.js',
};

describe('PluginLoaderService â€” a plugin loaded from the legacy plugins directory', () => {
  let tmpDir: string;
  let configuredDir: string;
  let legacyDir: string;
  let config: ConfigService;
  let storage: PluginStorageService;
  let loader: LoaderWithFakeSandbox;

  /** Records what enableSandboxed asked the worker to require, and requires it for real. */
  const loadedMainPaths: string[] = [];

  class LoaderWithFakeSandbox extends PluginLoaderService {
    protected createSandboxHost(): PluginWorkerHost {
      return {
        load: (mainPath: string) => {
          loadedMainPaths.push(mainPath);
          // Exactly what sandbox/worker-bootstrap.ts does on a 'load' message. A path in the wrong
          // tree fails here with MODULE_NOT_FOUND, which is the defect's observable outcome.
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          require(mainPath);
          return Promise.resolve();
        },
        runLifecycle: () => Promise.resolve(),
        terminate: () => Promise.resolve(),
      } as unknown as PluginWorkerHost;
    }
  }

  const makeLoader = (): LoaderWithFakeSandbox =>
    new LoaderWithFakeSandbox(config, new HookManager(), storage, {} as unknown as ModuleRef);

  beforeEach(() => {
    loadedMainPaths.length = 0;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-legacy-dir-'));
    configuredDir = path.join(tmpDir, 'data', 'plugins');
    legacyDir = path.join(tmpDir, 'plugins');
    fs.mkdirSync(configuredDir, { recursive: true });

    // The package sits ONLY in the legacy tree â€” the shape of a host whose plugins predate the move.
    const pkg = path.join(legacyDir, manifest.id);
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'manifest.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(pkg, 'index.js'), 'module.exports = class {};');

    config = {
      get: (k: string) =>
        ({ dataDir: path.join(tmpDir, 'data'), 'plugins.dir': configuredDir, 'plugins.legacyDir': legacyDir })[k],
    } as unknown as ConfigService;
    storage = new PluginStorageService(config);
    loader = makeLoader();
    loader.onModuleInit();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('is loaded from the legacy directory in the first place', () => {
    expect(loader.getPlugin(manifest.id)).toBeDefined();
  });

  it('enables, requiring its entry from the tree it was loaded from', async () => {
    await loader.enablePlugin(manifest.id);

    expect(loader.getPlugin(manifest.id)?.status).toBe(PluginStatus.ENABLED);
    expect(loadedMainPaths).toEqual([path.join(legacyDir, manifest.id, 'index.js')]);
  });
});
