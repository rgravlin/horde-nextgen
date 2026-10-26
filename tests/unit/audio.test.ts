import { describe, expect, it } from 'vitest';

import {
  createEngine,
  type AudioGraph,
  type BufferLike,
  type CompLike,
  type DelayLike,
  type FilterLike,
  type GainLike,
  type NodeLike,
  type OscLike,
  type PannerLike,
  type ParamLike,
  type SourceLike,
} from '../../src/audio/synth';
import { hashWorld } from '../../src/sim/hash';
import { createInputFrame } from '../../src/sim/input';
import { step } from '../../src/sim/step';
import { spawnEnemy } from '../../src/sim/systems/enemies';
import { createWorld, type World } from '../../src/sim/world';

/**
 * The synth engine, driven against a fake `AudioContext`.
 *
 * There is no audio device in Node, so the fake is part of the subject as much as the engine is:
 * it is a strict stand-in that throws on the three things a real WebAudio graph throws on (a
 * non-finite or negative time, an exponential ramp whose target is zero, a non-finite value),
 * which is how a voice with a bad envelope gets caught here instead of on the first frame of a run
 * in a browser. It also records what got built, which is the only way to see an arrangement at
 * all: a song is not a value, it is a list of oscillators and their times.
 *
 * Four things are pinned. That the score plays, and plays *thicker* with the horde rather than
 * thinner (the intensity tiers are the whole idea of `songs.ts`). That two identical runs schedule
 * identical voices — the replay's promise extended to the mix, and the reason the engine has its
 * own noise generator instead of `Math.random`. That listening changes nothing about what is
 * listened to: a `World` stepped with audio attached hashes the same as one stepped in silence,
 * which is the check that keeps audio out of the sim's rng. And that a broken audio device costs
 * one report, not one error per frame.
 */

/** Everything one fake graph recorded. */
interface Tape {
  /** One entry per voice that reached `start`: its kind, its time and its pitch. */
  voices: string[];
  /** Every `setTargetAtTime`, as `param=value`. Only the duck and the four knobs use it. */
  targets: string[];
}

interface Fake {
  graph: AudioGraph;
  clock: { t: number };
  tape: Tape;
  resumes: number;
}

/**
 * A stand-in context.
 *
 * `state: 'suspended'` exercises the autoplay knock and `failOscillators` the dead-device path;
 * both are options rather than separate fakes because the graph shape they need is the same one.
 */
function createFake(options: { state?: string; failOscillators?: boolean } = {}): Fake {
  const tape: Tape = { voices: [], targets: [] };
  const clock = { t: 0 };
  const fake = { clock, tape, resumes: 0 } as Fake & { graph?: AudioGraph };
  let names = 0;

  function param(label: string): ParamLike {
    const name = `${label}${names++}`;
    const p: ParamLike = {
      value: 0,
      setValueAtTime(value: number, time: number) {
        if (!Number.isFinite(time) || time < 0) throw new Error(`${name}: time ${time}`);
        if (!Number.isFinite(value)) throw new Error(`${name}: value ${value}`);
        return p;
      },
      linearRampToValueAtTime(value: number, time: number) {
        if (!Number.isFinite(time) || time < 0) throw new Error(`${name}: time ${time}`);
        if (!Number.isFinite(value)) throw new Error(`${name}: value ${value}`);
        return p;
      },
      exponentialRampToValueAtTime(value: number, time: number) {
        if (value === 0) throw new Error(`${name}: an exponential ramp cannot reach zero`);
        if (!Number.isFinite(time) || time < 0) throw new Error(`${name}: time ${time}`);
        return p;
      },
      setTargetAtTime(value: number, time: number, constant: number) {
        if (!Number.isFinite(value) || !Number.isFinite(time) || time < 0) {
          throw new Error(`${name}: target ${value}@${time}`);
        }
        if (!(constant > 0)) throw new Error(`${name}: constant ${constant}`);
        tape.targets.push(`${name}=${value}`);
        return p;
      },
    };
    return p;
  }

  const wires = (): NodeLike => ({
    connect: () => undefined,
    disconnect: () => undefined,
  });

  /** A voice's fingerprint, taken the moment it is switched on. */
  function started(kind: string, pitch: () => number): { start(when: number): void; stop(when: number): void } {
    return {
      start(when: number) {
        if (!Number.isFinite(when)) throw new Error(`${kind}: start at ${when}`);
        tape.voices.push(`${kind}@${when.toFixed(5)}:${pitch().toFixed(2)}`);
      },
      stop: () => {},
    };
  }

  const destination: NodeLike = wires();

  const graph: AudioGraph = {
    get currentTime() {
      return clock.t;
    },
    sampleRate: 48000,
    destination,
    state: options.state ?? 'running',
    resume: () => {
      fake.resumes++;
    },
    createGain(): GainLike {
      return { ...wires(), gain: param('gain') };
    },
    createOscillator(): OscLike {
      if (options.failOscillators) throw new Error('the oscillator stack is gone');
      const frequency = param('freq');
      return {
        ...wires(),
        type: 'sine',
        frequency,
        detune: param('detune'),
        ...started('osc', () => frequency.value),
      };
    },
    createBufferSource(): SourceLike {
      const playbackRate = param('rate');
      return {
        ...wires(),
        buffer: null as BufferLike | null,
        loop: false,
        playbackRate,
        ...started('src', () => playbackRate.value),
      };
    },
    createBuffer(_channels: number, length: number, sampleRate: number): BufferLike {
      return {
        length,
        sampleRate,
        getChannelData: () => new Float32Array(length),
      };
    },
    createBiquadFilter(): FilterLike {
      return { ...wires(), type: 'lowpass', frequency: param('cut'), Q: param('q') };
    },
    createStereoPanner(): PannerLike {
      return { ...wires(), pan: param('pan') };
    },
    createDelay(_max: number): DelayLike {
      return { ...wires(), delayTime: param('delay') };
    },
    createDynamicsCompressor(): CompLike {
      return {
        ...wires(),
        threshold: param('th'),
        ratio: param('ra'),
        attack: param('at'),
        release: param('re'),
      };
    },
  };

  fake.graph = graph;
  return fake as Fake;
}

