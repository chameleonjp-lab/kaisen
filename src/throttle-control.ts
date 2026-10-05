import { combineThrottleAxes, throttleAxisFromClientY } from './throttle-lever';
import { keyboardEventHasShortcutModifier } from './keyboard-settings';

const POSITIVE = new Set(['ArrowUp', 'ArrowRight', 'End']);
const NEGATIVE = new Set(['ArrowDown', 'ArrowLeft', 'Home']);

/** One owned pointer plus focused slider keys; simulation owns the retained speed. */
export class ThrottleControl {
  pointer: number | null = null;
  pointerType: string | null = null;
  private axis = 0;
  private readonly pulses = new Set<string>();
  private sampledKeys = new Set<string>();
  private readonly keys = new Set<string>();
  private readonly abort = new AbortController();
  constructor(
    readonly element: HTMLElement,
    private readonly active: () => boolean,
    private readonly beforeStart: (event: PointerEvent) => boolean,
    private readonly onFocus: () => void = () => {},
    private readonly onClear: () => void = () => {},
  ) {
    const opts = { signal: this.abort.signal };
    element.addEventListener('pointerdown', event => this.begin(event), opts);
    window.addEventListener('pointermove', event => this.move(event), opts);
    window.addEventListener('pointerup', event => this.end(event), opts);
    window.addEventListener('pointercancel', event => this.end(event), opts);
    element.addEventListener('lostpointercapture', event => this.end(event), opts);
    element.addEventListener('contextmenu', event => event.preventDefault(), opts);
    element.addEventListener('focusin', () => this.onFocus(), opts);
    element.addEventListener('keydown', event => this.keyDown(event), opts);
    element.addEventListener('keyup', event => {
      if (POSITIVE.has(event.code) || NEGATIVE.has(event.code)) {
        event.preventDefault(); event.stopPropagation();
        if (this.keys.has(event.code) && !this.sampledKeys.has(event.code) && this.active()) this.pulses.add(event.code);
        this.keys.delete(event.code); this.sampledKeys.delete(event.code); this.render();
      }
    }, opts);
    element.addEventListener('focusout', () => this.clear(), opts);
    this.render();
  }
  sample(consume = true, accelerate = false, brake = false): number {
    const commands = new Set([...this.keys, ...this.pulses]);
    const focused = Number([...commands].some(key => POSITIVE.has(key))) - Number([...commands].some(key => NEGATIVE.has(key)));
    const value = combineThrottleAxes(this.axis, accelerate, brake, focused);
    if (!consume) return value;
    this.pulses.clear();
    for (const key of this.keys) this.sampledKeys.add(key);
    return value;
  }
  value(): number { return combineThrottleAxes(this.axis, false, false, this.focusedAxis()); }
  private focusedAxis(): number {
    return Number([...this.keys].some(key => POSITIVE.has(key))) - Number([...this.keys].some(key => NEGATIVE.has(key)));
  }
  releasePointer(): void {
    const pointer = this.pointer;
    this.pointer = null; this.pointerType = null; this.axis = 0;
    if (pointer !== null) {
      try { if (this.element.hasPointerCapture(pointer)) this.element.releasePointerCapture(pointer); } catch { /* Already released. */ }
    }
    this.render();
  }
  clear(): void { this.onClear(); this.keys.clear(); this.sampledKeys.clear(); this.pulses.clear(); this.releasePointer(); }
  dispose(): void { this.clear(); this.abort.abort(); }
  private begin(event: PointerEvent): void {
    if (!this.active() || this.element.getAttribute('aria-disabled') === 'true' || event.button !== 0) return;
    // A second finger cannot replace the current owner. A fresh primary may retire stale ownership.
    if (this.pointer !== null && !(event.isPrimary && event.pointerType === this.pointerType)) return;
    if (!this.beforeStart(event) || this.pointer !== null) return;
    event.preventDefault(); event.stopPropagation();
    this.pointer = event.pointerId; this.pointerType = event.pointerType;
    try {
      this.element.setPointerCapture(event.pointerId);
      if (!this.element.hasPointerCapture(event.pointerId)) { this.releasePointer(); return; }
    } catch { this.releasePointer(); return; }
    this.update(event.clientY);
  }
  private move(event: PointerEvent): void {
    if (event.pointerId !== this.pointer) return;
    if (!this.active()) { this.clear(); return; }
    if (event.pointerType === 'mouse' && event.buttons === 0) { this.releasePointer(); return; }
    event.preventDefault(); this.update(event.clientY);
  }
  private end(event: PointerEvent): void { if (event.pointerId === this.pointer) this.releasePointer(); }
  private update(y: number): void {
    const rect = this.element.getBoundingClientRect();
    const scaleY = rect.height / (this.element.offsetHeight || rect.height);
    const inset = 22 * scaleY;
    this.axis = rect.width > 0 && Number.isFinite(scaleY) && scaleY > 0
      ? throttleAxisFromClientY(y, rect.top + inset, rect.bottom - inset) : 0;
    this.render();
  }
  private keyDown(event: KeyboardEvent): void {
    if (event.code === 'Escape' || keyboardEventHasShortcutModifier(event)) { this.clear(); return; }
    if (!POSITIVE.has(event.code) && !NEGATIVE.has(event.code)) return;
    event.preventDefault(); event.stopPropagation();
    if (!this.active() || this.element.getAttribute('aria-disabled') === 'true' || event.isComposing || (event.repeat && !this.keys.has(event.code))) return;
    this.keys.add(event.code); this.render();
  }
  private render(): void {
    const value = this.value();
    this.element.style.setProperty('--throttle-axis', String(value));
    this.element.setAttribute('aria-valuenow', String(Math.round(value * 100)));
    this.element.setAttribute('aria-valuetext', value === 0 ? '保持（速度を維持）' : `${value > 0 ? '加速' : '減速'} ${Math.round(Math.abs(value) * 100)}%`);
    this.element.classList.toggle('is-pressed', this.pointer !== null || this.keys.size > 0);
  }
}
