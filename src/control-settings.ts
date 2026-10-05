import { measureHudObstacles, controlLayoutSize, settingsViewportSize, type ControlObstacle } from './control-obstacles';
// Adapted from faitofuraito@025cad4930b487628675a0e20a88323aae0fac89 src/control-settings.ts. See docs/PROVENANCE.md.
import { persistSettingsBatch, readSettingsValue, hasSettingsRecovery } from './settings-storage';
import type { KaisenControlButtons } from './input';
import { containDialogTabFocus } from './dialog-focus';
import {
  KeyboardSettings, ControlInputPresentation, DEFAULT_KEY_BINDINGS, KEY_ACTIONS, KEY_LABELS, KEYBOARD_STORAGE_KEY,
  captureKey, keyConflict, keyLabel, preferredControlInput, type KeyAction, type KeyBindings,
} from './keyboard-settings';

type ControlName = 'fire' | 'loop' | 'throttle' | 'bomb' | 'torpedo';
type GameMode = 'normal' | 'easy';
export type ControlPlacement = { x: number; y: number; size: number; opacity: number };
type ControlLayout = Record<ControlName, ControlPlacement>;
type ModeLayouts = Record<GameMode, ControlLayout>;
type Insets = { top: number; right: number; bottom: number; left: number };

export const STORAGE_KEYS: Record<GameMode, string> = { normal: 'kaisen-controls-v2', easy: 'kaisen-controls-easy-v2' };
const LEGACY_STORAGE_KEYS: Record<GameMode, string> = { normal: 'kaisen-controls-v1', easy: 'kaisen-controls-easy-v1' };
const MODES: GameMode[] = ['normal', 'easy'];
const CONTROL_NAMES: ControlName[] = ['fire', 'loop', 'throttle', 'bomb', 'torpedo'];
const MODE_CONTROLS: Record<GameMode, ControlName[]> = {
  normal: CONTROL_NAMES,
  easy: ['loop', 'bomb', 'torpedo'],
};
export const DEFAULT_LAYOUT: ControlLayout = {
  fire: { x: 0.83, y: 0.84, size: 96, opacity: 0.9 },
  loop: { x: 0.83, y: 0.66, size: 72, opacity: 0.78 },
  throttle: { x: 0.17, y: 0.75, size: 64, opacity: 0.82 },
  bomb: { x: 0.39, y: 0.94, size: 52, opacity: 0.88 },
  torpedo: { x: 0.59, y: 0.94, size: 52, opacity: 0.88 },
};
const CONTROL_LABELS: Record<ControlName, string> = { fire: '射撃', loop: '宙返り', throttle: '速度レバー', bomb: '爆弾', torpedo: '魚雷' };

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const copyLayout = (layout: ControlLayout): ControlLayout => Object.fromEntries(
  CONTROL_NAMES.map(name => [name, { ...layout[name] }]),
) as ControlLayout;

export function controlDisplaySize(size: number, width: number, height: number): number {
  return width > height ? Math.min(size, Math.max(44, height * .16)) : size;
}

export function previewLabelStyle(diameter: number, characters: number) {
  const outside = diameter < characters * 9 + 6;
  return { outside, fontSize: outside ? 10 : Math.min(13, (diameter - 6) / characters) };
}

export function previewDimensions(width: number, height: number, availableWidth: number, availableHeight: number) {
  const ratio = width > 0 && height > 0 ? width / height : .46;
  const fitWidth = Math.min(Math.max(80, availableWidth), Math.max(80, availableHeight) * ratio);
  return { width: fitWidth, height: fitWidth / ratio };
}

export function controlBounds(size: number, width: number, height: number, insets: Insets, margin = 8): { minX: number; maxX: number; minY: number; maxY: number } {
  const half = size / 2 + margin;
  const minX = clamp((insets.left + half) / Math.max(1, width), 0.02, 0.48);
  const maxX = clamp(1 - (insets.right + half) / Math.max(1, width), 0.52, 0.98);
  const minY = clamp((insets.top + half) / Math.max(1, height), 0.02, 0.48);
  const maxY = clamp(1 - (insets.bottom + half) / Math.max(1, height), 0.52, 0.98);
  return { minX, maxX: Math.max(minX, maxX), minY, maxY: Math.max(minY, maxY) };
}

/** Both editors commit together; failed storage never changes active input. */
export const persistControlSettings = persistSettingsBatch;

function readNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? clamp(value, min, max) : fallback;
}

/** Upgrade only the exact formerly shipped payload default; custom placements remain intact. */
export function migratePayloadDefault(name: ControlName, placement: ControlPlacement): ControlPlacement {
  const oldX = name === 'bomb' ? .39 : name === 'torpedo' ? .58 : null;
  return oldX !== null && placement.x === oldX && placement.y === .72 && placement.size === 56 && placement.opacity === .88
    ? { ...DEFAULT_LAYOUT[name] } : { ...placement };
}

