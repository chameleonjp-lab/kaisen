import { readSettingsValue } from './settings-storage';
export const KEYBOARD_STORAGE_KEY = 'kaisen-keyboard-v1';
export const KEY_ACTIONS = ['left', 'right', 'up', 'down', 'fire', 'loop', 'accelerate', 'brake', 'bomb', 'torpedo', 'pause'] as const;
export type KeyAction = typeof KEY_ACTIONS[number];
export type KeyBindings = Record<KeyAction, string>;
export const KEY_LABELS: Record<KeyAction, string> = {
  left: '左旋回', right: '右旋回', up: '上昇', down: '下降', fire: '射撃', loop: '宙返り',
  accelerate: '加速', brake: '減速', bomb: '爆弾', torpedo: '魚雷', pause: '一時停止・再開',
};
export const DEFAULT_KEY_BINDINGS: Readonly<KeyBindings> = Object.freeze({
  left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown', fire: 'Space', loop: 'KeyL',
  accelerate: 'KeyW', brake: 'KeyS', bomb: 'KeyZ', torpedo: 'KeyX', pause: 'Escape',
});

const NAMED_KEYS: Record<string, string> = {
  ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Space: 'Space', Escape: 'Esc',
  Enter: 'Enter', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End',
  PageUp: 'Page Up', PageDown: 'Page Down', ShiftLeft: '左 Shift', ShiftRight: '右 Shift',
  Minus: '−', Equal: '= / ^', BracketLeft: '[ / @', BracketRight: '] / [', Backslash: '\\ / ]',
  Semicolon: ';', Quote: "' / :", Backquote: '` / 半角', Comma: ',', Period: '.', Slash: '/',
  IntlBackslash: 'Intl \\', IntlRo: 'ろ / \\', IntlYen: '¥ / \\',
  NumpadAdd: 'テンキー +', NumpadSubtract: 'テンキー −', NumpadMultiply: 'テンキー ×',
  NumpadDivide: 'テンキー ÷', NumpadDecimal: 'テンキー .', NumpadEnter: 'テンキー Enter', NumpadEqual: 'テンキー =',
};
// Keep browser navigation, developer tools and focus traversal available.
const RESERVED_KEYS = new Set(['Tab', 'F1', 'F5', 'F6', 'F10', 'F11', 'F12']);

export function keyLabel(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return `テンキー ${code.slice(6)}`;
  return NAMED_KEYS[code] ?? code;
}

export function isBindableCode(code: unknown, action?: KeyAction): code is string {
  if (typeof code !== 'string' || RESERVED_KEYS.has(code)) return false;
  if (code === 'Escape') return action === 'pause';
  return Object.hasOwn(NAMED_KEYS, code) || /^(Key[A-Z]|Digit[0-9]|Numpad[0-9]|F([2-9]|1[3-9]|2[0-4]))$/.test(code);
}

/** Reject the whole invalid record, rather than silently introducing duplicate fallbacks. */
export function validKeyBindings(value: unknown): value is KeyBindings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const bindings = value as Record<string, unknown>;
  return KEY_ACTIONS.every(action => isBindableCode(bindings[action], action))
    && new Set(KEY_ACTIONS.map(action => bindings[action])).size === KEY_ACTIONS.length;
}

export function parseKeyBindings(raw: string | null): KeyBindings {
  try {
    if (raw && raw.length > 8192) return { ...DEFAULT_KEY_BINDINGS };
    const data: unknown = raw ? JSON.parse(raw) : null;
    if (data && typeof data === 'object' && 'version' in data && data.version === 1
      && 'bindings' in data && validKeyBindings(data.bindings)) {
      const bindings = data.bindings;
      return Object.fromEntries(KEY_ACTIONS.map(action => [action, bindings[action]])) as KeyBindings;
    }
  } catch { /* Invalid or older data must not disable a flight action. */ }
  return { ...DEFAULT_KEY_BINDINGS };
}

export function keyboardEventHasShortcutModifier(event: Pick<KeyboardEvent, 'ctrlKey' | 'altKey' | 'metaKey'>): boolean {
  return Boolean(event.ctrlKey || event.altKey || event.metaKey);
}

export function isKeyboardEditingTarget(target: EventTarget | null): boolean {
  return typeof HTMLElement !== 'undefined' && target instanceof HTMLElement
    && (target.isContentEditable || Boolean(target.closest('input, textarea, select, dialog')));
}

