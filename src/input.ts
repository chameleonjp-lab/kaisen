import type { FlightInput } from './types';
import { ThrottleControl } from './throttle-control';
import { combineThrottleAxes } from './throttle-lever';
import { DEFAULT_KEY_BINDINGS, KeyboardSettings, keyboardEventHasShortcutModifier, type KeyAction } from './keyboard-settings';

export type FlightControlButtons = {
  fire: HTMLButtonElement;
  loop: HTMLButtonElement;
  accelerate?: HTMLButtonElement;
  brake?: HTMLButtonElement;
  throttle?: HTMLElement;
  bomb?: HTMLButtonElement;
  torpedo?: HTMLButtonElement;
};
export type KaisenControlButtons = FlightControlButtons & { bomb: HTMLButtonElement; torpedo: HTMLButtonElement };

type ControlName = Exclude<keyof FlightControlButtons, 'throttle'>;
export type FlightMode = 'normal' | 'easy';

const STEERING_ACTIONS = new Set<KeyAction>(['left', 'right', 'up', 'down']);
const NORMAL_ACTIONS = new Set<KeyAction>(['fire', 'accelerate', 'brake']);

function neutralInput(steeringRevision = 0): FlightInput {
  return { turn: 0, climb: 0, fire: false, loop: false, accelerate: false, brake: false, steeringRevision };
}

/** Pointer and keyboard input for flight controls and optional payload actions. */
export class FlightControls {
  private readonly throttle?: ThrottleControl;
  private steerPointer: number | null = null;
  private steerPointerType: string | null = null;
  private readonly buttonPointerTypes = new Map<number, string>();
  private readonly holds: Record<ControlName, Set<number>> = {
    fire: new Set(), loop: new Set(), accelerate: new Set(), brake: new Set(), bomb: new Set(), torpedo: new Set(),
  };
  private readonly controlNames: ControlName[];
  private readonly keys = new Set<string>();
  private readonly focusedThrottleKeys = new Set<string>();
  private readonly clickBursts = new Set<ControlName>();
  private loopEdge = false;
  private turn = 0;
  private climb = 0;
  // This revision tracks user intent; clear() deliberately does not increment
  // it because pause/blur release controls synthetically.
  private steeringRevision = 0;
  private origin = { x: 0, y: 0 };
  private mode: FlightMode = 'normal';
  private readonly abort = new AbortController();
  private readonly joystick: HTMLElement;
  private readonly knob: HTMLElement | null;
  private readonly unsubscribeKeys: () => void;