/** Pure read migration. Legacy raw data is never changed. */
export function decodeControlLayout(raw: string | null, legacy = false): ControlLayout {
  const layout = copyLayout(DEFAULT_LAYOUT);
  if (!raw) return layout;
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.version !== (legacy ? 1 : 2) || !parsed.controls || typeof parsed.controls !== 'object') return layout;
    const read = (value: unknown, fallback: ControlPlacement): ControlPlacement => {
      const item = value && typeof value === 'object' ? value as Record<string, unknown> : {};
      return { x: readNumber(item.x, fallback.x, 0, 1), y: readNumber(item.y, fallback.y, 0, 1),
        size: readNumber(item.size, fallback.size, 44, 140), opacity: readNumber(item.opacity, fallback.opacity, .2, 1) };
    };
    for (const name of CONTROL_NAMES) if (parsed.controls[name]) layout[name] = migratePayloadDefault(name, read(parsed.controls[name], layout[name]));
    if (legacy) {
      const valid = ['accelerate', 'brake'].map(name => parsed.controls[name]).filter(item => item && typeof item === 'object' && ['x','y','size','opacity'].every(key => typeof item[key] === 'number' && Number.isFinite(item[key])));
      if (valid.length) {
        const placements = valid.map(item => read(item, layout.throttle));
        for (const key of ['x','y','size','opacity'] as const) layout.throttle[key] = placements.reduce((sum, item) => sum + item[key], 0) / placements.length;
      }
    }
  } catch { /* Corrupt saved input falls back without writing. */ }
  return layout;
}
export function loadLayout(mode: GameMode): ControlLayout {
  try {
    const current = readSettingsValue(STORAGE_KEYS[mode], localStorage);
    return current !== null ? decodeControlLayout(current) : decodeControlLayout(localStorage.getItem(LEGACY_STORAGE_KEYS[mode]), true);
  } catch { return copyLayout(DEFAULT_LAYOUT); }
}

/** Real and preview controls use the same rectangular geometry. */
export function controlDimensions(name: ControlName, size: number, width: number, height: number, insets: Insets = { top: 0, right: 0, bottom: 0, left: 0 }) {
  const display = controlDisplaySize(size, width, height);
  if (name !== 'throttle') return { width: display, height: display };
  return { width: Math.max(44, Math.min(display, width - insets.left - insets.right - 16)),
    height: Math.max(44, Math.min(display * 2, height - insets.top - insets.bottom - 16)) };
}
export function rectangularBounds(control: { width: number; height: number }, width: number, height: number, insets: Insets, margin = 8) {
  const horizontal = controlBounds(control.width, width, height, insets, margin);
  const vertical = controlBounds(control.height, width, height, insets, margin);
  return { minX: horizontal.minX, maxX: horizontal.maxX, minY: vertical.minY, maxY: vertical.maxY };
}
/** Only the lever moves to avoid other controls; saved peers remain untouched. */
export function safeThrottlePlacement(layout: ControlLayout, width: number, height: number, insets: Insets, obstacles: ControlObstacle[] = []): ControlPlacement & { blocked: boolean } {
  const item = layout.throttle;
  const dimensions = controlDimensions('throttle', item.size, width, height, insets);
  const bounds = rectangularBounds(dimensions, width, height, insets);
  const cannotFit = width - insets.left - insets.right < dimensions.width || height - insets.top - insets.bottom < dimensions.height;
  const desired = { x: clamp(item.x, bounds.minX, bounds.maxX), y: clamp(item.y, bounds.minY, bounds.maxY) };
  const peers = CONTROL_NAMES.filter(name => name !== 'throttle').map(name => {
    const p = layout[name], d = controlDimensions(name, p.size, width, height, insets), b = rectangularBounds(d, width, height, insets);
    return { x: clamp(p.x, b.minX, b.maxX) * width, y: clamp(p.y, b.minY, b.maxY) * height, ...d };
  });
  peers.push(...obstacles);
  const clear = (x: number, y: number) => peers.every(peer => Math.abs(x * width - peer.x) >= (dimensions.width + peer.width) / 2 + 2 || Math.abs(y * height - peer.y) >= (dimensions.height + peer.height) / 2 + 2);
  if (!cannotFit && clear(desired.x, desired.y)) return { ...item, ...desired, blocked: false };
  const xs = [desired.x, bounds.minX, bounds.maxX], ys = [desired.y, bounds.minY, bounds.maxY];
  for (const peer of peers) { xs.push((peer.x - (dimensions.width + peer.width) / 2 - 2) / width, (peer.x + (dimensions.width + peer.width) / 2 + 2) / width); ys.push((peer.y - (dimensions.height + peer.height) / 2 - 2) / height, (peer.y + (dimensions.height + peer.height) / 2 + 2) / height); }
  const candidates = xs.flatMap(x => ys.map(y => ({ x: clamp(x, bounds.minX, bounds.maxX), y: clamp(y, bounds.minY, bounds.maxY) })))
    .filter(p => clear(p.x, p.y)).sort((a,b) => Math.hypot((a.x-desired.x)*width,(a.y-desired.y)*height) - Math.hypot((b.x-desired.x)*width,(b.y-desired.y)*height));
  return { ...item, ...(candidates[0] ?? desired), blocked: cannotFit || candidates.length === 0 };
}

