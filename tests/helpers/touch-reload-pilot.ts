import { Quaternion, Vector3 } from 'three';
import { desiredFlightInput, forwardOf } from '../../src/flight';
import { targetAimPoint } from '../../src/flight-assist';
import type { Aircraft, GameState } from '../../src/types';

const clamp = (n: number) => Math.max(-1, Math.min(1, n));
const vector = (p: { x: number; y: number; z: number }) => new Vector3(p.x, p.y, p.z);
function plane(p: Aircraft): Aircraft {
  const q = p.quaternion as any;
  return { ...p, position: vector(p.position), quaternion: Array.isArray(q) ? new Quaternion().fromArray(q) : new Quaternion(q.x ?? q._x, q.y ?? q._y, q.z ?? q._z, q.w ?? q._w) };
}
/** Observes real state and returns ordinary circular-stick commands; never mutates it. */
export function createTouchReloadPilot() {
  let targetId: number | null = null, extensionUntil = 0, escapeUntil = 0;
  let shipPhase: 'stage' | 'attack' | 'escape' = 'stage';
  let waypoint = new Vector3();
  return (snapshot: GameState) => {
    const player = plane(snapshot.player);
    const enemies = snapshot.enemies.map(plane);
    const ships = snapshot.ships.map(s => ({ ...s, position: vector(s.position), velocity: vector(s.velocity) }));
    const targets = [...enemies, ...ships].filter(t => t.health > 0);
    const nearest = targets.slice().sort((a, b) => player.position.distanceTo(a.position) - player.position.distanceTo(b.position))[0];
    const pick = nearest?.kind === 'aircraft' ? nearest : targets.filter(t => t.kind === 'ship').sort((a, b) => a.position.x - b.position.x)[0];
    const target = targets.find(t => t.id === targetId) ?? pick;
    if (!target) return { turn: 0, climb: 0 };
    if (targetId !== target.id) shipPhase = 'stage';
    targetId = target.id;
    let aim = target.position.clone(), evasive = false;
    const distance = player.position.distanceTo(aim);
    if (target.kind === 'aircraft') {
      aim.addScaledVector(forwardOf(target), target.speed * .6);
      if (snapshot.tick >= extensionUntil && (player.position.y < 90 || distance < 180)) {
        extensionUntil = snapshot.tick + 360;
        waypoint = player.position.clone().addScaledVector(forwardOf(player), 740);
        waypoint.y = Math.max(250, player.position.y + 250);
      }
      if (snapshot.tick < extensionUntil) aim = waypoint;
    } else {
      const stern = target.velocity.clone().normalize().negate();
      const stage = target.position.clone().addScaledVector(stern, 1100); stage.y = 650;
      if (snapshot.tick < escapeUntil) { aim = waypoint; evasive = true; }
      else {
        if (shipPhase === 'escape') shipPhase = 'stage';
        if (shipPhase === 'stage' && player.position.distanceTo(stage) < 180) shipPhase = 'attack';
        if (shipPhase === 'attack' && (distance < 240 || player.position.y < 100)) {
          shipPhase = 'escape'; escapeUntil = snapshot.tick + 360;
          waypoint = player.position.clone().addScaledVector(forwardOf(player), 800);
          waypoint.y = Math.max(350, player.position.y + 220); aim = waypoint; evasive = true;
        } else if (shipPhase === 'stage') { aim = stage; evasive = true; }
        else aim = targetAimPoint(target);
      }
    }
    const input = desiredFlightInput(player, aim), w = evasive ? .3 : 0;
    let turn = clamp(input.turn + w * Math.sin(snapshot.elapsed * Math.PI));
    let climb = clamp(input.climb * .62 / .95 + w * .6 * Math.cos(snapshot.elapsed * Math.PI));
    const norm = Math.hypot(turn, climb);
    if (norm > 1) { turn /= norm; climb /= norm; }
    return { turn, climb };
  };
}
/** Inverse of the unchanged source stick's .08 radial dead zone. */
export function pointerOffsetForControls(turn: number, climb: number) {
  const r = Math.hypot(turn, climb);
  if (r === 0) return { dx: 0, dy: 0 };
  const scale = 36 * (.08 + .92 * r) / r;
  return { dx: turn * scale, dy: -climb * scale };
}
