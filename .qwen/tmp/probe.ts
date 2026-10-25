/* Scratch probe: does the chapter arc actually run once a chapter is installed? */
import { createWorld } from '../../src/sim/world';
import { step } from '../../src/sim/step';
import { createInputFrame, resetFrame } from '../../src/sim/input';
import { startChapter } from '../../src/sim/systems/levels';
import { LEVELS } from '../../src/content/levels';

function probe(chapter: number, ticks: number) {
  const w = createWorld(7);
  startChapter(w, chapter);
  console.log(
    `chapter ${chapter} (${LEVELS[chapter].id}): props=${w.props.n} dropped=${w.props.dropped} zones=${w.zones.n}`,
  );
  const f = createInputFrame();
  const log: string[] = [];
  let lastPhase = w.wave.phase;
  let lastChapter = w.chapter;
  for (let t = 1; t <= ticks; t++) {
    resetFrame(f);
    f.fire = true;
    f.moveX = t % 12 < 6 ? 1 : -1;
    step(w, f);
    if (w.wave.phase !== lastPhase || w.chapter !== lastChapter) {
      log.push(
        `t=${t} phase ${lastPhase}->${w.wave.phase} chapter ${lastChapter}->${w.chapter} enemies=${w.enemies.count} playerHP=${Math.round(w.player.hp)} over=${w.over}`,
      );
      lastPhase = w.wave.phase;
      lastChapter = w.chapter;
    }
    if (w.over) {
      log.push(`t=${t} dead`);
      break;
    }
  }
  console.log(log.join('\n'));
  console.log(`end: chapter=${w.chapter} phase=${w.wave.phase} enemies=${w.enemies.count} errors=${w.errors}`);
}

probe(0, 6000);
console.log('---');
probe(4, 6000);
console.log('--- kill-floor, 4000 ticks');
probe(9, 4000);