/** Edits and persists the flight and payload button layouts without resuming flight. */
export class ControlSettings {
  private readonly app: HTMLElement;
  private readonly dialog: HTMLDialogElement;
  private readonly preview: HTMLElement;
  private readonly select: HTMLSelectElement;
  private readonly modeSelect: HTMLSelectElement;
  private readonly ranges: Record<'x' | 'y' | 'size' | 'opacity', HTMLInputElement>;
  private readonly outputs: Record<'x' | 'y' | 'size' | 'opacity', HTMLElement>;
  private readonly safeProbe: HTMLElement;
  private readonly observer: ResizeObserver;
  private readonly abort = new AbortController();
  private saved: ModeLayouts;
  private draft: ModeLayouts;
  private selected: ControlName = 'fire';
  private layoutMode: GameMode = 'normal';
  private activeMode: GameMode = 'normal';
  private allowedModes: GameMode[] = MODES;
  private returnFocus: HTMLElement | null = null;
  private dragPointer: number | null = null;
  private dragControl: ControlName | null = null;
  private storageUnavailable = false;
  private utilityObstacles: ControlObstacle[] = [];
  private recoveryPending = false;
  private saveFailedAwaitingUse = false;
  private keyDraft: KeyBindings;
  private capturing: KeyAction | null = null;
  private editor: 'touch' | 'keyboard' = 'touch';

  get isOpen(): boolean {
    return this.dialog.open;
  }

  constructor(private readonly buttons: KaisenControlButtons, private readonly keyboard = new KeyboardSettings(), private readonly inputPresentation?: ControlInputPresentation) {
    this.keyDraft = keyboard.bindings;
    this.app = document.getElementById('app') ?? document.body;
    try { this.recoveryPending = hasSettingsRecovery(localStorage); } catch { /* Storage is optional. */ }
    this.saved = { normal: loadLayout('normal'), easy: loadLayout('easy') };
    this.draft = this.copyLayouts(this.saved);
    this.dialog = this.createDialog();
    this.preview = this.dialog.querySelector<HTMLElement>('#control-preview')!;
    this.select = this.dialog.querySelector<HTMLSelectElement>('#control-target')!;
    this.modeSelect = this.dialog.querySelector<HTMLSelectElement>('#control-mode')!;
    this.ranges = {
      x: this.dialog.querySelector<HTMLInputElement>('#control-x')!,
      y: this.dialog.querySelector<HTMLInputElement>('#control-y')!,
      size: this.dialog.querySelector<HTMLInputElement>('#control-size')!,
      opacity: this.dialog.querySelector<HTMLInputElement>('#control-opacity')!,
    };
    this.outputs = {
      x: this.dialog.querySelector<HTMLElement>('#control-x-value')!,
      y: this.dialog.querySelector<HTMLElement>('#control-y-value')!,
      size: this.dialog.querySelector<HTMLElement>('#control-size-value')!,
      opacity: this.dialog.querySelector<HTMLElement>('#control-opacity-value')!,
    };
    this.safeProbe = document.createElement('span');
    this.safeProbe.className = 'control-safe-area-probe';
    this.safeProbe.setAttribute('aria-hidden', 'true');
    this.app.append(this.safeProbe);
    this.bindEvents();
    this.utilityObstacles = measureHudObstacles(this.app);
    this.apply(this.saved[this.activeMode], this.activeMode);
    this.observer = new ResizeObserver(() => this.refreshLayout());
    this.observer.observe(this.app);
    if (document.documentElement && document.documentElement !== this.app) this.observer.observe(document.documentElement);
    window.visualViewport?.addEventListener('resize', this.refreshLayout, { signal: this.abort.signal });
  }

  setActiveMode(mode: GameMode): void {
    this.activeMode = mode;
    this.apply(this.saved[mode], mode);
  }

  open(returnFocus?: HTMLElement, mode: GameMode = this.activeMode, allowBothModes = false): void {
    if (this.dialog.open) return;
    this.returnFocus = returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    this.draft = this.copyLayouts(this.saved);
    this.keyDraft = this.keyboard.bindings;
    this.capturing = null;
    this.saveFailedAwaitingUse = false;
    this.allowedModes = allowBothModes ? [...MODES] : [mode];
    this.layoutMode = this.allowedModes.includes(mode) ? mode : this.allowedModes[0];
    this.modeSelect.value = this.layoutMode;
    this.modeSelect.disabled = this.allowedModes.length === 1;
    for (const option of Array.from(this.modeSelect.options)) {
      option.disabled = !this.allowedModes.includes(option.value as GameMode);
      option.hidden = option.disabled;
    }
    this.selected = MODE_CONTROLS[this.layoutMode][0];
    this.select.value = this.selected;
    this.dialog.querySelector<HTMLButtonElement>('#control-save')!.textContent = '保存する';
    this.setEditor(this.inputPresentation?.value ?? preferredControlInput());
    this.refreshLayout();
    this.dialog.showModal();
    this.refreshLayout();
    this.dialog.querySelector<HTMLElement>('.settings-main')!.scrollTop = 0;
    this.dialog.querySelector<HTMLButtonElement>('#control-close')?.focus({ preventScroll: true });
  }

  close(): void {
    if (this.dialog.open) this.dialog.close('discard');
  }

  dispose(): void {
    this.close();
    this.abort.abort();
    this.observer.disconnect();
    this.safeProbe.remove();
    this.dialog.remove();
  }

