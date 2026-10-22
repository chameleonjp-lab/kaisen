/** Refresh time drives motion; callback execution time detects real main-thread interruptions. */
export class FrameClock {
  private previous: { refresh: number; execution: number } | null = null;
  reset() { this.previous = null; }
  sample(refresh: number, execution: number) {
    const dt = this.previous ? Math.max(0, (refresh - this.previous.refresh) / 1000) : 0;
    const gap = this.previous ? Math.max(0, (execution - this.previous.execution) / 1000) : 0;
    this.previous = { refresh, execution };
    return { dt, gap };
  }
}
