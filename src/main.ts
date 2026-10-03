import "./style.css";
import {
  createGame,
  startGame,
  pauseGame,
  resumeGame,
  stepGame,
} from "./simulation";
import { FIXED_DT, LOW_ALTITUDE_WARNING } from "./mission";
import { FlightControls } from "./input";
import { ControlSettings } from "./control-settings";
import { AllyAnnouncements } from "./ally-announcements";
import { checkTorpedoRelease } from "./ordnance";
import { KaisenScene } from "./scene";
import { FlightAudio } from "./audio";
import type { GameEvent, GameMode, GameState } from "./types";

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing UI: ${id}`);
  return node as T;
}
const app = el("app"),
  canvas = el<HTMLCanvasElement>("flight"),
  overlay = el<HTMLCanvasElement>("markers");
let selectedMode: GameMode = "easy";
let state = createGame(undefined, selectedMode);
let screen: "home" | "playing" | "paused" | "result" = "home";
let scene: KaisenScene | null = null;
let graphicsReady = false;
let contextLost = false;
const audio = new FlightAudio();
audio.enabled = false;
const allyAnnouncements = new AllyAnnouncements();
const buttons = {
    fire: el<HTMLButtonElement>("fire"),
    loop: el<HTMLButtonElement>("loop"),
    accelerate: el<HTMLButtonElement>("accelerate"),
    brake: el<HTMLButtonElement>("brake"),
    bomb: el<HTMLButtonElement>("bomb"),
    torpedo: el<HTMLButtonElement>("torpedo"),
};
for (const button of Object.values(buttons)) button.dataset.flightControl = "true";
const settings = new ControlSettings(buttons);
const controls = new FlightControls(canvas, buttons, () => screen === "playing" && state.phase === "playing" && !settings.isOpen);
controls.setMode(selectedMode);
function modeName(mode: GameMode): string { return mode === "easy" ? "イージー" : "ノーマル"; }
function syncMode() {
  app.dataset.mode = state.mode;
  controls.setMode(state.mode);
  settings.setActiveMode(state.mode);
  el("normal-controls").hidden = state.mode !== "normal";
  el("friendly-fire-guide").hidden = state.mode !== "normal";
  el("hud-mode").textContent = modeName(state.mode);
  el("result-mode").textContent = modeName(state.mode);
  el("flight-tip").textContent = state.mode === "normal"
    ? "ドラッグで操縦"
    : "触れた位置からドラッグして操縦";
  el("mode-guide").textContent = state.mode === "easy"
    ? "照準円内・1.2km以内へ自動射撃 · 右下で宙返り"
    : "照準補助なし・手動射撃 · 加速・減速・宙返りをボタンで操作";
  el("keyboard-guide").textContent = state.mode === "easy"
    ? "キーボード：矢印で操縦 · L宙返り · Z爆弾 · X魚雷"
    : "キーボード：矢印で操縦 · Space射撃 · W/S加減速 · L宙返り · Z爆弾 · X魚雷";
}
syncMode();
for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="game-mode"]')) {
  radio.addEventListener("change", () => {
    if (screen !== "home" || !radio.checked) return;
    selectedMode = radio.value === "normal" ? "normal" : "easy";
    state = createGame(undefined, selectedMode);
    syncMode();
    scene?.render(state, false);
  });
}
const pauseReasons = new Set<string>();
let accumulator = 0,
  lastFrame = 0,
  frameId = 0,
  disposed = false,
  generation = 0,
  announcementUntil = 0;
let announcementPriority = 0;
let pendingLoop = false, pendingBomb = false, pendingTorpedo = false;
let lastArmorHintAt = -10;
let lastFrameGap = 0;
let lastInterruption: { reason: string; gap: number; render: unknown } | null = null;
let renderStatus: "ready" | "pending" | "stalled" | "failed" = "ready";
let frameIntervals: number[] = [];
let updateTimes: number[] = [];

for (const [id, allowBoth] of [["home-controls", true], ["pause-controls", false], ["result-controls", true]] as const) {
  const button = el<HTMLButtonElement>(id);
  button.addEventListener("click", () => {
    controls.clear();
    settings.open(button, screen === "home" ? selectedMode : state.mode, allowBoth);
  });
}

function formatTime(seconds: number) {
  const cs = Math.floor(Math.max(0, seconds) * 100 + 1e-6);
  return `${String(Math.floor(cs / 6000)).padStart(2, "0")}:${String(Math.floor(cs / 100) % 60).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}