  private createDialog(): HTMLDialogElement {
    const dialog = document.createElement('dialog');
    dialog.id = 'control-settings';
    dialog.className = 'control-settings-dialog';
    dialog.setAttribute('aria-labelledby', 'control-settings-title');
    dialog.innerHTML = `
      <div class="settings-shell">
        <header class="settings-header">
          <div><p class="eyebrow">FLIGHT CONTROLS</p><h2 id="control-settings-title">操作設定</h2></div>
          <button id="control-close" class="settings-close" type="button" aria-label="設定を閉じる">×</button>
        </header>
        <div class="settings-input-picker" aria-label="調整する操作方法">
          <button id="control-editor-touch" type="button" aria-pressed="true">タッチ配置</button>
          <button id="control-editor-keyboard" type="button" aria-pressed="false">キーボード</button>
        </div>
        <p class="settings-scroll-hint">下へスクロールしてすべての設定を確認できます</p>
        <div class="settings-main" tabindex="0" role="region" aria-label="操作設定の内容">
        <section id="control-touch-editor" aria-label="タッチ操作の配置">
          <p class="settings-hint">操作を選び、スライダーで調整します。下のプレビューでもドラッグできます。</p>
          <label class="control-select-label" for="control-mode">調整するモード</label>
          <select id="control-mode" class="control-target">
            <option value="normal">ノーマル</option><option value="easy">イージー</option>
          </select>
          <p id="control-mode-note" class="settings-mode-note" role="status"></p>
          <label class="control-select-label" for="control-target">調整する操作</label>
          <select id="control-target" class="control-target">
            <option value="fire">射撃</option><option value="loop">宙返り</option>
            <option value="throttle">速度レバー</option>
            <option value="bomb">爆弾</option><option value="torpedo">魚雷</option>
          </select>
          <div class="control-settings-grid">
            <label class="setting-range" for="control-x"><span>横位置 <b id="control-x-value"></b></span><input id="control-x" type="range" min="5" max="95" step="1" aria-label="横位置"></label>
            <label class="setting-range" for="control-y"><span>縦位置 <b id="control-y-value"></b></span><input id="control-y" type="range" min="5" max="95" step="1" aria-label="縦位置"></label>
            <label class="setting-range" for="control-size"><span>操作の大きさ <b id="control-size-value"></b></span><input id="control-size" type="range" min="44" max="140" step="2" aria-label="操作の大きさ"></label>
            <label class="setting-range" for="control-opacity"><span>不透明度 <b id="control-opacity-value"></b></span><input id="control-opacity" type="range" min="20" max="100" step="1" aria-label="不透明度"></label>
          </div>
          <button id="control-reset" class="control-reset" type="button">このモードの標準配置に戻す</button>
          <p class="settings-hint">配置プレビュー（操作をドラッグして移動）</p>
          <div id="control-preview" class="control-preview" aria-label="操作画面の配置プレビュー"></div>
        </section>
        <section id="control-keyboard-editor" aria-label="キーボードの割り当て" hidden>
          <p class="settings-hint">変更したい操作を選んで、使うキーを1つ押してください。左右のShift・テンキーも区別します。両モード共通です。</p>
          <p class="settings-hint">Escは入力の取り消し、Tabは画面の移動に使います。Ctrl・Alt・⌘の組み合わせやブラウザ専用キーは登録できません。</p>
          <div class="keyboard-settings-list">${KEY_ACTIONS.map(action => `<div class="keyboard-setting-row"><span>${KEY_LABELS[action]}${['fire', 'accelerate', 'brake'].includes(action) ? '<small>ノーマルのみ</small>' : ''}</span><button type="button" data-key-action="${action}"></button></div>`).join('')}</div>
          <p id="keyboard-capture-note" class="settings-keyboard-note" role="status" aria-live="polite"></p>
          <button id="keyboard-capture-cancel" class="control-reset" type="button" hidden>キー入力を取り消す</button>
          <button id="keyboard-reset" class="control-reset" type="button">キーを標準に戻す（停止はEsc）</button>
        </section>
          <p id="control-storage-note" class="settings-storage-note" role="status" hidden>このブラウザでは設定を保存できないため、今回の表示中だけ有効です。</p>
        </div>
        <footer class="settings-footer">
          <button id="control-cancel" class="secondary" type="button">変更を破棄</button>
          <button id="control-save" class="primary" type="button">保存する</button>
        </footer>
      </div>`;
    this.app.append(dialog);
    return dialog;
  }

