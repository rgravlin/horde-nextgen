import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

describe('scaffold', () => {
  it('mounts a full-screen canvas container and a #ui overlay', () => {
    const html = read('index.html');
    expect(html).toContain('<div id="scene">');
    expect(html).toContain('<canvas id="gl"></canvas>');
    expect(html).toContain('<div id="ui">');
    expect(html).toContain('<script type="module" src="/src/main.ts">');
  });

  it('imports both self-hosted fonts from stylesheets that exist', () => {
    const main = read('src/main.ts');
    const sheets = [...main.matchAll(/'(@fontsource\/[^']+)'/g)].map((m) => m[1]);

    expect(sheets.length).toBeGreaterThan(0);
    expect(sheets.some((s) => s.startsWith('@fontsource/chakra-petch'))).toBe(true);
    expect(sheets.some((s) => s.startsWith('@fontsource/ibm-plex-mono'))).toBe(true);

    for (const sheet of sheets) {
      expect(existsSync(join(root, 'node_modules', sheet)), sheet).toBe(true);
    }
  });
});