function setScreen(next: typeof screen) {
  settings.close();
  screen = next;
  app.dataset.screen = next;
  el("home").hidden = next !== "home";
  el("hud").hidden = next !== "playing" && next !== "paused";
  el("pause-screen").hidden = next !== "paused";
  el("result").hidden = next !== "result";
  controls.clear();
  const focus =
    next === "home"
      ? "start"
      : next === "paused"
        ? "resume"
        : next === "result"
          ? "retry"
          : null;
  if (focus) el<HTMLButtonElement>(focus).focus({ preventScroll: true });
  else if (next === "playing") canvas.focus({ preventScroll: true });
}
function announce(text: string, duration = 3, priority = 0) {
  if (state.elapsed < announcementUntil && priority < announcementPriority) return;
  announcementPriority = priority;
  el("announcement").textContent = text;
  announcementUntil = state.elapsed + duration;
}
function syncAudio() {
  audio.active =
    state.phase === "playing" && screen === "playing" && !document.hidden;
  audio.sync();
  el("home-sound").textContent = audio.enabled
    ? "音をオフにする"
    : "音をオンにする";
  el("game-sound").textContent = audio.enabled ? "音 ON" : "音 OFF";
  el("game-sound").setAttribute(
    "aria-label",
    audio.enabled ? "音をオフにする" : "音をオンにする",
  );
  for (const id of ["home-sound", "game-sound"])
    el(id).setAttribute("aria-pressed", String(audio.enabled));
}
async function toggleAudio() {
  audio.enabled = !audio.enabled;
  syncAudio();
  if (audio.enabled) {
    await audio.unlock();
    syncAudio();
    if (audio.failed) announce("音を再生できません。飛行は続けられます");
  }
}
for (const id of ["home-sound", "game-sound"])
  el(id).addEventListener("click", () => void toggleAudio());