  private bindEvents(): void {
    const signal = this.abort.signal;
    this.dialog.querySelector('#control-close')?.addEventListener('click', () => this.close(), { signal });
    this.dialog.querySelector('#control-cancel')?.addEventListener('click', () => this.close(), { signal });
    this.dialog.querySelector('#control-save')?.addEventListener('click', () => this.save(), { signal });
    this.dialog.querySelector('#control-reset')?.addEventListener('click', () => {
      this.draft[this.layoutMode] = copyLayout(DEFAULT_LAYOUT);
      this.selected = MODE_CONTROLS[this.layoutMode][0];
      this.select.value = this.selected;
      this.updateEditor();
    }, { signal });
    for (const editor of ['touch', 'keyboard'] as const) {
      this.dialog.querySelector(`#control-editor-${editor}`)?.addEventListener('click', () => this.setEditor(editor), { signal });
    }
    for (const action of KEY_ACTIONS) {
      const button = this.dialog.querySelector<HTMLButtonElement>(`[data-key-action="${action}"]`)!;
      button.addEventListener('click', () => {
        this.capturing = action;
        this.renderKeys(`${KEY_LABELS[action]}に使うキーを押してください。Escで取り消します。`);
      }, { signal });
      button.addEventListener('blur', () => { if (this.capturing === action) this.cancelKeyCapture(); }, { signal });
    }
    this.dialog.querySelector('#keyboard-capture-cancel')?.addEventListener('click', () => this.cancelKeyCapture(), { signal });
    this.dialog.querySelector('#keyboard-reset')?.addEventListener('click', () => {
      this.capturing = null;
      this.keyDraft = { ...DEFAULT_KEY_BINDINGS };
      this.renderKeys('標準のキーに戻しました。「保存する」で適用します。');
    }, { signal });
    this.dialog.addEventListener('keydown', event => {
      this.captureKeyboard(event);
      containDialogTabFocus(this.dialog, event);
    }, { signal, capture: true });
    window.addEventListener('blur', () => { this.cancelKeyCapture(); this.releaseDrag(); }, { signal });
    document.addEventListener('visibilitychange', () => { if (document.hidden) { this.cancelKeyCapture(); this.releaseDrag(); } }, { signal });
    this.dialog.addEventListener('cancel', event => {
      event.preventDefault();
      if (this.capturing) this.cancelKeyCapture();
      else this.close();
    }, { signal });
    this.dialog.addEventListener('close', () => this.onClosed(), { signal });
    this.select.addEventListener('change', () => {
      const requested = this.select.value as ControlName;
      this.selected = MODE_CONTROLS[this.layoutMode].includes(requested) ? requested : MODE_CONTROLS[this.layoutMode][0];
      this.select.value = this.selected;
      this.updateEditor();
    }, { signal });
    this.modeSelect.addEventListener('change', () => this.setLayoutMode(this.modeSelect.value as GameMode), { signal });
    for (const property of ['x', 'y', 'size', 'opacity'] as const) {
      this.ranges[property].addEventListener('input', () => this.changeValue(property), { signal });
    }
    this.preview.addEventListener('pointerdown', event => this.startDrag(event), { signal });
    window.addEventListener('pointermove', event => this.drag(event), { signal });
    window.addEventListener('pointerup', event => this.endDrag(event), { signal });
    window.addEventListener('pointercancel', event => this.endDrag(event), { signal });
    this.preview.addEventListener('lostpointercapture', event => this.endDrag(event), { signal });
  }

  private save(): void {
    if (this.capturing) this.cancelKeyCapture();
    const rect = this.app ? controlLayoutSize(this.app) : null;
    if (this.app) this.utilityObstacles = measureHudObstacles(this.app);
    if (rect && this.allowedModes.includes('normal') && safeThrottlePlacement(this.draft.normal, rect.width, rect.height, this.readInsets(), this.utilityObstacles).blocked) {
      const note = this.dialog.querySelector<HTMLElement>('#control-storage-note')!;
      note.hidden = false; note.textContent = '速度レバーの配置が重なっています。大きさや位置を調整してから保存してください。';
      note.scrollIntoView({ block: 'nearest' }); return;
    }
    if (this.saveFailedAwaitingUse) {
      for (const mode of this.allowedModes) this.saved[mode] = copyLayout(this.draft[mode]);
      this.keyboard.apply(this.keyDraft);
      this.apply(this.saved[this.activeMode], this.activeMode);
      this.dialog.close('session-only');
      return;
    }
    const next = this.copyLayouts(this.saved);
    const changedModes = this.allowedModes.filter(mode => JSON.stringify(this.draft[mode]) !== JSON.stringify(this.saved[mode]));
    for (const mode of changedModes) next[mode] = copyLayout(this.draft[mode]);
    const keysChanged = KEY_ACTIONS.some(action => this.keyDraft[action] !== this.keyboard.code(action));
    if (changedModes.length === 0 && !keysChanged && !this.recoveryPending) {
      this.dialog.close('save');
      return;
    }
    const entries: Array<{ key: string; value: string; maxVersion?: number; legacyKey?: string }> = changedModes.map(mode => ({ key: STORAGE_KEYS[mode], value: JSON.stringify({ version: 2, controls: next[mode] }), maxVersion: 2, legacyKey: LEGACY_STORAGE_KEYS[mode] }));
    if (keysChanged) entries.push({ key: KEYBOARD_STORAGE_KEY, value: JSON.stringify({ version: 1, bindings: this.keyDraft }) });
    let persisted = false;
    try {
      persisted = persistControlSettings(entries, localStorage);
    } catch { /* Accessing localStorage itself may throw. */ }
    if (persisted) {
      this.storageUnavailable = false;
      this.recoveryPending = false;
      this.saved = next;
      this.keyboard.apply(this.keyDraft);
      this.apply(this.saved[this.activeMode], this.activeMode);
    } else {
      this.storageUnavailable = true;
      this.saveFailedAwaitingUse = true;
      this.dialog.querySelector<HTMLElement>('#control-storage-note')!.textContent = '設定を保存できませんでした。以前の設定で続けます。「今回だけ使う」で、ページを閉じるまで適用します。';
      this.dialog.querySelector<HTMLButtonElement>('#control-save')!.textContent = '今回だけ使う';
      this.dialog.querySelector<HTMLElement>('#control-storage-note')!.hidden = false;
      this.dialog.querySelector<HTMLElement>('#control-storage-note')!.scrollIntoView({ block: 'nearest' });
      return;
    }
    this.dialog.close('save');
  }

