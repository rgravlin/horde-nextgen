/**
 * What the machine under the canvas is: which backend it will hand us and what it says about
 * itself (TECH.md "Render backend").
 *
 * Two probes, kept out of `renderer.ts` because they are the only part of the view that has to
 * guess. `bootRenderer` builds the `WebGPURenderer` and lets `init()` resolve the backend —
 * WebGPU when the browser has `navigator.gpu`, WebGL2 when it does not (three falls back through
 * the renderer's `getFallback`), and nothing when neither works, which is the one case that earns
 * the "needs WebGL2" panel instead of a black canvas. `readMachine` then gathers the four facts
 * `pickTier` wants into one `MachineInfo`, so the tier decision stays in `quality.ts`, where a
 * test can write the inputs by hand.
 *
 * Everything here reads and nothing here draws: no scene, no materials, no assumptions about what
 * gets drawn with the answer.
 */

import { WebGPURenderer } from 'three/webgpu';

import type { Backend, DeviceKind, MachineInfo } from './quality';

/** The slice of `navigator` the tier choice reads; the DOM types are not installed here. */
interface NavigatorLike {
  readonly deviceMemory?: number;
  readonly userAgent?: string;
  readonly userAgentData?: { readonly mobile?: boolean };
}

/** The slice of an adapter this file reads; the WebGPU types are not installed. */
interface AdapterInfoLike {
  readonly description?: string;
  readonly vendor?: string;
  readonly architecture?: string;
}

/**
 * The slice of `navigator.gpu` used here, declared locally because `@webgpu/types`
 * is not a dependency of this project and cannot be added (TECH.md pins them).
 */
interface GpuLike {
  requestAdapter(): Promise<{ info?: AdapterInfoLike } | null>;
  requestAdapterInfo?(): AdapterInfoLike;
}

/** The renderer's `backend` is typed as the abstract class, which hides the flag. */
interface BackendLike {
  readonly isWebGPUBackend?: boolean;
  getContext?(): unknown;
}

/** A boot attempt: a renderer whose backend resolved, or why there is not one. */
export type MachineResult = { ok: true; renderer: WebGPURenderer } | { ok: false; message: string };

/**
 * Build the renderer and wait for it to pick its backend.
 *
 * `forceWebGL` is `?gl=webgl2`, or nothing: the same page then exercises both paths, which is the
 * only way the WebGL2 half of TECH.md's promise stays true rather than aspirational.
 */
export async function bootRenderer(canvas: HTMLCanvasElement, forceWebGL: boolean): Promise<MachineResult> {
  let renderer: WebGPURenderer;

  try {
    renderer = new WebGPURenderer({
      canvas,
      antialias: false,
      forceWebGL,
      alpha: false,
    });
    await renderer.init();
  } catch (error) {
    return { ok: false, message: `no WebGL2 or WebGPU context: ${String(error)}` };
  }

  // A WebGL2 backend with no context back means the browser cannot draw this at
  // all; say so rather than render an empty arena forever.
  if (backendOf(renderer) === 'webgl2' && !(renderer.getContext() as WebGL2RenderingContext | null)) {
    return { ok: false, message: 'getContext("webgl2") returned no context' };
  }

  return { ok: true, renderer };
}

/** Which backend the renderer settled on, in the words `__forgeState().backend` reports. */
export function backendOf(renderer: WebGPURenderer): Backend {
  return (renderer.backend as BackendLike).isWebGPUBackend === true ? 'webgpu' : 'webgl2';
}

/**
 * The four facts the tier choice reads, in the shape `quality.ts` asks for.
 *
 * The GPU name has to be awaited and the other two do not, which is the only reason this is
 * async. A probe that says nothing returns empty values rather than a guess: `pickTier` reads
 * silence as "a machine we cannot prove", and a fake name would buy the top tier.
 */
export async function readMachine(renderer: WebGPURenderer): Promise<MachineInfo> {
  const machine = machineInfo();
  return {
    backend: backendOf(renderer),
    gpuName: await gpuName(renderer),
    memory: machine.memory,
    deviceKind: machine.deviceKind,
  };
}

/**
 * What the machine calls its own GPU, or '' when it says nothing.
 *
 * The adapter's own words on WebGPU, and `WEBGL_debug_renderer_info`'s on WebGL2. That is the
 * whole input to the tier choice, and the two are deliberately the same type: a name is either
 * recognisable as a software rasteriser or it is not, and a probe that says nothing should not
 * buy the top tier (see `pickTier`).
 */
async function gpuName(renderer: WebGPURenderer): Promise<string> {
  try {
    const backend = renderer.backend as { isWebGPUBackend?: boolean };
    if (backend.isWebGPUBackend === true) {
      const gpu = (globalThis as { navigator?: { gpu?: GpuLike } }).navigator?.gpu;
      if (!gpu) return '';
      const adapter = await gpu.requestAdapter();
      const info = adapter?.info ?? gpu.requestAdapterInfo?.();
      return [info?.description, info?.vendor, info?.architecture].filter(Boolean).join(' ');
    }
    const gl = renderer.getContext() as WebGL2RenderingContext | null;
    const debug = gl?.getExtension('WEBGL_debug_renderer_info');
    return debug && gl ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : '';
  } catch {
    return '';
  }
}

/**
 * The two other things the tier wants, read off `navigator`.
 *
 * Both are honest about not existing: `deviceMemory` is Chromium-only and
 * `userAgentData` is gone in Firefox, and a browser that answers neither gets `unknown`, which
 * `pickTier` reads as "a desktop we cannot prove", not as a phone. A phone that lies about
 * being a phone is the case the memory cut catches.
 */
function machineInfo(): { memory: number; deviceKind: DeviceKind } {
  const nav = (globalThis as { navigator?: NavigatorLike }).navigator;
  if (!nav) return { memory: 0, deviceKind: 'unknown' };
  const memory = typeof nav.deviceMemory === 'number' ? nav.deviceMemory : 0;
  if (typeof nav.userAgentData?.mobile === 'boolean') {
    return { memory, deviceKind: nav.userAgentData.mobile ? 'mobile' : 'desktop' };
  }
  const agent = typeof nav.userAgent === 'string' ? nav.userAgent : '';
  const handheld = /Android|iPhone|iPad|iPod|Mobile/i.test(agent);
  return { memory, deviceKind: agent === '' ? 'unknown' : handheld ? 'mobile' : 'desktop' };
}