export type CaptureResult = { kind: 'ignore' } | { kind: 'cancel' } | { kind: 'error'; message: string } | { kind: 'key'; code: string };
export function captureKey(event: KeyboardEvent): CaptureResult {
  if (event.isComposing || event.repeat) return { kind: 'ignore' };
  if (keyboardEventHasShortcutModifier(event)) return { kind: 'error', message: 'Ctrl・Alt・⌘との組み合わせはブラウザ操作用です。別のキーを押してください。' };
  if (event.code === 'Escape') return { kind: 'cancel' };
  if (!isBindableCode(event.code)) return { kind: 'error', message: 'このキーはブラウザや文字入力で使います。文字・数字・矢印など、別のキーを押してください。' };
  return { kind: 'key', code: event.code };
}

export function keyConflict(bindings: KeyBindings, action: KeyAction, code: string): KeyAction | undefined {
  return KEY_ACTIONS.find(other => other !== action && bindings[other] === code);
}

/** Capability is a default, never a restriction: both editors stay reachable on hybrids. */
export function preferredControlEditor(finePointer: boolean, hover: boolean, touchPoints: number, keyboardSeen = false): 'touch' | 'keyboard' {
  return keyboardSeen || (finePointer && hover) || touchPoints === 0 ? 'keyboard' : 'touch';
}

export function preferredControlInput(): 'touch' | 'keyboard' {
  return preferredControlEditor(
    window.matchMedia?.('(any-pointer: fine)').matches ?? false,
    window.matchMedia?.('(any-hover: hover)').matches ?? false,
    navigator.maxTouchPoints ?? 0,
  );
}

export class ControlInputPresentation {
  private current = preferredControlInput();
  private pendingPointer: string | null = null;
  private readonly abort = new AbortController();
  private readonly listeners = new Set<() => void>();
  constructor() {
    window.addEventListener('pointerdown', event => {
      // Only observe here: changing guide height during pointerdown moves the
      // pressed radio/start button before release, cancelling its activation.
      this.pendingPointer = event.pointerType;
    }, { signal: this.abort.signal });
    window.addEventListener('pointercancel', () => { this.pendingPointer = null; }, { signal: this.abort.signal });
    window.addEventListener('blur', () => { this.pendingPointer = null; }, { signal: this.abort.signal });
    window.addEventListener('click', event => {
      // The click target is already committed. Capture updates presentation
      // before a settings/help click handler chooses its device-specific view.
      // WebKit can label a touch-generated click as mouse; trust its press first.
      const pointer = this.pendingPointer || event.pointerType; this.pendingPointer = null;
      if (pointer === 'mouse') this.set('keyboard');
      else if (pointer === 'touch' || pointer === 'pen') this.set('touch');
    }, { signal: this.abort.signal, capture: true });
    window.addEventListener('keydown', event => {
      this.pendingPointer = null;
      if (!event.isComposing && !keyboardEventHasShortcutModifier(event)) this.set('keyboard');
    }, { signal: this.abort.signal });
  }
  get value(): 'touch' | 'keyboard' { return this.current; }
  private set(value: 'touch' | 'keyboard'): void {
    if (this.current === value) return;
    this.current = value;
    for (const listener of this.listeners) listener();
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  dispose(): void { this.abort.abort(); this.listeners.clear(); }
}

/** The dialog owns persistence; flight only receives committed bindings. */
export class KeyboardSettings {
  private current: KeyBindings;
  private readonly listeners = new Set<() => void>();

  constructor() {
    let raw: string | null = null;
    try { raw = readSettingsValue(KEYBOARD_STORAGE_KEY, localStorage); } catch { /* Storage is optional. */ }
    this.current = parseKeyBindings(raw);
  }

  get bindings(): KeyBindings { return { ...this.current }; }
  code(action: KeyAction): string { return this.current[action]; }
  action(code: string): KeyAction | undefined { return KEY_ACTIONS.find(action => this.current[action] === code); }

  apply(bindings: KeyBindings): void {
    if (!validKeyBindings(bindings)) return;
    this.current = { ...bindings };
    for (const listener of this.listeners) listener();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  matchesPause(event: KeyboardEvent): boolean {
    return event.code === this.current.pause && !event.repeat && !event.isComposing
      && !keyboardEventHasShortcutModifier(event) && !isKeyboardEditingTarget(event.target);
  }

  describe(mode: 'normal' | 'easy'): string {
    const actions = KEY_ACTIONS.filter(action => mode === 'normal' || !['fire', 'accelerate', 'brake'].includes(action));
    return `キーボード：${actions.map(action => `${keyLabel(this.current[action])} ${KEY_LABELS[action]}`).join(' · ')}`;
  }
}