  private onClosed(): void {
    this.draft = this.copyLayouts(this.saved);
    this.keyDraft = this.keyboard.bindings;
    this.capturing = null;
    this.releaseDrag();
    this.saveFailedAwaitingUse = false;
    this.updateEditor();
    this.renderKeys();
    const returnFocus = this.returnFocus;
    this.returnFocus = null;
    if (returnFocus?.isConnected && !returnFocus.closest('[hidden]')) {
      requestAnimationFrame(() => {
        if (returnFocus.isConnected && !returnFocus.closest('[hidden]')) returnFocus.focus({ preventScroll: true });
      });
    }
  }

  private setEditor(editor: 'touch' | 'keyboard'): void {
    this.cancelKeyCapture();
    this.releaseDrag();
    this.editor = editor;
    this.dialog.querySelector<HTMLElement>('#control-touch-editor')!.hidden = editor !== 'touch';
    this.dialog.querySelector<HTMLElement>('#control-keyboard-editor')!.hidden = editor !== 'keyboard';
    this.dialog.querySelector<HTMLElement>('#control-settings-title')!.textContent = editor === 'touch' ? 'タッチ操作の配置' : 'キーボードの設定';
    for (const name of ['touch', 'keyboard']) this.dialog.querySelector(`#control-editor-${name}`)!.setAttribute('aria-pressed', String(name === editor));
    this.dialog.querySelector<HTMLElement>('.settings-main')!.scrollTop = 0;
    this.renderKeys();
    this.refreshLayout();
  }

  private renderKeys(message = ''): void {
    for (const action of KEY_ACTIONS) {
      const button = this.dialog.querySelector<HTMLButtonElement>(`[data-key-action="${action}"]`)!;
      button.textContent = this.capturing === action ? 'キーを押す…' : keyLabel(this.keyDraft[action]);
      button.setAttribute('aria-label', `${KEY_LABELS[action]}：${keyLabel(this.keyDraft[action])}。変更する`);
      button.setAttribute('aria-pressed', String(this.capturing === action));
    }
    this.dialog.querySelector<HTMLElement>('#keyboard-capture-note')!.textContent = message;
    this.dialog.querySelector<HTMLElement>('#keyboard-capture-cancel')!.hidden = !this.capturing;
  }

  private cancelKeyCapture(): void {
    if (!this.capturing) return;
    this.capturing = null;
    this.renderKeys('キーの変更を取り消しました。');
  }

  private captureKeyboard(event: KeyboardEvent): void {
    if (!this.capturing || this.editor !== 'keyboard') return;
    // Tab retains native focus traversal; blur cancels the pending capture.
    if (event.code === 'Tab') { this.cancelKeyCapture(); return; }
    event.preventDefault();
    event.stopPropagation();
    const result = captureKey(event);
    if (result.kind === 'ignore') return;
    if (result.kind === 'cancel') { this.cancelKeyCapture(); return; }
    if (result.kind === 'error') { this.renderKeys(result.message); return; }
    const conflict = keyConflict(this.keyDraft, this.capturing, result.code);
    if (conflict) {
      this.renderKeys(`${keyLabel(result.code)}は「${KEY_LABELS[conflict]}」で使用中です。別のキーを押してください。`);
      return;
    }
    const action = this.capturing;
    this.keyDraft[action] = result.code;
    this.capturing = null;
    this.renderKeys(`${KEY_LABELS[action]}を${keyLabel(result.code)}に変更しました。「保存する」で適用します。`);
  }

  private releaseDrag(): void {
    const pointer = this.dragPointer, control = this.dragControl;
    this.dragPointer = null;
    this.dragControl = null;
    if (pointer === null || !control) return;
    const element = this.preview.querySelector<HTMLElement>(`[data-control="${control}"]`);
    try { if (element?.hasPointerCapture(pointer)) element.releasePointerCapture(pointer); } catch { /* Already released. */ }
  }

  private changeValue(property: 'x' | 'y' | 'size' | 'opacity'): void {
    const value = Number(this.ranges[property].value);
    if (property === 'x' || property === 'y') this.draft[this.layoutMode][this.selected][property] = value / 100;
    else this.draft[this.layoutMode][this.selected][property] = property === 'opacity' ? value / 100 : value;
    this.updateEditor();
  }

  private setLayoutMode(mode: GameMode): void {
    if (!MODES.includes(mode) || !this.allowedModes.includes(mode)) {
      this.modeSelect.value = this.layoutMode;
      return;
    }
    this.layoutMode = mode;
    this.selected = MODE_CONTROLS[mode][0];
    this.select.value = this.selected;
    this.updateEditor();
  }

  private startDrag(event: PointerEvent): void {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('.preview-control') : null;
    const name = target?.dataset.control as ControlName | undefined;
    if (this.dragPointer !== null || !target || !name || !MODE_CONTROLS[this.layoutMode].includes(name) || (event.pointerType === 'mouse' && event.button !== 0)) return;
    event.preventDefault();
    this.selected = name;
    this.select.value = name;
    this.dragPointer = event.pointerId;
    this.dragControl = name;
    try { target.setPointerCapture(event.pointerId); } catch { /* The pointer can end before capture is established. */ }
    this.updateEditor();
    this.setFromPreviewPointer(event);
  }

