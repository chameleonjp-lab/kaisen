import assert from 'node:assert/strict';
import test from 'node:test';
import { Euler, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { autoFireTarget, getFlightAssist } from '../src/flight-assist';
import { createFlightController, forwardOf, updatePlayerLoop, updateQuaternion } from '../src/flight';
import { EASY_CAMERA_LOOK_ANGLE, FLIGHT_CAMERA_BANK_FACTOR, FLIGHT_FAR, FLIGHT_FOV, NORMAL_CAMERA_LOOK_ANGLE, getFlightCameraPose } from '../src/flight-view';
import { projectGunSight } from '../src/gun-sight';
import { FlightControls } from '../src/input';
import { createGame, startGame, stepGame } from '../src/simulation';
import type { FlightInput, GameMode } from '../src/types';

const neutral: FlightInput = { turn: 0, climb: 0, fire: false, loop: false, viewAspect: 393 / 852 };
function quiet(mode: GameMode) {
  const state = createGame(73, mode);
  state.player.position.set(0, 1500, 0); state.player.previous.copy(state.player.position);
  for (const target of [...state.allies, ...state.enemies, ...state.ships]) target.health = 0;
  const ship = state.ships[0]; ship.health = ship.maxHealth; ship.position.set(10000, 0, -10000); ship.previous.copy(ship.position);
  startGame(state);
  return state;
}
function screenTarget(state: ReturnType<typeof createGame>, x: number, y: number) {
  const position = new Vector3(), rotation = new Quaternion();
  getFlightCameraPose(state.player, state.mode, position, rotation);
  const target = state.enemies[0]; target.health = 100;
  const tanHalf = Math.tan(FLIGHT_FOV * Math.PI / 360);
  target.position.set(x * 500 * tanHalf * neutral.viewAspect!, y * 500 * tanHalf, -500).applyQuaternion(rotation).add(position);
  target.previous.copy(target.position);
  return target;
}
function advance(state: ReturnType<typeof createGame>, input: FlightInput, ticks: number) {
  for (let i = 0; i < ticks; i++) stepGame(state, input);
}

function cameraForward(state: ReturnType<typeof createGame>): Vector3 {
  const rotation = new Quaternion();
  getFlightCameraPose(state.player, state.mode, new Vector3(), rotation);
  return new Vector3(0, 0, -1).applyQuaternion(rotation).normalize();
}

function cameraAngle(before: Vector3, after: Vector3): number {
  return Math.atan2(new Vector3().crossVectors(before, after).length(), before.dot(after));
}

test('Normal emits no automatic shots or visible-target steering; Easy keeps both', () => {
  for (const mode of ['easy', 'normal'] as const) {
    const state = quiet(mode), target = screenTarget(state, .8, .3);
    const assist = getFlightAssist(state.player, [target], neutral, mode);
    if (mode === 'normal') {
      assert.equal(assist.turn, 0); assert.equal(assist.climb, 0);
      assert.equal(autoFireTarget(state.player, [target], mode, neutral.viewAspect), null);
    } else { assert.ok(assist.turn > 0); assert.ok(assist.climb > 0); }
    stepGame(state, neutral);
    assert.equal(mode === 'normal' ? state.player.yaw : 0, 0);
    if (mode === 'easy') assert.ok(state.player.yaw < 0);
  }
  for (const mode of ['easy', 'normal'] as const) {
    const state = quiet(mode); screenTarget(state, 0, 0);
    stepGame(state, neutral);
    assert.equal(state.stats.shots, mode === 'easy' ? 4 : 0);
  }
});

test('Normal bullets follow the bore line, while Easy alone predicts a crossing target', () => {
  for (const mode of ['easy', 'normal'] as const) {
    const state = quiet(mode), target = state.enemies[0];
    target.health = 100; target.position.copy(state.player.position).add(new Vector3(0, 0, -650));
    target.previous.copy(target.position); target.yaw = -Math.PI / 2; target.speed = 116; updateQuaternion(target);
    stepGame(state, { ...neutral, fire: true });
    const bullets = state.bullets.filter(b => b.owner === state.player.id);
    assert.equal(bullets.length, 4);
    const forward = forwardOf(state.player);
    for (const bullet of bullets) {
      const angle = bullet.velocity.clone().normalize().angleTo(forward);
      if (mode === 'normal') assert.ok(angle < 1e-10, 'manual shot is not corrected toward the target');
      else assert.ok(angle > .005 && angle <= .0280000001, 'Easy only partially corrects toward straight lead');
    }
    const velocities = bullets.map(b => b.velocity.toArray());
    target.position.x += 200;
    stepGame(state, neutral);
    bullets.forEach((b, i) => assert.deepEqual(b.velocity.toArray(), velocities[i], 'launched shots do not home'));
  }
});

test('Easy target assistance keeps its absolute-pitch command contract', () => {
  const state = quiet('easy');
  state.player.pitch = .4; updateQuaternion(state.player);
  const target = screenTarget(state, 0, -.6);
  const assist = getFlightAssist(state.player, [target], neutral, 'easy');
  assert.ok(assist.climb > 0, 'the selected target requests an absolute pitch below the current nose-up attitude');
  const adjusted = { ...neutral, turn: assist.turn, climb: assist.climb };
  const before = state.player.pitch;
  updatePlayerLoop(state.player, createFlightController(state.player), adjusted, neutral, false, 1 / 60, 110, 141, 1);
  const targetPitch = assist.climb * .95;
  const expected = before + (targetPitch - before) * (1 - Math.exp(-4.2 / 60));
  assert.ok(Math.abs(state.player.pitch - expected) < 1e-12,
    'non-manual Easy correction remains a smoothed absolute attitude target, not a manual rate');
});

test('Normal throttle persists after release; Easy ignores fire and throttle away from targets', () => {
  const easy = quiet('easy'), normal = quiet('normal');
  advance(easy, { ...neutral, fire: true, accelerate: true }, 120);
  advance(normal, { ...neutral, accelerate: true }, 120);
  assert.equal(easy.stats.shots, 0); assert.equal(easy.player.speed, 110);
  assert.ok(normal.player.speed > 120);
  const fast = normal.player.speed; advance(normal, neutral, 60);
  assert.ok(normal.player.speed > fast, 'release retains the faster target');
  advance(normal, { ...neutral, brake: true }, 240);
  assert.ok(normal.player.speed < 95 && normal.player.speed >= 65);
  const held = normal.player.speed;
  advance(normal, { ...neutral, accelerate: true, brake: true }, 60);
  assert.ok(normal.player.speed < held, 'opposite buttons cancel trim changes rather than selecting accelerate');
});

test('source offscreen yaw boost ramps gently in both modes without amplifying bank or pitch', () => {
  for (const mode of ['easy', 'normal'] as const) {
    const offscreen = quiet(mode), visible = quiet(mode);
    screenTarget(visible, 0, 0);
    const before = cameraForward(visible), pitchBefore = visible.player.pitch;
    const input = { ...neutral, turn: 1, climb: .4 };
    stepGame(offscreen, input); stepGame(visible, input);
    // Finite yaw is compensated for the camera pitch. Measure its actual
    // contribution to the optical-axis angle, not the obsolete Euler ratio.
    const pitchDelta = visible.player.pitch - pitchBefore;
    const visibleAngle = cameraAngle(before, cameraForward(visible));
    const boostedAngle = cameraAngle(before, cameraForward(offscreen));
    const horizontal = Math.sqrt(visibleAngle ** 2 - pitchDelta ** 2);
    const boostedHorizontal = Math.sqrt(boostedAngle ** 2 - pitchDelta ** 2);
    assert.ok(horizontal > 0);
    assert.ok(Math.abs(boostedHorizontal / horizontal - (1 + 2.5 / 60)) < 1e-10);
    assert.equal(offscreen.player.bank, visible.player.bank);
    assert.equal(offscreen.player.pitch, visible.player.pitch);
    const noTargets = getFlightAssist(offscreen.player, [], input, mode);
    assert.equal(noTargets.responseMultiplier, 1);
  }
});

test('Normal sight projects fixed forward convergence plane through the real camera without moving the aircraft', () => {
  const state = quiet('normal'), target = state.enemies[0];
  for (const [width, height] of [[393, 852], [852, 393], [320, 568]]) {
    for (const pitch of [-.5, 0, .95]) for (const bank of [-.72, 0, .72]) {
      state.player.pitch = pitch; state.player.bank = bank; state.player.yaw = .3; updateQuaternion(state.player);
      const forward = forwardOf(state.player);
      target.health = 100; target.position.copy(state.player.position).addScaledVector(forward, 650);
      const before = JSON.stringify(state.player);
      const camera = new PerspectiveCamera(64, width / height, .1, FLIGHT_FAR);
      getFlightCameraPose(state.player, 'normal', camera.position, camera.quaternion); camera.updateMatrixWorld(true);
      // Independent source updateCamera calculation: muzzle at -4.5, convergence depth 500.
      const projected = new Vector3(0, 0, -504.5).applyQuaternion(state.player.quaternion).add(state.player.position).project(camera);
      const sight = projectGunSight(state.player, [target], width, height);
      assert.ok(Math.abs(sight.x - (projected.x * .5 + .5) * width) < 1e-9);
      assert.ok(Math.abs(sight.y - (.5 - projected.y * .5) * height) < 1e-9);
      assert.ok(Math.abs(sight.depth - 500) < 1e-9);
      assert.equal(JSON.stringify(state.player), before);
    }
  }
  state.player.pitch = state.player.yaw = state.player.bank = 0;
  updateQuaternion(state.player);
  const fallback = projectGunSight(state.player, [], 393, 852);
  assert.equal(fallback.depth, 500); assert.ok(fallback.y < 426 - 80, 'Normal sight is above center due to the source camera tilt');
  target.health = 0; assert.equal(projectGunSight(state.player, [target], 393, 852).depth, 500);
});

test('the sea-contact final frame keeps the camera look angle tied to the actual impact attitude', () => {
  const state = quiet('normal');
  state.player.position.set(0, 3.6, 0); state.player.previous.copy(state.player.position);
  state.player.pitch = -.5; updateQuaternion(state.player);
  stepGame(state, { ...neutral, turn: .6, climb: -.6, steeringActive: true });
  assert.equal(state.phase, 'ended');
  assert.equal(state.deathCause, 'sea');
  const opticalAxis = cameraForward(state);
  assert.ok(Math.abs(cameraAngle(forwardOf(state.player), opticalAxis) - Math.abs(NORMAL_CAMERA_LOOK_ANGLE)) < 1e-12,
    'a sub-tick impact cannot leave the camera looking from the full-tick Euler attitude');
});

test('Normal input releases only the ended finger while steering and another action remain held', () => {
  const attributes = new Map([['aria-pressed', 'true']]);
  const button = { getAttribute: (key: string) => attributes.get(key), setAttribute: (key: string, value: string) => attributes.set(key, value), classList: { remove() {} } };
  const controls = Object.assign(Object.create(FlightControls.prototype), {
    active: () => true, mode: 'normal', steerPointer: 1, turn: .5, climb: -.25,
    steeringRevision: 9, loopEdge: false, keys: new Set(), clickBursts: new Set(),
    holds: { fire: new Set([2]), loop: new Set(), accelerate: new Set([3]), brake: new Set() },
  });
  assert.deepEqual(controls.sample(), { turn: .5, climb: -.25, fire: true, loop: false, bomb:false,torpedo:false,accelerate: true, brake: false, steeringRevision: 9, steeringActive: true });
  controls.endButton('fire', button, { pointerId: 2 }, true);
  const after = controls.sample();
  assert.equal(after.fire, false); assert.equal(after.accelerate, true);
  assert.equal(after.turn, .5); assert.equal(controls.steerPointer, 1);
  controls.endButton('accelerate', button, { pointerId: 3 }, false);
  assert.equal(controls.sample().accelerate, false);
  assert.equal(controls.steerPointer, 1);
});

class TouchElement extends EventTarget {
  readonly style = { setProperty() {}, removeProperty() {} };
  readonly classList = { add() {}, remove() {} };
  readonly attributes = new Map<string, string>();
  readonly captures = new Set<number>();
  constructor(private readonly app?: TouchElement) { super(); }
  closest(selector: string) { return selector === '#app' ? this.app ?? this : null; }
  querySelector() { return null; }
  append() {}
  getBoundingClientRect() { return { left: 0, top: 0, right: 400, bottom: 600, width: 400, height: 600 }; }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  getAttribute(key: string) { return this.attributes.get(key) ?? null; }
  setPointerCapture(id: number) { this.captures.add(id); }
  hasPointerCapture(id: number) { return this.captures.has(id); }
  releasePointerCapture(id: number) { this.captures.delete(id); }
}

function touchPointer(type: string, pointerId: number, clientY: number) {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, { pointerId, clientX: 100, clientY, pointerType: 'touch', button: 0, buttons: 1, isPrimary: false });
  return event;
}