function begin() {
  if (
    !scene ||
    !graphicsReady ||
    contextLost ||
    document.hidden ||
    screen === "playing" || settings.isOpen
  )
    return;
  generation++;
  announcementUntil = 0; announcementPriority = 0;
  allyAnnouncements.clear();
  el("ally-announcements").textContent = "";
  pendingLoop = false; pendingBomb = false; pendingTorpedo = false;
  audio.resetFlight();
  lastArmorHintAt = -10;
  controls.clear();
  pauseReasons.clear();
  state = createGame(undefined, selectedMode);
  syncMode();
  startGame(state);
  accumulator = 0;
  lastFrame = 0;
  frameIntervals = [];
  updateTimes = [];
  setScreen("playing");
  syncAudio();
  void audio.unlock().then(() => syncAudio());
  announce("敵機5機と艦隊4隻をすべて撃破", 4);
  scene.render(state, true);
  // Initial resource upload is preparation, not elapsed mission time.
  lastFrame = 0;
  updateHUD();
}
function home() {
  allyAnnouncements.clear();
  el("ally-announcements").textContent = "";
  pendingLoop = false; pendingBomb = false; pendingTorpedo = false;
  generation++;
  audio.resetFlight();
  state = createGame(undefined, selectedMode);
  syncMode();
  pauseReasons.clear();
  accumulator = 0;
  setScreen("home");
  el("announcement").textContent = "";
  syncAudio();
  scene?.render(state, false);
}
function pause(reason: string) {
  if (state.phase !== "playing" && state.phase !== "paused") return;
  pendingLoop = false; pendingBomb = false; pendingTorpedo = false;
  pauseReasons.add(reason);
  pauseGame(state);
  accumulator = 0;
  if (screen !== "paused") setScreen("paused");
  el("pause-reason").textContent = contextLost
    ? "描画が中断されました。復帰を待っています"
    : reason === "render-failed"
      ? "描画を続けられません。再読み込みしてお試しください"
    : reason === "render"
      ? "描画の完了を待っています。復帰後に再開できます"
    : reason === "frame"
      ? "画面の更新が中断されたため停止しました"
      : "タイムの計測も止まっています";
  el<HTMLButtonElement>("resume").disabled = contextLost || renderStatus === "stalled" || renderStatus === "failed";
  el("pause-reload").hidden = renderStatus !== "failed";
  syncAudio();
}
function resume() {
  if (settings.isOpen || document.hidden || contextLost || state.phase !== "paused" || renderStatus === "stalled" || renderStatus === "failed") return;
  pauseReasons.clear();
  resumeGame(state);
  accumulator = 0;
  lastFrame = 0;
  setScreen("playing");
  syncAudio();
  void audio.unlock().then(() => syncAudio());
}
function finish() {
  if (!state.result) return;
  controls.clear();
  audio.finishFlight();
  setScreen("result");
  el("announcement").textContent = "";
  const r = state.result;
  el("result-title").textContent =
    r.outcome === "victory" ? "作戦成功" : "作戦終了";
  el("result-kicker").textContent =
    r.outcome === "victory" ? "ALL TARGETS DESTROYED" : "MISSION REPORT";
  const causes = {
    'sea': '海面に機体が接触しました',
    'ship-collision': '戦艦の船体・構造物に衝突しました',
    'ship-wreck-collision': '沈没中の艦の残骸に衝突しました',
    'aircraft-collision': '敵航空機と衝突しました',
    'naval-fire': '艦隊の対空砲撃で撃墜されました',
    'enemy-aircraft': '敵航空機の射撃で撃墜されました',
  };
  el("result-reason").textContent = r.outcome === "victory"
    ? "敵航空隊と敵艦隊を全滅させました"
    : state.deathCause ? causes[state.deathCause] : "自機が撃墜されました";
  el("result-score").textContent = String(Math.round(r.score));
  el("friendly-fire-result").textContent = `誤射 ${r.friendlyDamage.toFixed(1)} HP · 味方撃墜 ${r.friendlyKills}機`;
  el("result-time-label").textContent =
    r.outcome === "victory" ? "クリアタイム" : "経過時間";
  el("result-time").textContent = formatTime(r.time);
  el("player-kills").textContent =
    `${r.playerAircraftKills}機 · ${r.playerShipKills}隻`;
  el("ally-kills").textContent =
    `${r.allyAircraftKills}機 · ${r.allyShipKills}隻`;
  el("survivors").textContent = `${r.alliesSurvived}機`;
  const allySummary = allyAnnouncements.summary();
  el("ally-report").hidden = allySummary.length === 0;
  el("ally-report-lines").textContent = allySummary.join("\n");
}
function updateHUD() {
  el("timer").textContent = formatTime(state.elapsed);
  el("score").textContent = String(Math.round(state.stats.score));
  el("enemy-count").textContent = String(
    state.enemies.filter((p) => p.health > 0).length,
  );
  el("enemy-total").textContent = `/ ${state.enemies.length}`;
  el("bomb").textContent = state.player.bombReloadTicks > 0 ? `爆弾 ${(state.player.bombReloadTicks / 60).toFixed(1)}s` : `爆弾 ${state.player.bombs}`;
  el("torpedo").textContent = state.player.torpedoReloadTicks > 0 ? `魚雷 ${(state.player.torpedoReloadTicks / 60).toFixed(1)}s` : `魚雷 ${state.player.torpedoes}`;
  const torpedoCheck = checkTorpedoRelease(state.player, state.elapsed);
  el("torpedo").dataset.ready = String(torpedoCheck.allowed && state.player.torpedoReloadTicks === 0);
  el("payload-status").textContent = torpedoCheck.allowed ? "魚雷投下可能" : "";
  el("mg-ammo").textContent = String(state.player.mg);
  el("cannon-ammo").textContent = String(state.player.cannon);
  const reloading = state.player.reloadTicksRemaining > 0;
  el("reload-status").hidden = !reloading;
  el("reload-status").textContent = reloading ? `再装填中 あと${(state.player.reloadTicksRemaining / 60).toFixed(1)}秒` : "";
  el("reload-status").dataset.progress = String(1 - state.player.reloadTicksRemaining / 360);
  positionReloadStatus();
  el("ship-count").textContent = String(
    state.ships.filter((s) => s.health > 0).length,
  );
  el("allies-count").textContent = String(
    state.allies.filter((p) => p.health > 0).length,
  );
  const healthPercent = Math.max(0, Math.min(100, state.player.health / state.player.maxHealth * 100));
  el("health").textContent = String(Math.ceil(healthPercent));
  el("health-bar").style.width = `${healthPercent}%`;
  el("altitude").textContent = `${Math.round(state.player.position.y)}m`;
  el("speed").textContent = `${Math.round(state.player.speed * 3.6)}km/h`;
  el("warning").hidden =
    state.player.position.y >= LOW_ALTITUDE_WARNING ||
    state.phase !== "playing";
  el("loop-status").textContent =
    state.player.loopProgress > 0
      ? "旋回中"
      : state.player.loopCooldown > 0
        ? `${state.player.loopCooldown.toFixed(1)}秒`
        : "すぐ使える";
  el("flight-tip").hidden = state.elapsed > 8;
  if (state.elapsed > announcementUntil) el("announcement").textContent = "";
  const allyText = allyAnnouncements.update(state.elapsed).join("\n");
  if (el("ally-announcements").textContent !== allyText) el("ally-announcements").textContent = allyText;
}
function positionReloadStatus() {
  if (state.mode === "normal" && scene) {
    const sight = scene.gunSight(state);
    el("reload-status").style.top = `${sight.y + 52}px`;
    el("reload-status").style.left = `${sight.x}px`;
  } else {
    el("reload-status").style.removeProperty("top");
    el("reload-status").style.removeProperty("left");
  }
}
function frame() {
  // Sample callback execution time, not a possibly queued vsync timestamp.
  const now = performance.now();
  if (disposed) return;
  frameId = requestAnimationFrame(frame);
  const dt = lastFrame ? Math.max(0, (now - lastFrame) / 1000) : 0;
  lastFrame = now;
  lastFrameGap = dt;
  if (state.phase === "playing" && screen === "playing") {
    if (dt > 1) {
      lastInterruption = { reason: "frame", gap: dt, render: scene?.diagnostics() };
      pause("frame");
      return;
    }
    renderStatus = scene?.pollRender(now) ?? "failed";
    if (renderStatus === "stalled" || renderStatus === "failed") {
      lastInterruption = { reason: renderStatus, gap: dt, render: scene?.diagnostics() };
      pause(renderStatus === "failed" ? "render-failed" : "render");
      return;
    }
    if (dt > 0) {
      frameIntervals.push(dt * 1000);
      if (frameIntervals.length > 3600) frameIntervals.shift();
    }
    accumulator += dt;
    const input = controls.sample();
    pendingLoop ||= input.loop; pendingBomb ||= Boolean(input.bomb); pendingTorpedo ||= Boolean(input.torpedo);
    input.viewAspect = scene?.camera.aspect ?? 1;
    const events: GameEvent[] = [];
    let first = true;
    const begin = performance.now();
    while (accumulator + 1e-9 >= FIXED_DT && state.phase === "playing") {
      stepGame(state, { ...input, loop: first && pendingLoop, bomb: first && pendingBomb, torpedo: first && pendingTorpedo }, FIXED_DT);
      events.push(...state.events);
      accumulator -= FIXED_DT;
      first = false;
      pendingLoop = false; pendingBomb = false; pendingTorpedo = false;
    }
    updateTimes.push(performance.now() - begin);
    if (updateTimes.length > 3600) updateTimes.shift();
    scene?.events(events, state.elapsed);
    allyAnnouncements.record(events);
    for (const e of events) {
      const relates =
        e.owner === state.player.id || e.target === state.player.id;
      if (e.type === "shot" && state.ships.some(ship => ship.id === e.owner)) audio.worldEvent(e, state.player, "naval-shot");
      else if (e.type === "splash") audio.worldEvent(e, state.player, "splash");
      else if (e.type === "ordnance-impact") audio.worldEvent(e, state.player, "ordnance-impact");
      else if (e.type === "kill" && e.targetKind === "ship") audio.worldEvent(e, state.player, "ship-explosion");
      else if (e.type === "hit" && e.targetKind === "ship") audio.worldEvent(e, state.player, "metal-hit");
      else if (e.type === "kill") audio.event(e, e.target !== state.player.id);
      else if (relates) audio.event(e, true);
      if (e.type === "reload-start") announce("弾切れ · 6秒後に再装填", 2);
      if (e.type === "reload-complete") announce("再装填完了", 1.5);
      if (e.type === "reinforcement") announce(`敵${e.amount ?? 0}機が復活 · 撃破でHP回復`, 4, 3);
      if (e.type === "payload-release" && e.owner === state.player.id) announce(e.weapon === "bomb" ? "爆弾投下" : "魚雷投下 · 80m航走で起爆可能", 2, 1);
      if (e.type === "payload-rejected" && e.owner === state.player.id) {
        const reasons: Record<string, string> = { altitude: "魚雷：高度20〜80mを目安に", speed: "魚雷：450km/h以下に減速", pitch: "魚雷：機首を水平に", bank: "魚雷：翼を水平に", reload: "兵装を再装填中", cooldown: "続けての投下は少し待って", capacity: "飛翔中の兵装が戻るまで待って", invalid: "この姿勢では投下できません" };
        announce(reasons[e.detail ?? "invalid"], 2, 1);
      }
      if (e.type === "ordnance-dud" && e.owner === state.player.id) announce(e.weapon === "bomb" ? "爆弾不発 · 投下直後の接触" : "魚雷不発 · 進入条件/航走距離を確認", 3, 1);
      if (e.type === "ordnance-impact" && e.owner === state.player.id) announce(e.detail === "wreck" ? "沈没中の残骸に命中" : `${e.weapon === "bomb" ? "爆弾" : "魚雷"}命中 · 艦体損傷`, 2, 1);
      if (e.type === "mount-destroyed" && e.owner === state.player.id) announce("敵砲座を破壊", 2, 1);
      if (e.type === "hit" && e.armor && e.owner === state.player.id && state.elapsed - lastArmorHintAt > 5) {
        lastArmorHintAt = state.elapsed; announce("艦の装甲には爆弾・魚雷を", 2.5);
      }
      if (e.type === "heal") announce(`復活敵撃破 · HP +${e.amount ?? 0}`, 2.5);
      if (
        e.type === "kill" &&
        e.target !== state.player.id &&
        e.team === "friendly" && e.targetTeam === "enemy" &&
        (e.owner === state.player.id || e.targetKind === "ship")
      )
        announce(e.targetKind === "ship" ? "敵艦撃沈" : "敵機撃墜", 1.5);
    }
    audio.update(state.player.speed);
    audio.updatePasses([...state.allies, ...state.enemies], state.player, state.elapsed);
    updateHUD();
    if (state.result !== null) finish();
  }
  if (state.phase !== "playing" && scene && !contextLost) {
    renderStatus = scene.pollRender(now);
    if (screen === "paused") {
      el<HTMLButtonElement>("resume").disabled = renderStatus === "stalled" || renderStatus === "failed";
      el("pause-reload").hidden = renderStatus !== "failed";
      if (pauseReasons.has("render") && renderStatus === "ready")
        el("pause-reason").textContent = "描画が復帰しました。操作して再開できます";
    }
  }
  if (scene && !contextLost) {
    scene.render(state, screen === "playing" || screen === "paused", dt);
    if (screen === "paused") positionReloadStatus();
    if (scene.diagnostics().queue.status === "failed") {
      renderStatus = "failed";
      if (screen === "home") preparationFailed(new Error("GPU frame completion unavailable"));
      else if (screen === "playing") pause("render-failed");
    }
  }
}
for (const id of ["start", "retry", "pause-restart"])
  el(id).addEventListener("click", begin);
