import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Single source of truth for the version shown in the dashboard: the ROOT package.json, which is
// what a release bumps and what `npm run check:versions` gates. Resolved relative to this config
// file (not process.cwd()), because the dashboard is normally built from inside `dashboard/` — where
// cwd-relative resolution picks up `dashboard/package.json` instead. That file is not touched by a
// release, so the Login screen kept rendering whatever version it happened to be pinned at while the
// gateway moved on. The sidebar hid the drift by replacing the build-time value with the live
// version from the API (see Layout.tsx); the Login screen has no session yet, so it shows this
// constant verbatim. APP_VERSION env still overrides if explicitly provided.
function resolveAppVersion(): string {
  // Primary source: ROOT package.json (what a release bumps). Resolved relative to this config
  // file (not process.cwd()), because the dashboard is normally built from inside `dashboard/`.
  // Falls back to dashboard/package.json so standalone deploys (e.g. Vercel with root
  // directory = dashboard, where the parent package.json is not uploaded) still build.
  const candidates = [
    new URL('../package.json', import.meta.url),
    new URL('./package.json', import.meta.url),
  ];
  for (const candidate of candidates) {
    try {
      const { version } = JSON.parse(readFileSync(candidate, 'utf-8')) as {
        version: string;
      };
      if (version) return version;
    } catch {
      // try next candidate
    }
  }
  return '0.0.0';
}

const pkgVersion = resolveAppVersion();

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  appType: 'spa', // Enable SPA fallback for client-side routing
  define: {
    __APP_VERSION__: JSON.stringify(process.env.APP_VERSION || pkgVersion),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  server: {
    port: 2886,
    proxy: {
      '/api': {
        target: 'http://localhost:2785',
        changeOrigin: true,
        secure: false,
      },
      // Proxy the WebSocket (socket.io) transport so the dashboard's real-time
      // chats/sessions streams work against the dev backend.
      '/socket.io': {
        target: 'http://localhost:2785',
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