test('real FlightControls touch sample reaches fixed-step flight and the rendered camera pose in both modes', () => {
  const keys = ['window', 'document'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const app = new TouchElement();
  const win = Object.assign(new EventTarget(), { visualViewport: new EventTarget() });
  const doc = Object.assign(new EventTarget(), {
    hidden: false,
    getElementById: () => app,
    createElement: () => new TouchElement(app),
  });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: win });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
  try {
    for (const mode of ['easy', 'normal'] as const) {
      const surface = new TouchElement(app);
      const buttons = { fire: new TouchElement(app), loop: new TouchElement(app) };
      const controls = new FlightControls(surface as any, buttons as any, () => true);
      controls.setMode(mode);
      try {
        const state = createGame(733, mode);
        for (const target of [...state.enemies, ...state.ships]) target.health = 0;
        startGame(state);
        const oldPitch = state.player.pitch, speed = state.player.speed;
        const joystickStartY = 200;
        surface.dispatchEvent(touchPointer('pointerdown', 1, joystickStartY));
        win.dispatchEvent(touchPointer('pointermove', 1, joystickStartY - 6));
        const sampled = controls.sample();
        assert.equal(sampled.steeringActive, true);
        assert.equal(sampled.turn, 0);
        assert.ok(sampled.climb > 0 && sampled.climb < 1);

        const beforeCameraPosition = new Vector3(), beforeCameraRotation = new Quaternion();
        getFlightCameraPose(state.player, mode, beforeCameraPosition, beforeCameraRotation);
        const oldCameraRotation = beforeCameraRotation.clone();
        stepGame(state, sampled);

        const lowSpeed = speed <= 85 ? .92 + ((speed - 65) / 20) * .23
          : speed <= 110 ? 1.15 - ((speed - 85) / 25) * .15 : 1;
        const speedAuthority = lowSpeed * Math.max(.78, Math.min(1, 1 - Math.max(0, speed - 115) * .008));
        const expectedPitch = oldPitch + sampled.climb * .82 * speedAuthority / 60;
        assert.ok(Math.abs(state.player.pitch - expectedPitch) < 1e-12, `${mode} fixed-step consumes touch pitch at the shared angular rate`);

        const cameraPosition = new Vector3(), cameraRotation = new Quaternion();
        getFlightCameraPose(state.player, mode, cameraPosition, cameraRotation);
        const lookAngle = mode === 'normal' ? NORMAL_CAMERA_LOOK_ANGLE : EASY_CAMERA_LOOK_ANGLE;
        const expectedCameraRotation = new Quaternion().setFromEuler(new Euler(state.player.pitch, state.player.yaw, 0, 'YXZ'))
          .multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), lookAngle))
          .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), -state.player.bank * FLIGHT_CAMERA_BANK_FACTOR));
        const dot = Math.abs(cameraRotation.dot(expectedCameraRotation));
        assert.ok(1 - dot < 1e-12, `${mode} camera follows the updated simulation quaternion`);
        assert.ok(1 - Math.abs(cameraRotation.dot(oldCameraRotation)) > 0, 'the camera pose changes with the accepted flight input');
        if (mode === 'normal') {
          const cameraEuler = new Euler().setFromQuaternion(cameraRotation, 'YXZ');
          assert.ok(Math.abs(cameraEuler.x - (state.player.pitch - .19)) < 1e-12,
            'with zero yaw/bank, rendered camera pitch includes the fixed -0.19 rad look offset');
        }
        win.dispatchEvent(touchPointer('pointerup', 1, joystickStartY - 6));
      } finally { controls.dispose(); }
    }
  } finally {
    for (const [key, descriptor] of keys) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});


test('Normal sight is independent of target loss, switching and extreme target depth', () => {
  const state = quiet('normal'), target = state.enemies[0]; target.health = 100;
  const fixed = projectGunSight(state.player, [], 393, 852);
  for (const depth of [24, 25, 500, 1199, 1200, 1201]) {
    target.position.copy(state.player.position).addScaledVector(forwardOf(state.player), depth);
    assert.deepEqual(projectGunSight(state.player, [target], 393, 852), fixed);
  }
});
