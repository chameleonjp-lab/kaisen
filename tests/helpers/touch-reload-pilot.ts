import { createFeedbackEasyPilot } from './feedback-easy-pilot';
/** Inverse of the unchanged source stick's .08 radial dead zone. */
export function pointerOffsetForControls(turn: number, climb: number) {
  const r = Math.hypot(turn, climb);
  if (r === 0) return { dx: 0, dy: 0 };
  const scale = 36 * (.08 + .92 * r) / r;
  return { dx: turn * scale, dy: -climb * scale };
}

export const createTouchReloadPilot = createFeedbackEasyPilot;