  constructor(
    private readonly surface: HTMLElement,
    private readonly buttons: FlightControlButtons,
    private readonly active: () => boolean,
    private readonly keyboard = new KeyboardSettings(),
  ) {
    this.unsubscribeKeys = keyboard.subscribe(() => this.clear());
    this.controlNames = (Object.keys(buttons) as ControlName[]).filter(name => name !== ('throttle' as string) && Boolean(buttons[name]));
    const app = surface.closest<HTMLElement>('#app') ?? document.getElementById('app') ?? surface;
    let joystick = app.querySelector<HTMLElement>('#joystick');
    if (!joystick) {
      joystick = document.createElement('div');
      joystick.id = 'joystick';
      joystick.setAttribute('aria-hidden', 'true');
      joystick.innerHTML = '<i></i>';
      app.append(joystick);
    }
    this.joystick = joystick;
    this.knob = joystick.querySelector<HTMLElement>('i');

    if (buttons.throttle) this.throttle = new ThrottleControl(buttons.throttle,
      () => this.active() && this.mode === 'normal', event => {
        if (this.steerPointer === event.pointerId || this.buttonPointerTypes.has(event.pointerId)) return false;
        if (event.isPrimary) this.retireSameTypePointer(event.pointerType);
        return true;
      }, () => {
        // Focus transfers key ownership, never another finger's steering or fire.
        if ([...this.keys].some(code => { const action = this.keyboard.action(code); return action && STEERING_ACTIONS.has(action); })) this.steeringRevision += 1;
        this.keys.clear();
      }, () => {
        for (const code of this.focusedThrottleKeys) this.keys.delete(code);
        this.focusedThrottleKeys.clear();
      });
    const opts = { signal: this.abort.signal };
    surface.addEventListener('pointerdown', event => this.beginSteering(event, app), opts);
    window.addEventListener('pointermove', event => this.moveSteering(event), opts);
    window.addEventListener('pointerup', event => this.endPointer(event, true), opts);
    window.addEventListener('pointercancel', event => this.endPointer(event, false), opts);
    surface.addEventListener('lostpointercapture', event => this.endSteering(event), opts);
    surface.addEventListener('contextmenu', event => event.preventDefault(), opts);

    for (const name of this.controlNames) {
      const button = buttons[name]!;
      button.addEventListener('pointerdown', event => this.beginButton(name, button, event), opts);
      button.addEventListener('pointerup', event => this.endButton(name, button, event, true), opts);
      button.addEventListener('pointercancel', event => this.endButton(name, button, event, false), opts);
      button.addEventListener('lostpointercapture', event => this.endButton(name, button, event, false), opts);
      button.addEventListener('click', event => {
        // Keep native keyboard and assistive-technology activation while ignoring
        // the compatibility click generated after a pointer gesture.
        if (event.detail === 0 && this.active()) this.activateOnce(name);
      }, opts);
      button.addEventListener('contextmenu', event => event.preventDefault(), opts);
    }

    window.addEventListener('keydown', event => this.keyDown(event), opts);
    window.addEventListener('keyup', event => this.keyUp(event), opts);
    window.addEventListener('blur', () => this.clear(), opts);
    window.addEventListener('pagehide', () => this.clear(), opts);
    window.addEventListener('resize', () => this.clear(), opts);
    window.addEventListener('orientationchange', () => this.clear(), opts);
    window.visualViewport?.addEventListener('resize', () => this.clear(), opts);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.clear();
    }, opts);
  }

  peek() { return { turn: this.turn, climb: this.climb, steerPointer: this.steerPointer, throttle: this.throttle?.value() ?? 0, throttlePointer: this.throttle?.pointer ?? null, heldPointers: Object.fromEntries(Object.entries(this.holds).map(([name, ids]) => [name, [...ids]])), keys: [...this.keys] }; }

  sample(consumeThrottle = true): FlightInput {
    if (!this.active()) {
      this.clear();
      return neutralInput(this.steeringRevision);
    }

    const keyHeld = (action: KeyAction) => this.keys.has(this.keyboard?.code(action) ?? DEFAULT_KEY_BINDINGS[action]);
    const turn = this.turn + Number(keyHeld('right')) - Number(keyHeld('left'));
    const climb = this.climb + Number(keyHeld('up')) - Number(keyHeld('down'));
    const pressed = (name: ControlName) => this.holds[name].size > 0;
    const normal = this.mode === 'normal';
    const fire = normal && (pressed('fire') || keyHeld('fire') || this.clickBursts.has('fire'));
    const accelerate = normal && (pressed('accelerate') || keyHeld('accelerate') || this.clickBursts.has('accelerate'));
    const brake = normal && (pressed('brake') || keyHeld('brake') || this.clickBursts.has('brake'));
    const loop = this.loopEdge;
    const bomb = this.clickBursts.has('bomb'), torpedo = this.clickBursts.has('torpedo');

    this.loopEdge = false;
    this.clickBursts.clear();
    return {
      turn: Math.max(-1, Math.min(1, turn)),
      climb: Math.max(-1, Math.min(1, climb)),
      fire,
      loop, bomb, torpedo,
      accelerate,
      brake,
      ...(this.throttle ? { throttle: normal ? this.throttle.sample(consumeThrottle, accelerate, brake) : 0 } : {}),
      steeringRevision: this.steeringRevision,
    };
  }

  /** Consume short slider commands only when a fixed simulation tick will run. */
  sampleThrottle(): number {
    if (!this.active() || this.mode !== 'normal') { this.throttle?.clear(); return 0; }
    const held = (action: KeyAction) => this.keys.has(this.keyboard.code(action));
    return this.throttle?.sample(true, held('accelerate'), held('brake')) ?? combineThrottleAxes(0, held('accelerate'), held('brake'));
  }

  /** Changes which actions this flight accepts and releases controls from the previous mode. */
  setMode(mode: FlightMode): void {
    if (this.mode === mode) return;
    this.clear();
    this.mode = mode;
  }

  clear(): void {
    this.throttle?.clear();
    const steeringPointer = this.steerPointer;
    this.steerPointer = null;
    this.steerPointerType = null;
    this.buttonPointerTypes.clear();
    this.turn = 0;
    this.climb = 0;
    this.keys.clear();
    this.loopEdge = false;
    this.clickBursts.clear();
    this.joystick.classList.remove('visible');
    this.joystick.style.removeProperty('--joystick-x');
    this.joystick.style.removeProperty('--joystick-y');

    if (steeringPointer !== null) this.releaseCapture(this.surface, steeringPointer);
    for (const name of this.controlNames) {
      const button = this.buttons[name]!;
      for (const pointer of this.holds[name]) this.releaseCapture(button, pointer);
      this.holds[name].clear();
      button.classList.remove('is-pressed');
      button.setAttribute('aria-pressed', 'false');
    }
  }

  dispose(): void {
    this.clear();
    this.throttle?.dispose();
    this.unsubscribeKeys();
    this.abort.abort();
  }

  private beginSteering(event: PointerEvent, app: HTMLElement): void {
    if (!this.active() || (event.pointerType === 'mouse' && event.button !== 0)) return;
    if (event.isPrimary) this.retireSameTypePointer(event.pointerType);
    if (this.steerPointer !== null) return;
    if (this.throttle?.pointer === event.pointerId || this.buttonPointerTypes.has(event.pointerId)) return;
    event.preventDefault();
    this.steerPointer = event.pointerId;
    this.steerPointerType = event.pointerType;
    this.origin = { x: event.clientX, y: event.clientY };
    const appRect = app.getBoundingClientRect();
    this.joystick.style.left = `${event.clientX - appRect.left}px`;
    this.joystick.style.top = `${event.clientY - appRect.top}px`;
    this.joystick.classList.add('visible');
    this.joystick.style.setProperty('--joystick-x', '0px');
    this.joystick.style.setProperty('--joystick-y', '0px');
    this.capture(this.surface, event.pointerId);
  }

  private moveSteering(event: PointerEvent): void {
    if (event.pointerId !== this.steerPointer) return;
    if (event.pointerType === 'mouse' && event.buttons === 0) { this.endSteering(event); return; }
    event.preventDefault();
    const dx = event.clientX - this.origin.x;
    const dy = event.clientY - this.origin.y;
    const distance = Math.hypot(dx, dy);
    const radius = 36;
    const scale = distance > radius ? radius / distance : 1;
    const magnitude = Math.min(distance / radius, 1);
    const response = magnitude <= 0.08 ? 0 : (magnitude - 0.08) / 0.92;
    const previousTurn = this.turn;
    const previousClimb = this.climb;
    this.joystick.style.setProperty('--joystick-x', `${dx * scale}px`);
    this.joystick.style.setProperty('--joystick-y', `${dy * scale}px`);
    this.turn = distance === 0 ? 0 : (dx / distance) * response;
    this.climb = distance === 0 ? 0 : (-dy / distance) * response;
    if (Math.abs(this.turn - previousTurn) > 1e-4 || Math.abs(this.climb - previousClimb) > 1e-4) {
      this.steeringRevision += 1;
    }
  }

  /** A new primary down retires an ended gesture of that device type only.
   * Pointer IDs can be recycled; concurrent mouse/pen/touch each have a primary.
   */
  private retireSameTypePointer(pointerType: string): void {
    if (this.throttle?.pointerType === pointerType) this.throttle.releasePointer();
    if (this.steerPointer !== null && this.steerPointerType === pointerType) {
      const id = this.steerPointer;
      this.endSteering({ pointerId: id } as PointerEvent);
      this.releaseCapture(this.surface, id);
    }
    for (const name of this.controlNames) {
      for (const id of this.holds[name]) if (this.buttonPointerTypes.get(id) === pointerType) {
        this.endButton(name, this.buttons[name]!, { pointerId: id } as PointerEvent, false);
        this.releaseCapture(this.buttons[name]!, id);
      }
    }
  }

  private endPointer(event: PointerEvent, completed: boolean): void {
    this.endSteering(event);
    for (const name of this.controlNames) this.endButton(name, this.buttons[name]!, event, completed);
  }

  private endSteering(event: PointerEvent): void {
    if (event.pointerId !== this.steerPointer) return;
    this.steerPointer = null;
    this.steerPointerType = null;
    if (Math.abs(this.turn) > 1e-4 || Math.abs(this.climb) > 1e-4) this.steeringRevision += 1;
    this.turn = 0;
    this.climb = 0;
    this.joystick.classList.remove('visible');
    this.joystick.style.removeProperty('--joystick-x');
    this.joystick.style.removeProperty('--joystick-y');
  }

  private beginButton(name: ControlName, button: HTMLButtonElement, event: PointerEvent): void {
    if (!this.active() || (event.pointerType === 'mouse' && event.button !== 0)) return;
    if (this.mode === 'easy' && name !== 'loop' && name !== 'bomb' && name !== 'torpedo') return;
    if (name === 'loop' && button.getAttribute('aria-disabled') === 'true') return;
    if (event.isPrimary) this.retireSameTypePointer(event.pointerType);
    if (this.throttle?.pointer === event.pointerId || this.steerPointer === event.pointerId) return;
    event.preventDefault();
    this.holds[name].add(event.pointerId);
    this.buttonPointerTypes.set(event.pointerId, event.pointerType);
    this.capture(button, event.pointerId);
    button.classList.add('is-pressed');
    button.setAttribute('aria-pressed', 'true');
  }

  private endButton(name: ControlName, button: HTMLButtonElement, event: PointerEvent, completed: boolean): void {
    if (!this.holds[name].has(event.pointerId)) return;
    this.holds[name].delete(event.pointerId);
    this.buttonPointerTypes?.delete(event.pointerId);
    if (completed && this.active() && button.getAttribute('aria-disabled') !== 'true') {
      if (name === 'loop') this.loopEdge = true;
      if (name === 'bomb' || name === 'torpedo') this.clickBursts.add(name);
    }
    if (this.holds[name].size === 0) {
      button.classList.remove('is-pressed');
      button.setAttribute('aria-pressed', 'false');
    }
  }

  private activateOnce(name: ControlName): void {
    if (this.mode === 'easy' && name !== 'loop' && name !== 'bomb' && name !== 'torpedo') return;
    if (name === 'loop') {
      if (this.buttons.loop.getAttribute('aria-disabled') !== 'true') this.loopEdge = true;
    } else {
      this.clickBursts.add(name);
    }
  }

  private keyDown(event: KeyboardEvent): void {
    // Do not let browser shortcuts leave a previously held flight key latched.
    if (keyboardEventHasShortcutModifier(event)) {
      if ([...this.keys].some(code => {
        const action = this.keyboard.action(code);
        return action && STEERING_ACTIONS.has(action);
      })) this.steeringRevision += 1;
      this.keys.clear();
      return;
    }
    const action = this.keyboard.action(event.code);
    const allowed = action && action !== 'pause'
      && (this.mode === 'normal' || !NORMAL_ACTIONS.has(action))
      && (action !== 'bomb' || Boolean(this.buttons.bomb))
      && (action !== 'torpedo' || Boolean(this.buttons.torpedo));
    const ownLeverThrottleKey = (action === 'accelerate' || action === 'brake') && event.target instanceof HTMLElement
      && event.target.closest('[role="slider"]') === this.buttons.throttle;
    if (!this.active() || event.isComposing || !allowed || (this.isTypingOrActivating(event.target) && !ownLeverThrottleKey)) return;
    if (event.repeat && !this.keys.has(event.code)) return;
    event.preventDefault();
    if (STEERING_ACTIONS.has(action) && !this.keys.has(event.code)) this.steeringRevision += 1;
    const wasDown = this.keys.has(event.code);
    this.keys.add(event.code);
    if (ownLeverThrottleKey) this.focusedThrottleKeys.add(event.code);
    if (!wasDown && !event.repeat) {
      if (action === 'bomb' || action === 'torpedo') this.clickBursts.add(action);
      if (action === 'loop' && this.buttons.loop.getAttribute('aria-disabled') !== 'true') this.loopEdge = true;
    }
  }

  private keyUp(event: KeyboardEvent): void {
    this.focusedThrottleKeys.delete(event.code);
    const wasDown = this.keys.delete(event.code);
    const action = this.keyboard.action(event.code);
    if (wasDown && action && STEERING_ACTIONS.has(action)) this.steeringRevision += 1;
  }

  private isTypingOrActivating(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return target.isContentEditable || Boolean(target.closest('input, textarea, select, button, a, dialog, [role="dialog"], [role="slider"]'));
  }

  private capture(element: HTMLElement, pointer: number): void {
    try { element.setPointerCapture(pointer); } catch { /* The pointer may already have been released. */ }
  }

  private releaseCapture(element: HTMLElement, pointer: number): void {
    try {
      if (element.hasPointerCapture(pointer)) element.releasePointerCapture(pointer);
    } catch { /* Capture can be lost during a blur or page transition. */ }
  }
}
