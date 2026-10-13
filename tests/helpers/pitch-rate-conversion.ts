/**
 * Convert a test pilot's legacy normalized absolute-pitch target to a legal
 * normalized manual rate command. The production contract is now a rate, so
 * only test drivers that used the former absolute command need this adapter.
 */
export function absolutePitchTargetToRateCommand(command: number, pitch: number, speed: number, dt = 1 / 60): number {
  if (![command, pitch, speed, dt].every(Number.isFinite) || dt <= 0) return 0;
  const targetPitch = Math.max(-1, Math.min(1, command)) * .95;
  const lowSpeedAuthority = speed <= 85 ? .92 + ((speed - 65) / 20) * .23
    : speed <= 110 ? 1.15 - ((speed - 85) / 25) * .15 : 1;
  const highSpeedLoad = Math.max(.78, Math.min(1, 1 - Math.max(0, speed - 115) * .008));
  const oldDiscretePitchStep = (targetPitch - pitch) * (1 - Math.exp(-4.2 * dt));
  const newMaxPitchStep = .82 * lowSpeedAuthority * highSpeedLoad * dt;
  return Math.max(-1, Math.min(1, oldDiscretePitchStep / newMaxPitchStep));
}
