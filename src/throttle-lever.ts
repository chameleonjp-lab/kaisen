/** Shared flight-series rate-lever contract v1. Keep identical across adapters. */
export const THROTTLE_LEVER_CONTRACT_VERSION = 1;
export const THROTTLE_LEVER_DEADZONE = 0.08;

/** Finite command axis, upward positive. Non-finite input fails neutral. */
export function clampThrottleAxis(value: number): number {
  return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
}

/** Continuous response after an inclusive, symmetric 8% centre deadzone. */
export function throttleAxisFromRaw(raw: number): number {
  const value = clampThrottleAxis(raw);
  const magnitude = Math.abs(value);
  return magnitude <= THROTTLE_LEVER_DEADZONE ? 0
    : Math.sign(value) * (magnitude - THROTTLE_LEVER_DEADZONE) / (1 - THROTTLE_LEVER_DEADZONE);
}

/** top/bottom are the handle-centre endpoints, not the outer hit-area edges. */
export function throttleAxisFromClientY(clientY: number, top: number, bottom: number): number {
  if (![clientY, top, bottom].every(Number.isFinite) || bottom <= top) return 0;
  return throttleAxisFromRaw(1 - 2 * (clientY - top) / (bottom - top));
}

/** Independent pointer/keyboard commands add and clamp; opposing keys cancel. */
export function combineThrottleAxes(pointerAxis: number, accelerate: boolean, brake: boolean, focusedAxis = 0): number {
  return clampThrottleAxis(clampThrottleAxis(pointerAxis) + Number(accelerate) - Number(brake) + clampThrottleAxis(focusedAxis));
}

/** Optional analog axis is authoritative, including explicit zero. Legacy AI/replays remain valid. */
export function resolveThrottleAxis(input: { throttle?: number; accelerate?: boolean; brake?: boolean }): number {
  return input.throttle === undefined
    ? Number(Boolean(input.accelerate)) - Number(Boolean(input.brake))
    : clampThrottleAxis(input.throttle);
}
