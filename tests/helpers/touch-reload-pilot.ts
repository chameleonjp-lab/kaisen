import { createBrowserMissionPilot } from './mission-browser-pilot';
/** Inverse of the unchanged source stick's .08 radial dead zone. */
export function pointerOffsetForControls(turn: number, climb: number) {
  const r = Math.hypot(turn, climb);
  if (r === 0) return { dx: 0, dy: 0 };
  const scale = 36 * (.08 + .92 * r) / r;
  return { dx: turn * scale, dy: -climb * scale };
}

// The dedicated gun route follows current weapon lead and never requests a payload.
export const createTouchReloadPilot = () => createBrowserMissionPilot(true);