for (const id of ["result-home", "pause-home"])
  el(id).addEventListener("click", home);
el("pause").addEventListener("click", () => pause("manual"));
el("resume").addEventListener("click", resume);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) pause("hidden");
});
window.addEventListener("blur", () => pause("blur"));
document.addEventListener("keydown", (e) => {
  // Native dialog owns Escape and Tab while configuration is open.
  if (settings.isOpen) return;
  if (e.key === "Escape") {
    if (screen === "playing") pause("manual");
    else if (screen === "paused") resume();
  }
  if (e.key === "Tab" && screen === "paused") {
    const items = [el("pause-reload"), el("resume"), el("pause-restart"), el("pause-home"), el("pause-controls")].filter(
      (x) => !x.hidden && !(x as HTMLButtonElement).disabled,
    );
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (e.shiftKey && index <= 0) {
      e.preventDefault();
      items.at(-1)?.focus();
    } else if (!e.shiftKey && index === items.length - 1) {
      e.preventDefault();
      items[0]?.focus();
    }
  }
});
canvas.addEventListener("webglcontextlost", (event) => {
  event.preventDefault();
  contextLost = true;
  scene?.resetRenderQueue();
  pause("context");
});
canvas.addEventListener("webglcontextrestored", () => {
  contextLost = false;
  scene?.resetRenderQueue();
  renderStatus = "ready";
  el<HTMLButtonElement>("resume").disabled = false;
  el("pause-reason").textContent = "描画が復帰しました。操作して再開できます";
});
window.addEventListener("resize", () => scene?.resize());
window.visualViewport?.addEventListener("resize", () => scene?.resize());
window.addEventListener("pageshow", (event) => {
  if (event.persisted) pause("restored");
});
let preparationGeneration = 0;
function preparationFailed(error: unknown) {
  preparationGeneration++;
  graphicsReady = false;
  cancelAnimationFrame(frameId);
  scene?.dispose();
  scene = null;
  el<HTMLButtonElement>("start").disabled = true;
  el("start").textContent = "出撃の準備ができませんでした";
  const message = el("startup-error");
  message.hidden = false;
  message.textContent =
    "3D画面の準備が完了しませんでした。再読み込みしてお試しください";
  el("reload").hidden = false;
  console.error("Kaisen renderer preparation failed", error);
}
el("reload").addEventListener("click", () => location.reload());
el("pause-reload").addEventListener("click", () => location.reload());
try {
  scene = new KaisenScene(canvas, overlay);
  scene.render(state, false);
  const attempt = ++preparationGeneration;
  let timeout: ReturnType<typeof setTimeout>;
  void Promise.race([
    scene.prepare(),
    new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error("Renderer preparation timed out")),
        15000,
      );
    }),
  ])
    .then(() => {
      if (disposed || attempt !== preparationGeneration) return;
      if (contextLost)
        throw new Error("Rendering context was lost while preparing");
      graphicsReady = true;
      frameId = requestAnimationFrame(frame);
      el<HTMLButtonElement>("start").disabled = false;
      el("start").innerHTML = '出撃する <span aria-hidden="true">↗</span>';
    })
    .catch((error) => {
      if (!disposed && attempt === preparationGeneration)
        preparationFailed(error);
    })
    .finally(() => clearTimeout(timeout));
} catch (error) {
  preparationFailed(error);
}