  private drag(event: PointerEvent): void {
    if (event.pointerId !== this.dragPointer) return;
    if (event.pointerType === 'mouse' && event.buttons === 0) { this.releaseDrag(); return; }
    event.preventDefault();
    this.setFromPreviewPointer(event);
  }

  private endDrag(event: PointerEvent): void {
    if (event.pointerId !== this.dragPointer) return;
    this.releaseDrag();
  }

  private setFromPreviewPointer(event: PointerEvent): void {
    if (!this.dragControl) return;
    const rect = this.preview.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const appWidth = controlLayoutSize(this.app).width || 1;
    const previewSize = controlLayoutSize(this.preview);
    const position = this.bounds(this.dragControl, previewSize.width, previewSize.height, previewSize.width / appWidth, 2);
    this.draft[this.layoutMode][this.dragControl].x = clamp((event.clientX - rect.left) / rect.width, position.minX, position.maxX);
    this.draft[this.layoutMode][this.dragControl].y = clamp((event.clientY - rect.top) / rect.height, position.minY, position.maxY);
    this.updateEditor();
  }

  private updateEditor(): void {
    if (!this.dialog.isConnected) return;
    this.buildPreviewButtons();
    const rect = controlLayoutSize(this.app);
    const current = this.draft[this.layoutMode][this.selected];
    const bounds = this.bounds(this.selected, rect.width || 1, rect.height || 1, 1, 8, current.size);
    const x = clamp(current.x, bounds.minX, bounds.maxX);
    const y = clamp(current.y, bounds.minY, bounds.maxY);
    this.ranges.x.min = String(Math.ceil(bounds.minX * 100));
    this.ranges.x.max = String(Math.floor(bounds.maxX * 100));
    this.ranges.y.min = String(Math.ceil(bounds.minY * 100));
    this.ranges.y.max = String(Math.floor(bounds.maxY * 100));
    this.ranges.x.value = String(Math.round(x * 100));
    this.ranges.y.value = String(Math.round(y * 100));
    this.ranges.size.value = String(Math.round(current.size));
    this.ranges.opacity.value = String(Math.round(current.opacity * 100));
    this.outputs.x.textContent = `${Math.round(x * 100)}%`;
    this.outputs.y.textContent = `${Math.round(y * 100)}%`;
    this.outputs.size.textContent = `${Math.round(current.size)}px`;
    this.outputs.opacity.textContent = `${Math.round(current.opacity * 100)}%`;
    this.dialog.querySelector<HTMLElement>('#control-mode-note')!.textContent = this.layoutMode === 'normal'
      ? 'ノーマル：手動射撃。味方への誤射で減点します。弾切れで6秒再装填。'
      : 'イージー：照準補助と自動射撃。宙返り・爆弾・魚雷を調整できます。';
    this.select.disabled = MODE_CONTROLS[this.layoutMode].length === 1;
    for (const option of Array.from(this.select.options)) {
      option.disabled = !MODE_CONTROLS[this.layoutMode].includes(option.value as ControlName);
      option.hidden = option.disabled;
    }
    const storageNote = this.dialog.querySelector<HTMLElement>('#control-storage-note')!;
    const conflict = this.layoutMode === 'normal' && safeThrottlePlacement(this.draft.normal, rect.width, rect.height, this.readInsets(), this.utilityObstacles).blocked;
    storageNote.hidden = !this.storageUnavailable && !this.recoveryPending && !conflict;
    if (conflict) storageNote.textContent = '速度レバーを配置できません。大きさや位置を調整してください。';
    else if (this.recoveryPending) storageNote.textContent = '前回の設定保存を復元する必要があります。控えの設定で表示しています。保存するで復元を再試行できます。';
    if (this.storageUnavailable && !this.saveFailedAwaitingUse && !this.recoveryPending && !conflict) {
      storageNote.textContent = 'このブラウザでは保存できません。今回だけ使う設定は、ページを閉じるまで有効です。';
    }
    this.stylePreviewButtons();
  }

  private buildPreviewButtons(): void {
    if (this.preview.childElementCount === CONTROL_NAMES.length) return;
    this.preview.replaceChildren();
    for (const name of CONTROL_NAMES) {
      const clone = document.createElement('button');
      clone.type = 'button';
      const label = document.createElement('span'); label.textContent = CONTROL_LABELS[name]; clone.append(label);
      clone.dataset.control = name;
      clone.classList.add('preview-control');
      if (name === 'throttle') { clone.classList.add('preview-throttle'); const handle = document.createElement('i'); clone.append(handle); }
      clone.setAttribute('aria-hidden', 'true');
      clone.tabIndex = -1;
      this.preview.append(clone);
    }
  }

