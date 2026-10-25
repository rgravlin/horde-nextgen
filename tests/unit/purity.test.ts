import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The import-purity gate from ARCHITECTURE.md: src/sim and src/content are the
 * headless game core, so they must not import the engine or touch the DOM, and
 * must not reach sideways into a presentation layer. Unit tests drive that core
 * in plain Node, which only works while the rule holds.
 */

const root = fileURLToPath(new URL('../../', import.meta.url));

/** Directories held to the rule. */
const GATED_DIRS = ['src/sim', 'src/content'];

/** Layers the core reads nothing from, even through a relative path. */
const FORBIDDEN_LAYERS = ['render', 'audio', 'ui', 'game', 'input', 'main.ts'];

/** Names that would tie the sim to an engine, a browser or a wall clock. */
const BANNED_NAMES = [
  'three',
  'window',
  'document',
  'localStorage',
  'sessionStorage',
  'navigator',
  'HTMLElement',
  'OffscreenCanvas',
  'AudioContext',
  'performance.now',
  'Date.now',
  'setTimeout',
  'setInterval',
  'clearTimeout',
  'clearInterval',
  'requestAnimationFrame',
  'Math.random',
];

/** Comments are prose; only code can break the rule. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

function importSpecifiers(source: string): string[] {
  const found: string[] = [];
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) found.push(match[1]);
  return found;
}

/** Every way this file could break the rule, as human-readable strings. */
function violations(file: string, source: string): string[] {
  const problems: string[] = [];
  const code = stripComments(source);

  for (const specifier of importSpecifiers(code)) {
    if (!specifier.startsWith('.')) {
      problems.push(`${file}: imports "${specifier}" (only relative imports are allowed in the core)`);
      continue;
    }
    const target = resolve(root, dirname(file), specifier).split(/[\\/]/).join('/');
    for (const layer of FORBIDDEN_LAYERS) {
      if (target.includes(`/src/${layer}`)) {
        problems.push(`${file}: imports the "${layer}" layer ("${specifier}")`);
      }
    }
  }

  for (const name of BANNED_NAMES) {
    const body = name.replace(/\./g, '\\.');
    // A leading "." is allowed so `window.document` reports both halves; the
    // trailing guard keeps prose words such as "documented" out of it.
    const pattern = new RegExp(`(^|[^\\w$])${body}(?![\\w$])`, 'g');
    if (pattern.test(code)) problems.push(`${file}: mentions "${name}" in code`);
  }

  return problems;
}

function gatedFiles(): string[] {
  const files: string[] = [];
  for (const dir of GATED_DIRS) {
    const abs = join(root, dir);
    if (!existsSync(abs)) continue;
    for (const entry of readdirSync(abs, { recursive: true })) {
      const rel = String(entry);
      if (!/\.(ts|tsx)$/.test(rel)) continue;
      const absFile = join(abs, rel);
      if (statSync(absFile).isFile()) files.push(`${dir}/${rel}`);
    }
  }
  return files;
}

describe('sim purity', () => {
  it('finds the gated sources', () => {
    // Guards against the checker quietly scanning nothing.
    expect(gatedFiles().length).toBeGreaterThan(0);
  });

  it('flags a planted engine import, DOM access and timer call', () => {
    const planted = [
      "import { Vector3 } from 'three';",
      "import { bloom } from 'three/tsl';",
      'export function bad(v: Vector3): unknown { return window.document.getElementById("gl") ?? v; }',
      'export function later(): void { setTimeout(() => {}, 0); }',
    ].join('\n');

    const found = violations('src/sim/planted.ts', planted);
    const text = found.join('\n');

    expect(found.length).toBeGreaterThan(0);
    expect(text).toContain('"three"');
    expect(text).toContain('"three/tsl"');
    expect(text).toContain('"window"');
    expect(text).toContain('"document"');
    expect(text).toContain('"setTimeout"');
  });

  it('flags a cross-layer relative import', () => {
    const found = violations('src/sim/step.ts', "import { camera } from '../render/camera';");
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('"render" layer');
  });

  it('keeps src/sim and src/content free of engine, DOM and timer imports', () => {
    const found: string[] = [];
    for (const file of gatedFiles()) {
      found.push(...violations(file, readFileSync(join(root, file), 'utf8')));
    }
    expect(found).toEqual([]);
  });
});