// Development-only, deeply copied observation. No mutation or result injection API.
if (import.meta.env.DEV) {
  Object.defineProperty(window, "__kaisenReadState", {
    value: () =>
      JSON.parse(
        JSON.stringify({
          phase: state.phase,
          mode: state.mode,
          selectedMode,
          config: state.config,
          gunSight: state.mode === "normal" ? scene?.gunSight(state) : null,
          graphicsReady,
          screen,
          tick: state.tick,
          elapsed: state.elapsed,
          reinforcementsSpawned: state.reinforcementsSpawned,
          player: state.player,
          allies: state.allies,
          enemies: state.enemies,
          ships: state.ships,
          bullets: state.bullets.length,
          ordnance: state.ordnance,
          result: state.result,
          stats: state.stats,
          deathCause: state.deathCause,
          allyRespawnAt: state.allyRespawnAt,
          allyActivity: allyAnnouncements.snapshot(),
          controlsInput: controls.peek(),
          settingsOpen: settings.isOpen,
          render: scene?.diagnostics(),
          audio: {
            enabled: audio.enabled,
            active: audio.active,
            failed: audio.failed,
            voices: audio.activeEffectVoiceCount,
            sources: audio.activeEffectSourceCount,
          },
          frameIntervals,
          lastFrameGap,
          lastInterruption,
          renderStatus,
          pauseReasons: [...pauseReasons],
          updateTimes,
        }),
      ),
    configurable: true,
  });
}
window.addEventListener("pagehide", (event) => {
  if (event.persisted) {
    pause("hidden");
    return;
  }
  if (disposed) return;
  disposed = true;
  cancelAnimationFrame(frameId);
  controls.dispose();
  settings.dispose();
  audio.dispose();
  scene?.dispose();
});
