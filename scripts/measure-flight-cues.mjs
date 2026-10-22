import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

// Run sequentially on each revision with the same installed dependencies:
// node --import tsx scripts/measure-flight-cues.mjs [repository-root]
const root = resolve(process.argv[2] ?? '.');
const moduleAt = file => import(pathToFileURL(resolve(root, 'src', file)).href);
const { createGame, startGame, flightTargetLineOfSight } = await moduleAt('simulation.ts');
const { updateQuaternion } = await moduleAt('flight.ts');
const { predictBombEffect } = await moduleAt('bomb-guide.ts');
const { checkGuidedTorpedoRelease } = await moduleAt('ordnance.ts');
const { aimIndicator } = await moduleAt('aim-indicator.ts');
const { projectGunSight } = await moduleAt('gun-sight.ts');
const measurements = [];
for (const altitude of [370, 60]) for (const pitch of [-.6, -.2, 0, .2, .6]) {
  const state = createGame(73, 'normal'); startGame(state);
  state.player.position.y = altitude; state.player.pitch = pitch; updateQuaternion(state.player);
  for (const [operation, run] of [
    ['bomb', () => predictBombEffect(state)],
    ['torpedo', () => checkGuidedTorpedoRelease(state.player, state.ships, state.elapsed)],
    ['sight', () => aimIndicator(state, [...state.allies, ...state.enemies, ...state.ships], projectGunSight(state.player, [], 393, 852),
      393, 852, target => flightTargetLineOfSight(state, target))],
  ]) {
    for (let i = 0; i < 20; i++) run();
    const ms = []; let result;
    for (let i = 0; i < 100; i++) { const start = performance.now(); result = run(); ms.push(performance.now() - start); }
    ms.sort((a, b) => a - b);
    measurements.push({ altitude, pitch, operation, samples: ms.length, p50: ms[49], p95: ms[94], p99: ms[98], max: ms[99],
      resultHash: createHash('sha256').update(JSON.stringify(result)).digest('hex') });
  }
}
console.log(JSON.stringify({ node: process.version, seed: 73, mode: 'normal', warmup: 20, unit: 'milliseconds', measurements }, null, 2));