  private stylePreviewButtons(): void {
    const appRect = controlLayoutSize(this.app);
    const previewRect = controlLayoutSize(this.preview);
    if (!appRect.width || !previewRect.width) return;
    const scale = previewRect.width / appRect.width;
    for (const name of CONTROL_NAMES) {
      const control = name === 'throttle' ? safeThrottlePlacement(this.draft[this.layoutMode], appRect.width, appRect.height, this.readInsets(), this.utilityObstacles) : this.draft[this.layoutMode][name];
      const element = this.preview.querySelector<HTMLElement>(`.preview-control[data-control="${name}"]`);
      if (!element) continue;
      element.hidden = !MODE_CONTROLS[this.layoutMode].includes(name);
      const position = this.bounds(name, previewRect.width, previewRect.height, scale, 8 * scale, control.size);
      if (name === 'throttle') {
        const blocked = 'blocked' in control && control.blocked === true;
        element.setAttribute('aria-disabled', String(blocked));
        element.classList.toggle('layout-blocked', blocked);

      }
      element.style.setProperty('--control-x', `${clamp(control.x, position.minX, position.maxX) * 100}%`);
      element.style.setProperty('--control-y', `${clamp(control.y, position.minY, position.maxY) * 100}%`);
      const dimensions = controlDimensions(name, control.size, appRect.width, appRect.height, this.readInsets());
      const diameter = dimensions.width * scale;
      element.style.setProperty('--control-height', `${dimensions.height * scale}px`);
      const labelStyle = previewLabelStyle(diameter, CONTROL_LABELS[name].length);
      element.style.setProperty('--control-size', `${diameter}px`);
      element.style.setProperty('--preview-font-size', `${labelStyle.fontSize}px`);
      element.classList.toggle('external-label', labelStyle.outside);
      element.dataset.labelAlign = control.x < .25 ? 'left' : control.x > .75 ? 'right' : 'center';
      element.dataset.labelVertical = control.y < .25 ? 'below' : 'above';
      element.style.setProperty('--control-opacity', String(control.opacity));
      element.classList.toggle('is-selected', this.selected === name);
    }
  }

  private apply(layout: ControlLayout, mode: GameMode): void {
    const rect = controlLayoutSize(this.app);
    if (!rect.width || !rect.height) return;
    for (const name of CONTROL_NAMES) {
      const control = name === 'throttle' ? safeThrottlePlacement(layout, rect.width, rect.height, this.readInsets(), this.utilityObstacles) : layout[name];
      const position = this.bounds(name, rect.width, rect.height, 1, 8, control.size);
      const element = this.buttons[name]!;
      if (name === 'throttle') {
        const blocked = 'blocked' in control && control.blocked === true;
        element.setAttribute('aria-disabled', String(blocked));
        element.classList.toggle('layout-blocked', blocked);
        if (element.id === 'throttle') {
          element.tabIndex = blocked ? -1 : 0;
          const notice = document.getElementById('throttle-layout-note');
          if (notice) notice.hidden = !blocked || this.activeMode !== 'normal';
        }
      }
      element.style.setProperty('--control-x', `${clamp(control.x, position.minX, position.maxX) * 100}%`);
      element.style.setProperty('--control-y', `${clamp(control.y, position.minY, position.maxY) * 100}%`);
      const dimensions = controlDimensions(name, control.size, rect.width, rect.height, this.readInsets());
      element.style.setProperty('--control-size', `${dimensions.width}px`);
      element.style.setProperty('--control-height', `${dimensions.height}px`);
      element.style.setProperty('--control-opacity', String(control.opacity));
    }
  }

  private bounds(name: ControlName, width: number, height: number, scale: number, margin: number, buttonSize = this.draft[this.layoutMode][name].size): { minX: number; maxX: number; minY: number; maxY: number } {
    const insets = this.readInsets();
    const rect = controlLayoutSize(this.app);
    const dimensions = controlDimensions(name, buttonSize, rect.width, rect.height, insets);
    return rectangularBounds({ width: dimensions.width * scale, height: dimensions.height * scale }, width, height, { top: insets.top * scale, right: insets.right * scale, bottom: insets.bottom * scale, left: insets.left * scale }, margin);
  }

  private displaySize(size: number): number {
    const rect = controlLayoutSize(this.app);
    return controlDisplaySize(size, rect.width, rect.height);
  }

  private readInsets(): Insets {
    const style = getComputedStyle(this.safeProbe);
    return {
      top: parseFloat(style.paddingTop) || 0,
      right: parseFloat(style.paddingRight) || 0,
      bottom: parseFloat(style.paddingBottom) || 0,
      left: parseFloat(style.paddingLeft) || 0,
    };
  }

  private copyLayouts(layouts: ModeLayouts): ModeLayouts {
    return { normal: copyLayout(layouts.normal), easy: copyLayout(layouts.easy) };
  }

  private refreshLayout = (): void => {
    this.utilityObstacles = measureHudObstacles(this.app);
    this.apply(this.saved[this.activeMode], this.activeMode);
    const viewport = settingsViewportSize(this.app, window.visualViewport?.width ?? window.innerWidth, window.visualViewport?.height ?? window.innerHeight);
    this.dialog?.style.setProperty('--settings-viewport-width', `${viewport.width}px`);
    this.dialog?.style.setProperty('--settings-viewport-height', `${viewport.height}px`);
    if (!this.dialog?.open) return;
    this.releaseDrag();
    const appRect = controlLayoutSize(this.app);
    const availableWidth = Math.max(80, this.dialog.clientWidth - 48);
    const scrollRegion = this.dialog.querySelector<HTMLElement>('.settings-main')!;
    const preview = previewDimensions(appRect.width, appRect.height, availableWidth, scrollRegion.clientHeight - 24);
    this.preview.style.width = `${preview.width}px`;
    this.preview.style.height = `${preview.height}px`;
    this.updateEditor();
  };
}
