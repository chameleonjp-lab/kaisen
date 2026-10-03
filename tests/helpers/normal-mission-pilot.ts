import { Quaternion, Vector3 } from 'three';
import { desiredFlightInput, forwardOf } from '../../src/flight';
import { targetAimPoint } from '../../src/flight-assist';
import type { Aircraft, FlightInput, GameState } from '../../src/types';

const clamp = (value: number) => Math.max(-1, Math.min(1, value));
const vector = (point: { x: number; y: number; z: number }) => new Vector3(point.x, point.y, point.z);
function plane(aircraft: Aircraft): Aircraft {
  const q = aircraft.quaternion as any;
  return { ...aircraft, position: vector(aircraft.position), quaternion: Array.isArray(q)
    ? new Quaternion().fromArray(q)
    : new Quaternion(q.x ?? q._x, q.y ?? q._y, q.z ?? q._z, q.w ?? q._w) };
}

/** Test-only observer: returns legal manual fire and circular-stick commands.
 * Uses the normal mission's actual targets, hull axis, speed, ammo and clock.
 * It never edits world state, supplies automatic product aim, or advances time.
 * A deterministic completion proves reachability, not novice or device usability.
 */
export function createNormalMissionPilot() {
  let targetId: number | null = null, extensionUntil = 0, escapeUntil = 0;
  let shipPhase: 'stage' | 'attack' | 'escape' = 'stage';
  let waypoint = new Vector3();
  return (snapshot: GameState): FlightInput => {
    const player = plane(snapshot.player);
    const enemies = snapshot.enemies.map(plane);
    const ships = snapshot.ships.map(ship => ({ ...ship, position: vector(ship.position), velocity: vector(ship.velocity) }));
    const targets = [...enemies, ...ships].filter(target => target.health > 0);
    const nearest = targets.slice().sort((a, b) => player.position.distanceTo(a.position) - player.position.distanceTo(b.position))[0];
    const pick = nearest?.kind === 'aircraft' ? nearest : targets.filter(target => target.kind === 'ship').sort((a, b) => a.position.x - b.position.x)[0];
    const target = targets.find(target => target.id === targetId) ?? pick;
    if (!target) return { turn: 0, climb: 0, fire: false, loop: false };
    if (targetId !== target.id) shipPhase = 'stage';
    targetId = target.id;
    let aim = target.position.clone(), evasive = false;
    const distance = player.position.distanceTo(aim);
    if (target.kind === 'aircraft') {
      // The pilot leads the target by steering the bore; Normal bullets still
      // receive no target or direction correction from the product.
      aim.addScaledVector(forwardOf(target), target.speed * distance / (player.speed + 760));
      if (snapshot.tick >= extensionUntil && (player.position.y < 90 || distance < 180)) {
        extensionUntil = snapshot.tick + 360;
        waypoint = player.position.clone().addScaledVector(forwardOf(player), 740);
        waypoint.y = Math.max(250, player.position.y + 250);
      }
      if (snapshot.tick < extensionUntil) { aim = waypoint; evasive = true; }
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
        else aim = targetAimPoint(target).addScaledVector(target.velocity, distance / (player.speed + 760));
      }
    }
    const controls = desiredFlightInput(player, aim), weave = evasive ? .3 : 0;
    let turn = clamp(controls.turn * 12 + weave * Math.sin(snapshot.elapsed * Math.PI));
    let climb = clamp(controls.climb * .62 / .95 + weave * .6 * Math.cos(snapshot.elapsed * Math.PI));
    const norm = Math.hypot(turn, climb);
    if (norm > 1) { turn /= norm; climb /= norm; }
    const alignment = forwardOf(player).angleTo(aim.clone().sub(player.position));
    return { turn, climb, fire: !evasive && alignment < .10 && distance < 1150, loop: false };
  };
}
