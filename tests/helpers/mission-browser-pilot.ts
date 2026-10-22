import { Quaternion, Vector3 } from 'three';
import { forwardOf, updateQuaternion } from '../../src/flight';
import { EASY_AUTO_FIRE_RANGE, PLAYER_MAX_PITCH, getFlightAssist } from '../../src/flight-assist';
import { EASY_CAMERA_LOOK_ANGLE, NORMAL_CAMERA_LOOK_ANGLE, projectFlightTarget } from '../../src/flight-view';
import { MAX_ORDNANCE } from '../../src/mission';
import { predictBombImpact } from '../../src/ordnance';
import type { Aircraft, FlightInput, GameState } from '../../src/types';
import { absolutePitchTargetToRateCommand } from './pitch-rate-conversion';

const clamp = (value: number) => Math.max(-1, Math.min(1, value));
const vector = (point: { x: number; y: number; z: number }) => new Vector3(point.x, point.y, point.z);
function plane(aircraft: Aircraft): Aircraft {
  const q = aircraft.quaternion as any;
  return { ...aircraft, position: vector(aircraft.position), quaternion: Array.isArray(q)
    ? new Quaternion().fromArray(q)
    : new Quaternion(q.x ?? q._x, q.y ?? q._y, q.z ?? q._z, q.w ?? q._w) };
}

type BrowserPilotSnapshot = GameState & {
  bombGuide?: { kind: string; affected: { shipId: number; damage: number }[] } | null;
  bombButton?: { ready?: string } | null;
  controlsInput?: { turn?: number; climb?: number; steerPointer?: number | null } | null;
};

/** Test-driver policy: keep the helper's blast request capability, but avoid
 * spending a finite bomb when its live blast forecast cannot finish a ship. */
export function isUsefulBombCue(snapshot: {
  bombButton?: { ready?: string } | null;
  bombGuide?: { kind: string; affected: { shipId: number; damage: number }[] } | null;
  ships: Array<{ id: number; health: number }>;
}): boolean {
  if (snapshot.bombButton?.ready !== 'true' || !snapshot.bombGuide) return false;
  const guide = snapshot.bombGuide;
  if (guide.kind !== 'direct' && guide.kind !== 'blast') return false;
  return guide.affected.some(hit => {
    const ship = snapshot.ships.find(candidate => candidate.id === hit.shipId && candidate.health > 0);
    return !!ship && hit.damage > 0 && (guide.kind === 'direct' || hit.damage + 1e-6 >= ship.health);
  });
}

/** A delayed payload pulse keeps the current accepted steering in force until
 * the release arrives. Require an established straight pass in both modes;
 * Easy's manual pitch path uses a small held climb command to stay level. */
export function hasAcceptedBombSteering(snapshot: {
  mode?: 'easy' | 'normal';
  controlsInput?: { turn?: number; climb?: number } | null;
}): boolean {
  const controls = snapshot.controlsInput;
  if (!controls || typeof controls.turn !== 'number' || !Number.isFinite(controls.turn)
    || typeof controls.climb !== 'number' || !Number.isFinite(controls.climb)) return false;
  if (snapshot.mode === 'normal')
    return Math.abs(controls.turn) <= .01 && Math.abs(controls.climb - .02) <= .01;
  if (snapshot.mode === 'easy')
    return Math.abs(controls.turn) <= .01 && Math.abs(Math.abs(controls.climb) - .02) <= .01;
  return false;
}

export function shouldAttemptBomb(snapshot: {
  bombButton?: { ready?: string } | null;
  bombGuide?: { kind: string; affected: { shipId: number; damage: number }[] } | null;
  mode?: 'easy' | 'normal';
  ships: Array<{ id: number; health: number }>;
  controlsInput?: { turn?: number; climb?: number } | null;
}): boolean {
  return isUsefulBombCue(snapshot) && hasAcceptedBombSteering(snapshot);
}

/** Browser-test pilot: legal circular-stick, manual fire and throttle commands.
 * Uses the normal mission's actual targets, hull axis, speed, ammo and clock.
 * It never edits world state, supplies automatic product aim, or advances time.
 * It tracks observed motion and held throttle duration to tolerate delayed browser input.
 * A completion proves the exercised path, not novice or device usability.
 */
