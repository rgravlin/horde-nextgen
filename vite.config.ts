import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    // Vite's default binds to whatever `localhost` happens to resolve to, which on
    // this box is the IPv6 loopback only, so probes (and playwright's webServer
    // health check) to 127.0.0.1 fail. Bind IPv4 loopback explicitly; the port
    // stays a single source of truth in playwright.config.ts.
    host: '127.0.0.1',
    strictPort: true,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
});