/** Run `frames` frames of one engine against one world, the way the shell does it once a frame. */
function drive(
  fake: Fake,
  engine: ReturnType<typeof createEngine>,
  world: World,
  frames: number,
  dt: number = 1 / 60,
): { music: number; sfx: number } {
  let music = 0;
  let sfx = 0;
  for (let f = 0; f < frames; f++) {
    engine.frame(world, 'playing', dt, { master: 1, sfx: 1, music: 0.7, muted: false });
    music += engine.report.music;
    sfx += engine.report.sfx;
    fake.clock.t += dt;
  }
  return { music, sfx };
}

/** A world with `n` bodies on it, close enough to hear, optionally with the encounter on. */
function worldWith(n: number, boss = false): World {
  const world = createWorld(7);
  for (let i = 0; i < n; i++) {
    const angle = (i * 2.399963) % (Math.PI * 2);
    const r = 4 + (i % 9);
    spawnEnemy(world, i % 3, Math.cos(angle) * r, Math.sin(angle) * r);
  }
  world.boss.alive = boss;
  return world;
}

describe('the synth', () => {
  it('plays a score, and a thicker one the bigger the horde is', () => {
    // Three engines, three arrangements of the same song: an empty room, a horde, and a horde
    // with the encounter on. The numbers are the arrangement — the first is tier 0's bed, and each
    // step up is the layers `songs.ts` marks `from: 1`, `from: 2` and `boss: true` joining in.
    const thin = createFake();
    const thinRun = drive(thin, createEngine(thin.graph), worldWith(0), 300);

    const thick = createFake();
    const thickRun = drive(thick, createEngine(thick.graph), worldWith(400), 300);

    const boss = createFake();
    const bossRun = drive(boss, createEngine(boss.graph), worldWith(400, true), 300);

    expect(thinRun.music).toBeGreaterThan(0);
    expect(thickRun.music).toBeGreaterThan(thinRun.music * 2);
    // The wail is one part out of ten, so the difference is small — but it has to be there, and
    // it has to be gone the moment the encounter is not.
    expect(bossRun.music).toBeGreaterThan(thickRun.music + 5);
  });

  it('schedules the same voices twice, to the microsecond', () => {
    // The replay's promise, applied to the mix: no `Math.random`, no dependence on which frame a
    // callback happened to land in. Both engines get their own world and their own fake clock,
    // started the same way, and the two tapes have to be the same list.
    const a = createFake();
    const b = createFake();
    drive(a, createEngine(a.graph), worldWith(120), 400);
    drive(b, createEngine(b.graph), worldWith(120), 400);

    expect(a.tape.voices.length).toBeGreaterThan(100);
    expect(b.tape.voices).toEqual(a.tape.voices);
  });

  it('hears the run without changing it', () => {
    // The rule behind the fake: audio reads the event ring through its own cursor and never touches
    // the sim's rng. Attach it to a run and the run's fingerprint has to survive — which is only
    // true because nothing here can write a `World`.
    const quiet = createWorld(3);
    const heard = createWorld(3);
    const fake = createFake();
    const engine = createEngine(fake.graph);
    const frame = createInputFrame();

    for (const world of [quiet, heard]) {
      for (let i = 0; i < 40; i++) {
        spawnEnemy(world, i % 4, 3 + (i % 7), (i % 5) - 2);
      }
    }

    // Both runs then step the same 400 ticks with the same intent; only the second is being
    // listened to, and the audio pass happens in the middle of it, once a frame.
    frame.fire = true;
    frame.moveX = 0.5;
    for (let f = 0; f < 400; f++) {
      step(quiet, frame);
      step(heard, frame);
      engine.frame(heard, 'playing', 1 / 60, { master: 1, sfx: 1, music: 0.7, muted: false });
      fake.clock.t += 1 / 60;
    }

    expect(hashWorld(heard)).toBe(hashWorld(quiet));
  });

  it('turns event noise into voices', () => {
    // A gun into a crowd is the case the mixer exists for: hundreds of events a second, and the
    // budget plus the per-recipe gap are what keep that from being a buzz.
    const fake = createFake();
    const engine = createEngine(fake.graph);
    const world = worldWith(60);
    const frame = createInputFrame();
    let sfx = 0;
    for (let f = 0; f < 400; f++) {
      for (let tick = 0; tick < 3; tick++) {
        frame.fire = true;
        step(world, frame);
      }
      engine.frame(world, 'playing', 3 / 60, { master: 1, sfx: 1, music: 0.7, muted: false });
      sfx += engine.report.sfx;
      fake.clock.t += 3 / 60;
    }

    expect(sfx).toBeGreaterThan(20);
    expect(engine.alive).toBe(true);
  });

  it('ducks on the cards and lifts when they are gone', () => {
    const fake = createFake();
    const engine = createEngine(fake.graph);
    const world = worldWith(20);
    const levels = { master: 1, sfx: 1, music: 0.7, muted: false };
    const before = (): number => fake.tape.targets.length;

    // Frame one is the only frame where the knobs move, and the duck moves with them: one call for
    // each gain the settings own, plus the duck settling at "play".
    const first = before();
    engine.frame(world, 'playing', 1 / 60, levels);
    expect(fake.tape.targets.slice(first)).toHaveLength(4);

    // A steady scene automates nothing. Sixty calls a second on one param is how a fade turns
    // into a hum, so the scene is remembered rather than re-read.
    const steady = before();
    for (let f = 0; f < 30; f++) engine.frame(world, 'playing', 1 / 60, levels);
    expect(before()).toBe(steady);

    // The cards: one call, to the level DESIGN.md asks for. It is a number no voice envelope uses,
    // so finding it in the tape is finding the duck itself.
    const change = before();
    engine.frame(world, 'levelup', 1 / 60, levels);
    const ducked = fake.tape.targets.slice(change);
    expect(ducked).toHaveLength(1);
    expect(ducked[0]?.endsWith('=0.32')).toBe(true);

    const back = before();
    engine.frame(world, 'playing', 1 / 60, levels);
    const lifted = fake.tape.targets.slice(back);
    expect(lifted).toHaveLength(1);
    expect(lifted[0]?.endsWith('=1')).toBe(true);
  });

  it('thins the mix out when the machine falls behind', () => {
    // A 25 fps run: the frame-time average passes the threshold and the budget drops to two voices
    // a frame. Refusals are the expected outcome here, not a fault — that is what a deliberately
    // thin mix means.
    const fake = createFake();
    const engine = createEngine(fake.graph);
    const world = worldWith(400, true);
    let last = 10;
    let refused = 0;
    for (let f = 0; f < 200; f++) {
      engine.frame(world, 'playing', 0.04, { master: 1, sfx: 1, music: 0.7, muted: false });
      last = engine.report.budget;
      refused = Math.max(refused, engine.report.refused);
      fake.clock.t += 0.04;
    }

    expect(last).toBe(2);
    expect(refused).toBeGreaterThan(0);
  });

  it('gives up once when the device is broken, instead of every frame', () => {
    const fake = createFake({ failOscillators: true });
    const problems: string[] = [];
    const engine = createEngine(fake.graph, { note: (p) => problems.push(p) });
    const world = worldWith(40);

    for (let f = 0; f < 60; f++) {
      engine.frame(world, 'playing', 1 / 60, { master: 1, sfx: 1, music: 0.7, muted: false });
      fake.clock.t += 1 / 60;
    }

    expect(engine.alive).toBe(false);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('audio:');
    // Silent from there on: no throw, and nothing left to build.
    const built = fake.tape.voices.length;
    engine.frame(world, 'playing', 1 / 60, { master: 1, sfx: 1, music: 0.7, muted: false });
    expect(fake.tape.voices).toHaveLength(built);
  });

  it('keeps knocking on a suspended context, about once a second', () => {
    const fake = createFake({ state: 'suspended' });
    const engine = createEngine(fake.graph);
    const world = worldWith(0);
    for (let f = 0; f < 180; f++) {
      engine.frame(world, 'playing', 1 / 60, { master: 1, sfx: 1, music: 0.7, muted: false });
      fake.clock.t += 1 / 60;
    }

    // Three seconds of frames, one knock a second, and the run plays while it waits.
    expect(fake.resumes).toBe(3);
    expect(engine.alive).toBe(true);
  });

  it('changes tune with the floor, and keeps playing', () => {
    const fake = createFake();
    const engine = createEngine(fake.graph);
    const world = worldWith(120);

    drive(fake, engine, world, 60);
    const first = fake.tape.voices.length;
    expect(first).toBeGreaterThan(0);

    // Floor 5 is a different song (`songForChapter` folds ten chapters onto three tracks), so the
    // retune has to survive a live sequencer rather than wedge it.
    world.chapter = 5;
    drive(fake, engine, world, 120);
    expect(fake.tape.voices.length).toBeGreaterThan(first + 50);

    world.chapter = 9;
    drive(fake, engine, world, 60);
    expect(engine.alive).toBe(true);
  });
});
