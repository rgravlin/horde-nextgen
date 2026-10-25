import { defineConfig, devices } from '@playwright/test';

// SwiftShader flags: this box has no real GPU, so both the WebGPU and the WebGL2
// paths have to be exercised through software rasterisation (TECH.md).
const chromiumArgs = [
  '--enable-unsafe-webgpu',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--enable-features=Vulkan',
];

// vite.config.ts binds the dev server to 127.0.0.1, so the probe and the browser
// both use that address rather than `localhost` (which resolves to ::1 here).
const port = 5173;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'off',
  },
  webServer: {
    command: `npx vite --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: true,
    timeout: 60_000,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: { args: chromiumArgs },
      },
    },
  ],
});