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
const controls = new FlightControls(
  canvas,
  {
    fire: el("fire"),
    loop: el("loop"),
    accelerate: el("accelerate"),
    brake: el("brake"),
  },
  () => screen === "playing" && state.phase === "playing",
);
controls.setMode(selectedMode);
function modeName(mode: GameMode): string { return mode === "easy" ? "イージー" : "ノーマル"; }
function syncMode() {
  app.dataset.mode = state.mode;
  controls.setMode(state.mode);
  el("normal-controls").hidden = state.mode !== "normal";
  el("hud-mode").textContent = modeName(state.mode);
  el("result-mode").textContent = modeName(state.mode);
  el("mode-guide").textContent = state.mode === "easy"
    ? "照準円内・1.2km以内へ自動射撃 · 右下で宙返り"
    : "照準補助なし・手動射撃 · 加速・減速・宙返りをボタンで操作";
  el("keyboard-guide").textContent = state.mode === "easy"
    ? "キーボード：矢印で操縦 · Lで宙返り"
    : "キーボード：矢印で操縦 · Spaceで射撃 · W/Sで加速/減速 · Lで宙返り";
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
let pendingLoop = false;
let lastFrameGap = 0;
let lastInterruption: { reason: string; gap: number; render: unknown } | null = null;
let renderStatus: "ready" | "pending" | "stalled" | "failed" = "ready";
let frameIntervals: number[] = [];
let updateTimes: number[] = [];
function formatTime(seconds: number) {
  const cs = Math.floor(Math.max(0, seconds) * 100 + 1e-6);
  return `${String(Math.floor(cs / 6000)).padStart(2, "0")}:${String(Math.floor(cs / 100) % 60).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}
function setScreen(next: typeof screen) {
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
function announce(text: string, duration = 3) {
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
    screen === "playing"
  )
    return;
  generation++;
  pendingLoop = false;
  audio.resetFlight();
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
  announce("敵機5機と艦隊3隻をすべて撃破", 4);
  scene.render(state, true);
  // Initial resource upload is preparation, not elapsed mission time.
  lastFrame = 0;
  updateHUD();
}
function home() {
  pendingLoop = false;
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
  pendingLoop = false;
  pauseReasons.add(reason);
  pauseGame(state);
  accumulator = 0;
  setScreen("paused");
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
  if (document.hidden || contextLost || state.phase !== "paused" || renderStatus === "stalled" || renderStatus === "failed") return;
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
  el("result-reason").textContent =
    r.outcome === "victory"
      ? "敵航空隊と敵艦隊を全滅させました"
      : state.endReason === "sea"
        ? "海面に接触しました"
        : state.endReason === "collision"
          ? "敵と衝突しました"
          : "自機が撃墜されました";
  el("result-time-label").textContent =
    r.outcome === "victory" ? "クリアタイム" : "経過時間";
  el("result-time").textContent = formatTime(r.time);
  el("player-kills").textContent =
    `${r.playerAircraftKills}機 · ${r.playerShipKills}隻`;
  el("ally-kills").textContent =
    `${r.allyAircraftKills}機 · ${r.allyShipKills}隻`;
  el("survivors").textContent = `${r.alliesSurvived}機`;
}
function updateHUD() {
  el("timer").textContent = formatTime(state.elapsed);
  el("enemy-count").textContent = String(
    state.enemies.filter((p) => p.health > 0).length,
  );
  el("enemy-total").textContent = `/ ${state.enemies.length}`;
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
  el("health").textContent = String(Math.ceil(state.player.health));
  el("health-bar").style.width = `${Math.max(0, state.player.health)}%`;
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
}
function positionReloadStatus() {
  if (state.mode === "normal" && scene) {
    const sight = scene.gunSight(state);
    el("reload-status").style.top = `${sight.y + 30}px`;
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
    pendingLoop ||= input.loop;
    input.viewAspect = scene?.camera.aspect ?? 1;
    const events: GameEvent[] = [];
    let first = true;
    const begin = performance.now();
    while (accumulator + 1e-9 >= FIXED_DT && state.phase === "playing") {
      stepGame(state, { ...input, loop: first && pendingLoop }, FIXED_DT);
      events.push(...state.events);
      accumulator -= FIXED_DT;
      first = false;
      pendingLoop = false;
    }
    updateTimes.push(performance.now() - begin);
    if (updateTimes.length > 3600) updateTimes.shift();
    scene?.events(events, state.elapsed);
    for (const e of events) {
      const relates =
        e.owner === state.player.id || e.target === state.player.id;
      if (e.type === "kill") audio.event(e, e.target !== state.player.id);
      else if (relates) audio.event(e, true);
      if (e.type === "reload-start") announce("弾切れ · 6秒後に再装填", 2);
      if (e.type === "reload-complete") announce("再装填完了", 1.5);
      if (e.type === "reinforcement") announce("敵3機が復活 · 撃破でHP回復", 4);
      if (e.type === "heal") announce(`復活敵撃破 · HP +${e.amount ?? 0}`, 2.5);
      if (
        e.type === "kill" &&
        e.target !== state.player.id &&
        e.team === "friendly"
      )
        announce(e.targetKind === "ship" ? "敵艦撃沈" : "敵機撃墜", 1.5);
    }
    audio.update(state.player.speed);
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
  if (e.key === "Escape") {
    if (screen === "playing") pause("manual");
    else if (screen === "paused") resume();
  }
  if (e.key === "Tab" && screen === "paused") {
    const items = [el("pause-reload"), el("resume"), el("pause-restart"), el("pause-home")].filter(
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
          result: state.result,
          stats: state.stats,
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
  audio.dispose();
  scene?.dispose();
});