export function createBrowserMissionPilot(preferAircraft = false) {

  let previousLead: {id:number,t:number,point:Vector3,muzzleSpeed:number}|null=null;
  let recovering = false, targetProgressAt = 0, observedTargetHealth = Infinity;
  let targetId: number | null = null, extensionUntil = 0, escapeUntil = 0;
  let shipPhase: 'stage' | 'attack' | 'escape' = 'stage';
  let attackLockShipId: number | null = null, attackLockUntil = 0, attackLockClimb = .02, attackLockBlocked = false;
  let pendingBombCount: number | null = null;
  let waypoint = new Vector3();
  let history = new Map<number, {yaw:number,pitch:number,t:number}>();
  let slowInput = false;
  let lastTime = 0, yawResponse = 1, estimatedTrim = 110, trimDirection = 0, fastChase = false, dodgeUntil = 0, dodgeClimb = 1, dodgeTurn = 0;
  const captureMemory = () => ({
    previousLead:previousLead?{...previousLead,point:previousLead.point.clone()}:null,
    recovering,targetProgressAt,observedTargetHealth,targetId,extensionUntil,escapeUntil,shipPhase,
    attackLockShipId,attackLockUntil,attackLockClimb,attackLockBlocked,pendingBombCount,
    waypoint:waypoint.clone(),history:new Map([...history].map(([id,entry])=>[id,{...entry}] as const)),
    slowInput,lastTime,yawResponse,estimatedTrim,trimDirection,fastChase,dodgeUntil,dodgeClimb,dodgeTurn,
  });
  const restoreMemory = (memory: ReturnType<typeof captureMemory>) => {
    previousLead=memory.previousLead;
    recovering=memory.recovering;targetProgressAt=memory.targetProgressAt;observedTargetHealth=memory.observedTargetHealth;
    targetId=memory.targetId;extensionUntil=memory.extensionUntil;escapeUntil=memory.escapeUntil;shipPhase=memory.shipPhase;
    attackLockShipId=memory.attackLockShipId;attackLockUntil=memory.attackLockUntil;attackLockClimb=memory.attackLockClimb;
    attackLockBlocked=memory.attackLockBlocked;
    pendingBombCount=memory.pendingBombCount;waypoint=memory.waypoint;history=memory.history;
    slowInput=memory.slowInput;lastTime=memory.lastTime;yawResponse=memory.yawResponse;estimatedTrim=memory.estimatedTrim;
    trimDirection=memory.trimDirection;fastChase=memory.fastChase;dodgeUntil=memory.dodgeUntil;dodgeClimb=memory.dodgeClimb;dodgeTurn=memory.dodgeTurn;
  };
  const run = (snapshot: BrowserPilotSnapshot): FlightInput => {
    const sampleDt = Math.max(1/60, snapshot.elapsed - lastTime); lastTime = snapshot.elapsed;
    // Once delayed delivery is observed, retain the damped response. Alternating
    // fast/slow gains at each jittered sample creates another source of oscillation.
    if (sampleDt > .15) slowInput = true;
    estimatedTrim = Math.max(65,Math.min(141,estimatedTrim + trimDirection * 18 * sampleDt));
    const player = plane(snapshot.player);
    // The browser driver releases the payload before changing steering. Keep the
    // predicted approach through that release, then exit after a later
    // observation confirms the game consumed the bomb.
    if (snapshot.mode === 'easy' && pendingBombCount !== null && player.bombs < pendingBombCount) {
      pendingBombCount = null;
      attackLockShipId = null; attackLockUntil = 0; attackLockBlocked = false;
      shipPhase = 'escape'; escapeUntil = snapshot.tick + 360;
      waypoint = player.position.clone().addScaledVector(forwardOf(player), 800);
      waypoint.y = Math.max(900, player.position.y + 220);
    }
    const enemies = snapshot.enemies.map(plane);
    const angular = new Map<number, {yaw:number,pitch:number}>();
    for (const enemy of enemies) {
      const old = history.get(enemy.id), dt = old ? snapshot.elapsed - old.t : 0;
      if (old && dt > 0) angular.set(enemy.id, {yaw: Math.atan2(Math.sin(enemy.yaw - old.yaw), Math.cos(enemy.yaw-old.yaw)) / dt, pitch:(enemy.pitch - old.pitch)/dt});
    }
    history = new Map(enemies.map(e=>[e.id,{yaw:e.yaw,pitch:e.pitch,t:snapshot.elapsed}]));
    let imminentThreat: { separation: Vector3; time: number } | null = null;
    for (const enemy of enemies) {
      if (enemy.health <= 0) continue;
      const relative = enemy.position.clone().sub(player.position);
      const velocity = forwardOf(enemy).multiplyScalar(enemy.speed).sub(forwardOf(player).multiplyScalar(player.speed));
      const time = -relative.dot(velocity) / Math.max(1, velocity.lengthSq());
      const closestSeparation = relative.clone().addScaledVector(velocity, time).length();
      // Fast regular sampling retains the prior range envelope. Delayed samples
      // use TTC and clearance directly because a fixed range cutoff can miss the
      // last actionable observation before a collision.
      if ((relative.length() < 240 || slowInput) && time > 0 && time < 1.5 && closestSeparation < 40
        && (!imminentThreat || time < imminentThreat.time)) {
        imminentThreat = { separation: relative, time };
      }
    }
    if (imminentThreat) {
      const relative = imminentThreat.separation;
      dodgeUntil = snapshot.tick + 120;
      // Estimate clearance for Easy's full two-second dodge at cruise speed.
      // The old 400m cutoff sent a 323m approach into higher traffic. Normal
      // accelerates while dodging, so retain its existing altitude margin.
      const canDescend = snapshot.mode === 'easy'
        ? player.position.y - player.speed * 2 > 90 : player.position.y > 400;
      dodgeClimb = canDescend && relative.y >= 0 ? -1 : 1;
      dodgeTurn = 0;
      // CI38: climbing from 274m into an above-player descending hostile
      // caused the collision. A lateral turn preserves vertical clearance.
      // 230m covers the observed 41-tick delivery plus neutral pitch settling
      // above the 90m escape floor; choose the most urgent live threat even if
      // a prior two-second dodge is already underway.
      if (snapshot.mode === 'normal' && !canDescend && relative.y >= 0 && player.position.y > 230) {
        const right = new Vector3(Math.cos(player.yaw), 0, -Math.sin(player.yaw));
        dodgeTurn = relative.dot(right) >= 0 ? -1 : 1;
        dodgeClimb = 0;
      }
    }
    if (snapshot.tick < dodgeUntil) {
      trimDirection = snapshot.mode === 'normal' ? 1 : 0;
      // Normal no longer levels a held horizontal stick automatically. The
      // external test pilot must request its intended level attitude itself,
      // sharing the legal circular stick budget with the lateral dodge.
      const climb = snapshot.mode === 'normal' && dodgeTurn !== 0
        ? absolutePitchTargetToRateCommand(0, player.pitch, player.speed) : dodgeClimb;
      const turn = snapshot.mode === 'normal' && dodgeTurn !== 0
        ? dodgeTurn * Math.sqrt(Math.max(0, 1 - climb * climb)) : dodgeTurn;
      return {turn,climb,fire:false,loop:false,bomb:false,torpedo:false,accelerate:trimDirection > 0,brake:false};
    }
    // Gun-reload practice disengages only after checking imminent collisions.
    // CI66's browser-only fixed climb bypassed the dodge and hit an above-player
    // reinforcement while unarmed. Keep the same legal cruise-away command,
    // with the ordinary collision response taking priority on every sample.
    if (preferAircraft && player.reloadTicksRemaining > 0)
      return {turn:.45,climb:.8,fire:false,loop:false,bomb:false,torpedo:false,accelerate:false,brake:false};
    const ships = snapshot.ships.map(ship => ({ ...ship, position: vector(ship.position), velocity: vector(ship.velocity) }));
    const guide = snapshot.bombGuide;
    const guidedBombReady = snapshot.phase === 'playing' && player.health > 0 && player.bombs > 0
      && player.bombReloadTicks === 0 && player.payloadCooldown <= 0
      && snapshot.ordnance.length < MAX_ORDNANCE
      && snapshot.bombButton?.ready === 'true'
      && (guide?.kind === 'direct' || guide?.kind === 'blast')
      && guide.affected.some(hit => hit.damage > 0 && ships.some(ship => ship.id === hit.shipId && ship.health > 0));
    const targets = [...enemies, ...ships].filter(target => target.health > 0);
    const nearest = targets.slice().sort((a, b) => player.position.distanceTo(a.position) - player.position.distanceTo(b.position))[0];
    const pick = nearest?.kind === 'aircraft' ? nearest : targets.filter(target => target.kind === 'ship').sort((a, b) => a.health - b.health || player.position.distanceTo(a.position) - player.position.distanceTo(b.position))[0];
    const healTarget = player.health < player.maxHealth * .95 ? enemies.filter(e => e.health > 0 && e.generation === 'reinforcement').sort((a,b) => player.position.distanceTo(a.position) - player.position.distanceTo(b.position))[0] : null;
    const current = targets.find(target => target.id === targetId);
    const air = enemies.filter(e => e.health > 0);
    const score = (enemy:Aircraft) => player.position.distanceTo(enemy.position) + forwardOf(player).angleTo(enemy.position.clone().sub(player.position)) * 220 + enemy.health * 3;
    const bestAir = air.sort((a,b)=>score(a)-score(b))[0];
    const airFirst = current?.kind === 'aircraft'
      ? (bestAir && score(bestAir) < score(current) * .65 ? bestAir : current)
      : healTarget ?? current ?? pick;
    // Clear the finite fleet before chasing endlessly replenished aircraft.
    // This is the external test pilot's strategy, never a product AI change.
    const weakestShip = ships.filter(s=>s.health>0).sort((a,b)=>a.health-b.health || player.position.distanceTo(a.position)-player.position.distanceTo(b.position))[0];
    // Bombing approaches stay above light-AA altitude; torpedoes require the separate low-level envelope.
    // Recover through the real reinforcement kill bonus before another naval pass.
    // Retain a recovery target until the observed HP has recovered.
    if (player.health < player.maxHealth * .7) recovering = true;
    else if (player.health >= player.maxHealth * .9) recovering = false;
    if (current && current.health < observedTargetHealth - 1e-6) targetProgressAt = snapshot.elapsed;
    const staleAir = current?.kind === 'aircraft' && snapshot.elapsed - targetProgressAt > 12;
    const alternativeAir = air.filter(enemy => enemy.id !== current?.id).sort((a,b)=>score(a)-score(b))[0];
    const recoveryTarget = staleAir && alternativeAir?.generation === 'reinforcement' ? alternativeAir : current?.kind === 'aircraft' && current.generation === 'reinforcement' ? current
      : enemies.filter(e=>e.health>0 && e.generation==='reinforcement').sort((a,b)=>score(a)-score(b))[0];
    const gunPracticeTarget = preferAircraft ? (staleAir && alternativeAir ? alternativeAir : current?.kind === 'aircraft' ? current : bestAir) : null;
    // Finish a begun bombing pass before changing objectives. The ordinary
    // overhead/empty-rack/low-altitude exit below still bounds the commitment.
    // A recovery detour mid-pass otherwise repeatedly discards the approach.
    const committedPass = snapshot.mode === 'easy' && current?.kind === 'ship' && shipPhase === 'attack' ? current : null;
    let target = gunPracticeTarget ?? committedPass ?? (recovering ? recoveryTarget : null) ?? weakestShip ?? (staleAir && alternativeAir ? alternativeAir : current?.kind === 'aircraft' ? (snapshot.mode === 'normal' && bestAir && score(bestAir) < score(current)*.65 ? bestAir : current) : bestAir);
    if (snapshot.mode === 'easy' && target?.kind === 'aircraft') {
      const canLeadAndFire = (enemy: Aircraft) => {
        const velocity = forwardOf(enemy).multiplyScalar(enemy.speed);
        const relative = enemy.position.clone().sub(player.position);
        const speed = player.speed + (player.cannon > 0 ? 700 : 820);
        const a = velocity.lengthSq() - speed * speed, b = 2 * relative.dot(velocity), c = relative.lengthSq();
        const discriminant = b * b - 4 * a * c;
        if (discriminant < 0 || relative.length() > EASY_AUTO_FIRE_RANGE) return false;
        const lead = (-b - Math.sqrt(discriminant)) / (2 * a);
        if (lead < 0 || lead > 1.5) return false;
        const point = enemy.position.clone(), rate = angular.get(enemy.id);
        if (rate) for (let i = 0; i < 10; i++) {
          const t = lead * (i + .5) / 10, yaw = enemy.yaw + rate.yaw * t, pitch = enemy.pitch + rate.pitch * t * .5;
          point.addScaledVector(new Vector3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)), enemy.speed * lead / 10);
        } else point.addScaledVector(velocity, lead);
        const direction = point.sub(player.position).normalize();
        const preview = { ...player, quaternion: player.quaternion.clone(), yaw: Math.atan2(-direction.x, -direction.z), pitch: Math.asin(direction.y) };
        updateQuaternion(preview);
        return projectFlightTarget(preview, enemy.position, 393 / 852, 'easy').inCircle;
      };
      // Correct lead alone is insufficient when it puts the live target outside
      // Easy's unchanged automatic-fire circle. Prefer another usable aspect;
      // do not shrink the lead or bypass the game's firing gate.
      // Let an acquired target's in-flight burst arrive before discarding it.
      // Avoid replacing the target while a useful burst may still arrive.
      if (!canLeadAndFire(target) && (target.id !== targetId || snapshot.elapsed - targetProgressAt >= 1.5)) {
        const available = enemies.filter(enemy => enemy.health > 0 && (!recovering || enemy.generation === 'reinforcement') && canLeadAndFire(enemy))
          .sort((a, b) => score(a) - score(b));
        if (available.length) target = available[0];
      }
    }
    if (!target) return { turn: 0, climb: 0, fire: false, loop: false, bomb:false,torpedo:false,accelerate:false,brake:false };
    if (targetId !== target.id) {
      shipPhase = 'stage'; targetProgressAt = snapshot.elapsed;
      attackLockShipId = null; attackLockUntil = 0; attackLockBlocked = false;
    }
    targetId = target.id; observedTargetHealth = target.health;
    let aim = target.position.clone(), evasive = false, bomb = false;
    const distance = player.position.distanceTo(aim);
    if (target.kind === 'aircraft') {
      // Both modes now require manual lead. Easy has a small launch correction;
      // this external test pilot still steers the bore through ordinary input.
      const velocity = forwardOf(target).multiplyScalar(target.speed);
      const relative = aim.clone().sub(player.position);
      // Lead the higher-damage cannon while loaded. Its slower rounds cannot
      // follow an MG intercept after the shared correction was weakened.
      // Easy uses the remaining MG velocity only after the cannon runs dry.
      const muzzleSpeed = snapshot.mode === 'easy' && player.cannon <= 0 ? 820 : 700;
      const a = velocity.lengthSq() - (player.speed + muzzleSpeed) ** 2;
      const b = 2 * relative.dot(velocity), c = relative.lengthSq();
      const discriminant = b * b - 4 * a * c;
      const time = discriminant >= 0 ? (-b - Math.sqrt(discriminant)) / (2 * a) : 0;
      const lead = Math.max(0, Math.min(1.5, time));
      if (angular.has(target.id)) {
        const rate = angular.get(target.id)!;
        for(let i=0;i<10;i++) {
          const t=lead*(i+.5)/10;
          const yaw=target.yaw+rate.yaw*t;
          const pitch=target.pitch+rate.pitch*t*.5;
          aim.addScaledVector(new Vector3(-Math.sin(yaw)*Math.cos(pitch),Math.sin(pitch),-Math.cos(yaw)*Math.cos(pitch)), target.speed*lead/10);
        }
      } else aim.addScaledVector(velocity, lead);
      const closing = -target.position.clone().sub(player.position).dot(forwardOf(target).multiplyScalar(target.speed).sub(forwardOf(player).multiplyScalar(player.speed))) / Math.max(1,distance);
      // Normal's blanket250m exit prevented recovery kills even when live ships
      // were more than1km away. Retain actual collision-course dodges above and
      // the80m/low-altitude escape; Easy's approach strategy is evaluated separately.
      if (snapshot.tick >= extensionUntil && (player.position.y < 90 || distance < (snapshot.mode === 'easy' && weakestShip && closing > 50 && relative.dot(forwardOf(player)) > 0 ? 250 : 80))) {
        extensionUntil = snapshot.tick + 180;
        waypoint = player.position.clone().addScaledVector(forwardOf(player), 500);
        waypoint.y = player.position.y > 400 && target.position.y > player.position.y ? player.position.y - 250 : Math.max(350, player.position.y + 250);
      }
      if (snapshot.tick < extensionUntil) { aim = waypoint; evasive = true; }
    } else {
      const stern = target.velocity.clone().normalize().negate();
      const stage = target.position.clone().addScaledVector(stern, 1800); stage.y = 900;
      if (snapshot.tick < escapeUntil) { aim = waypoint; evasive = true; }
      else {
        if (shipPhase === 'escape') {
          shipPhase = 'stage';
          attackLockShipId = null; attackLockUntil = 0; attackLockBlocked = false;
        }
        if (shipPhase === 'stage' && player.position.distanceTo(stage) < 180) shipPhase = 'attack';
        if (shipPhase === 'attack' && (Math.hypot(player.position.x-target.position.x,player.position.z-target.position.z) < 240 || player.position.y < 100 || player.bombs === 0)) {
          shipPhase = 'escape'; escapeUntil = snapshot.tick + 360;
          attackLockShipId = null; attackLockUntil = 0; attackLockBlocked = false;
          waypoint = player.position.clone().addScaledVector(forwardOf(player), 800);
          waypoint.y = Math.max(900, player.position.y + 220); aim = waypoint; evasive = true;
        } else if (shipPhase === 'stage') { aim = stage; evasive = true; }
        else {
          const prediction = predictBombImpact(player, target.position.y + 9);
          aim = target.position.clone().addScaledVector(target.velocity, prediction?.time ?? 7);
          aim.y = 900;
          // The straight lock is a browser-driver response to the live UI
          // cue and delayed CDP path. Pure simulation fixtures without that
          // readback retain the ordinary local predictor strategy.
          const liveAttackRack = snapshot.bombButton !== undefined && player.bombs > 0
            && player.bombReloadTicks === 0 && player.payloadCooldown <= 0
            && snapshot.ordnance.length < MAX_ORDNANCE;
          if (!liveAttackRack || !prediction || Math.abs(player.position.y - 900) > 120 || player.pitch > 1.12 || player.pitch < -1.12) {
            attackLockShipId = null; attackLockUntil = 0; attackLockBlocked = false;
          } else {
            const q = target.quaternion as any;
            const rotation = Array.isArray(q) ? new Quaternion().fromArray(q) : new Quaternion(q.x ?? q._x, q.y ?? q._y, q.z ?? q._z, q.w ?? q._w);
            const futureShip = target.position.clone().addScaledVector(target.velocity, prediction.time);
            const offset = prediction.position.clone().sub(futureShip).applyQuaternion(rotation.invert());
            const withinHullLine = Math.abs(offset.x) <= target.width * .5 && Math.abs(offset.z) <= target.length * .5;
            if (!withinHullLine) {
              attackLockShipId = null; attackLockUntil = 0; attackLockBlocked = false;
            } else if (attackLockShipId === target.id && snapshot.tick <= attackLockUntil) {
              // Keep one straight, slightly climbing pass through the measured
              // hull corridor. A neutral pitch command invokes the game's
              // automatic levelling, which made otherwise aligned payloads
              // leave their green window during delayed touch delivery.
              aim = player.position.clone().addScaledVector(forwardOf(player), 1200);
              evasive = true;
            } else if (attackLockShipId === target.id && snapshot.tick > attackLockUntil) {
              attackLockShipId = null; attackLockUntil = 0; attackLockBlocked = true;
            } else if (!attackLockBlocked) {
              attackLockShipId = target.id; attackLockUntil = snapshot.tick + 60;
              // Normal's release gate requires the same positive holding cue
              // used by its short contract; Easy follows the current pitch sign.
              attackLockClimb = snapshot.mode === 'normal' || Math.abs(player.pitch) < .02 || Math.abs(player.pitch) > 1.12
                ? .02 : Math.sign(player.pitch) * .02;
              aim = player.position.clone().addScaledVector(forwardOf(player), 1200);
              evasive = true;
            }
          }
          if (prediction && player.bombs > 0 && player.payloadCooldown <= 0) {
            const q = target.quaternion as any;
            const rotation = Array.isArray(q) ? new Quaternion().fromArray(q) : new Quaternion(q.x ?? q._x, q.y ?? q._y, q.z ?? q._z, q.w ?? q._w);
            const future = target.position.clone().addScaledVector(target.velocity, prediction.time);
            const offset = prediction.position.clone().sub(future).applyQuaternion(rotation.invert());
            bomb = Math.abs(offset.x) < target.width * .36 && Math.abs(offset.z) < target.length * .35;
          }
        }
      }
    }
    // Continue the confirmed post-release exit even if target selection moved
    // to another ship (or an aircraft) during the escape window.
    if (snapshot.mode === 'easy' && snapshot.tick < escapeUntil) {
      aim = waypoint; evasive = true; bomb = false;
    }
    if (snapshot.mode === 'normal' && player.reloadTicksRemaining > 0 && target.kind === 'aircraft') {
      aim = player.position.clone().addScaledVector(forwardOf(player),800);
      aim.y = Math.max(400,player.position.y+200); evasive = true;
    }
    // With browser telemetry, the live button and its blast-radius cue are
    // authoritative in both directions. Only unit states without that feedback
    // use the narrower local center-impact estimate above.
    if (snapshot.bombButton !== undefined) bomb = guidedBombReady;
    const weave = evasive ? .3 : 0;
    const relative = aim.clone().sub(player.position);
    let targetVelocity = !evasive ? target.kind === 'aircraft' ? forwardOf(target).multiplyScalar(target.speed) : target.velocity.clone() : new Vector3();
    if (snapshot.mode === 'easy' && target.kind === 'aircraft' && !evasive) {
      // The curved lead point moves faster sideways than the target's current
      // velocity alone predicts. Track observed lead-point motion; reset across
      // target/weapon switches, evasion, repeated times and long observation gaps.
      const leadDt = previousLead ? snapshot.elapsed - previousLead.t : 0;
      const muzzleSpeed = player.cannon > 0 ? 700 : 820;
      if (previousLead?.id === target.id && previousLead.muzzleSpeed === muzzleSpeed && leadDt > 0 && leadDt < .5)
        targetVelocity = aim.clone().sub(previousLead.point).divideScalar(leadDt);
      previousLead = {id:target.id,t:snapshot.elapsed,point:aim.clone(),muzzleSpeed};
    } else previousLead = null;
    const velocity = targetVelocity.sub(forwardOf(player).multiplyScalar(player.speed));
    const h2 = relative.x ** 2 + relative.z ** 2, h = Math.sqrt(h2);
    const yawRate = h2 > 1 ? (relative.z * velocity.x - relative.x * velocity.z) / h2 : 0;
    const pitchRate = h > 1 ? (velocity.y * h - relative.y * (relative.x * velocity.x + relative.z * velocity.z) / h) / relative.lengthSq() : 0;
    // Account for the source turn authority with a damped proportional gain.
    // The previous high gain oscillated when queued touch delivery lagged.
    const desiredResponse = getFlightAssist(player,targets,{turn:0,climb:0,fire:false,loop:false,viewAspect:393/852},snapshot.mode).responseMultiplier;
    yawResponse += Math.max(-2.5*sampleDt,Math.min(2.5*sampleDt,desiredResponse-yawResponse));
    const speed = player.speed;
    const lowAuthority = speed <= 85 ? .92 + ((speed-65)/20)*.23 : speed <= 110 ? 1.15 - ((speed-85)/25)*.15 : 1;
    const highLoad = Math.max(.78,Math.min(1,1-Math.max(0,speed-115)*.008));
    const yawAuthority = .82 * lowAuthority * highLoad * yawResponse;
    const desiredYaw = Math.atan2(-relative.x,-relative.z);
    const error = Math.atan2(Math.sin(desiredYaw-player.yaw),Math.cos(desiredYaw-player.yaw));
    // CI26 delivered Easy input 7 ticks late at a median 15-tick interval.
    // Its old 8/.7 gain saturated alternate directions and never staged a bomb
    // run. Use the same authority-aware damped heading controller as Normal.
    const headingGain = snapshot.mode === 'easy' && !slowInput ? Math.max(3.5,Math.min(8*.82/.7,.75/sampleDt)) : 3.5;
    let turn = clamp(-(yawRate + error * headingGain) / yawAuthority + weave * Math.sin(snapshot.elapsed * Math.PI));
    const cameraLookAngle = snapshot.mode === 'easy' ? EASY_CAMERA_LOOK_ANGLE : NORMAL_CAMERA_LOOK_ANGLE;
    // Preserve the external pilot's existing Euler maximum command before
    // converting it to the camera's pitched horizontal rate. This keeps the
    // automated route inside its established saturation envelope.
    const yawCameraCos = snapshot.controlsInput !== undefined && Math.abs(player.pitch) <= PLAYER_MAX_PITCH
      ? Math.cos(player.pitch + cameraLookAngle) : 1;
    // Convert the already bounded Euler request for the active manual-stick
    // path; the simulation-only fallback keeps its archived fixture behavior.
    turn = clamp(turn * yawCameraCos);
    const legacyAbsolutePitch = clamp(Math.atan2(relative.y, Math.max(1e-8, h)) / .95 + pitchRate / (4.2 * .95) + weave * .6 * Math.cos(snapshot.elapsed * Math.PI));
    // This pilot historically emitted a normalized absolute-pitch target.
    // Convert that target into the new manual-rate contract using the observed
    // sample interval; the adapter saturates at the product's legal stick rate.
    let climb = absolutePitchTargetToRateCommand(legacyAbsolutePitch, player.pitch, player.speed, sampleDt);
    if (attackLockShipId === target.id && snapshot.tick <= attackLockUntil
      && target.kind === 'ship' && shipPhase === 'attack') {
      turn = 0;
      climb = attackLockClimb;
      fastChase = false;
    }
    // A held physical stick now owns turn/pitch, including small corrections.
    // Do not bias naval approaches upward to oppose the old Easy nose-down
    // assist: that assist is absent while this real-input pilot holds its stick.
    const norm = Math.hypot(turn, climb);
    if (norm > 1) { turn /= norm; climb /= norm; }
    const alignment = forwardOf(player).angleTo(aim.clone().sub(player.position));
    if (target.kind !== 'aircraft' || distance < 500) fastChase = false;
    else if (distance > 800) fastChase = true;
    // Reposition and disengage at speed instead of loitering in the AA envelope.
    // Keep closure until within a close turning engagement; 85m/s at 500m
    // let the faster target recede throughout the reinforcement recovery leg.
    const wantedSpeed = fastChase || evasive ? 141 : target.kind === 'ship' || distance > 250 ? 110 : 85;
    trimDirection = snapshot.mode === 'easy' ? 0 : estimatedTrim < wantedSpeed - 1 ? 1 : estimatedTrim > wantedSpeed + 1 ? -1 : 0;
    if (snapshot.mode === 'easy' && bomb) pendingBombCount = player.bombs;
    return {turn,climb,bomb,torpedo:false,fire:!evasive && alignment < .1 && distance < 1150,loop:false,accelerate:trimDirection>0,brake:trimDirection<0};

  };
  return Object.assign(
    (snapshot: BrowserPilotSnapshot) => run(snapshot),
    {
      /** Evaluate a candidate without advancing cadence, target or control history. */
      preview(snapshot: BrowserPilotSnapshot): FlightInput {
        const memory=captureMemory();
        try { return run(snapshot); }
        finally { restoreMemory(memory); }
      },
      /** Record only a verified real ammo decrement so Easy can enter its exit leg. */
      recordBombRelease(beforeCount: number) { pendingBombCount=beforeCount; },
    },
  );
}
