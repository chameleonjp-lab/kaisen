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
  let targetSince = 0, lastTime = 0, emergencyUntil = 0, emergencyClimb = 1, emergencyTurn = .15, variableCadence = false;
  return (snapshot: GameState): FlightInput => {
    const sampleDt = Math.max(1/60, snapshot.elapsed - lastTime); lastTime = snapshot.elapsed;
    // The external test driver cannot always update at 10 Hz. With irregular
    // observations, reserve a stronger near-collision escape instead of assuming
    // the next steering correction arrives at precisely six fixed ticks.
    variableCadence ||= sampleDt > .105;
    const player = plane(snapshot.player);
    const enemies = snapshot.enemies.map(plane);
    const playerVelocity = forwardOf(player).multiplyScalar(player.speed);
    for (const enemy of enemies) {
      if (enemy.health <= 0) continue;
      const separation = enemy.position.clone().sub(player.position);
      const velocity = forwardOf(enemy).multiplyScalar(enemy.speed).sub(playerVelocity);
      const t = -separation.dot(velocity) / Math.max(1, velocity.lengthSq());
      if (variableCadence && snapshot.tick >= emergencyUntil && (separation.length() < 180 && t > 0 && t < 1 && separation.clone().addScaledVector(velocity,t).length() < 35)) {
        emergencyUntil = snapshot.tick + 90;
        emergencyClimb = player.position.y > 650 && separation.y > 0 ? -1 : 1;
        const local = separation.applyQuaternion(player.quaternion.clone().invert());
        emergencyTurn = local.x >= 0 ? -.12 : .12;
      }
    }
    if (snapshot.tick < emergencyUntil) return {turn:emergencyTurn, climb:emergencyClimb*Math.sqrt(1-emergencyTurn**2), fire:false, loop:false, accelerate:true};
    const ships = snapshot.ships.map(ship => ({ ...ship, position: vector(ship.position), velocity: vector(ship.velocity) }));
    const targets = [...enemies, ...ships].filter(target => target.health > 0);
    const nearest = targets.slice().sort((a, b) => player.position.distanceTo(a.position) - player.position.distanceTo(b.position))[0];
    const pick = nearest?.kind === 'aircraft' ? nearest : targets.filter(target => target.kind === 'ship').sort((a, b) => a.health - b.health || player.position.distanceTo(a.position) - player.position.distanceTo(b.position))[0];
    const healTarget = player.health < 95 ? enemies.filter(e => e.health > 0 && e.generation === 'reinforcement').sort((a,b) => player.position.distanceTo(a.position) - player.position.distanceTo(b.position))[0] : null;
    const current = targets.find(target => target.id === targetId);
    const target = current?.kind === 'aircraft' ? ((ships.every(ship => ship.health <= 0) && snapshot.elapsed - targetSince > 20) ? enemies.filter(e=>e.health>0 && e.id!==current.id).sort((a,b)=>player.position.distanceTo(a.position)-player.position.distanceTo(b.position))[0] ?? current : current) : healTarget ?? current ?? pick;
    if (!target) return { turn: 0, climb: 0, fire: false, loop: false };
    if (targetId !== target.id) { shipPhase = 'stage'; targetSince = snapshot.elapsed; }
    targetId = target.id;
    let aim = target.position.clone(), evasive = false;
    const distance = player.position.distanceTo(aim);
    if (target.kind === 'aircraft') {
      // The pilot leads the target by steering the bore; Normal bullets still
      // receive no target or direction correction from the product.
      const velocity = forwardOf(target).multiplyScalar(target.speed);
      const relative = aim.clone().sub(player.position);
      const a = velocity.lengthSq() - (player.speed + 700) ** 2;
      const b = 2 * relative.dot(velocity), c = relative.lengthSq();
      const discriminant = b * b - 4 * a * c;
      const time = discriminant >= 0 ? (-b - Math.sqrt(discriminant)) / (2 * a) : 0;
      const lead = Math.max(0, Math.min(1.5, time));
      aim.addScaledVector(velocity, lead);
      const closing = -target.position.clone().sub(player.position).dot(forwardOf(target).multiplyScalar(target.speed).sub(forwardOf(player).multiplyScalar(player.speed))) / Math.max(1,distance);
      if (snapshot.tick >= extensionUntil && (player.position.y < 90 || distance < (closing > 50 ? 250 : 80))) {
        extensionUntil = snapshot.tick + 180;
        waypoint = player.position.clone().addScaledVector(forwardOf(player), 500);
        waypoint.y = Math.max(350, player.position.y + 250);
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
    const relative = aim.clone().sub(player.position);
    const targetVelocity = !evasive ? target.kind === 'aircraft' ? forwardOf(target).multiplyScalar(target.speed) : target.velocity.clone() : new Vector3();
    const velocity = targetVelocity.sub(forwardOf(player).multiplyScalar(player.speed));
    const h2 = relative.x ** 2 + relative.z ** 2, h = Math.sqrt(h2);
    const yawRate = h2 > 1 ? (relative.z * velocity.x - relative.x * velocity.z) / h2 : 0;
    const pitchRate = h > 1 ? (velocity.y * h - relative.y * (relative.x * velocity.x + relative.z * velocity.z) / h) / relative.lengthSq() : 0;
    let turn = clamp(controls.turn * (sampleDt > .118 ? Math.min(12,.85/sampleDt) : 12) - yawRate / .82 + weave * Math.sin(snapshot.elapsed * Math.PI));
    let climb = clamp(controls.climb * .62 / .95 + pitchRate / (4.2 * .95) + weave * .6 * Math.cos(snapshot.elapsed * Math.PI));
    const norm = Math.hypot(turn, climb);
    if (norm > 1) { turn /= norm; climb /= norm; }
    const alignment = forwardOf(player).angleTo(aim.clone().sub(player.position));
    const speed = target.kind === 'aircraft' && distance > 650 ? 141 : 85;
    return { turn, climb, fire: !evasive && alignment < .10 && distance < 1150, loop: false, accelerate: player.speed < speed - 1, brake: player.speed > speed + 1 };
  };
}
