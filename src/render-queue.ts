export type RenderQueueStatus = 'ready' | 'pending' | 'stalled' | 'failed';

export type RenderQueueFailure =
  | 'context-lost'
  | 'wait-failed'
  | 'fence-unavailable'
  | 'submission-pending'
  | 'api-error'
  | 'disposed';

export type RenderQueueContext = Pick<WebGL2RenderingContext,
  | 'SYNC_GPU_COMMANDS_COMPLETE' | 'ALREADY_SIGNALED' | 'CONDITION_SATISFIED'
  | 'TIMEOUT_EXPIRED' | 'WAIT_FAILED' | 'fenceSync' | 'clientWaitSync'
  | 'deleteSync' | 'flush' | 'isContextLost'
>;

export interface RenderQueueDiagnostics {
  status: RenderQueueStatus;
  failure: RenderQueueFailure | null;
  pendingMs: number;
  /** CPU-observed submission-to-completion latency, not a GPU timer query. */
  lastCompletedPendingMs: number | null;
  /** Interval between completion observations; null until two frames complete. */
  completedFrameIntervalMs: number | null;
  submittedCount: number;
  completedCount: number;
  /** Number of polls that skipped rendering because the fence was pending. */
  skippedCount: number;
}

const STALL_AFTER_MS = 1000;

/**
 * At most one fenced frame in flight. Poll once per rAF before updating the
 * view, then submit after issuing all that frame's draw commands. A pending
 * result skips only rendering; stalled/failed lets the caller pause simulation.
 * There is no blocking wait, busy loop, or automatic failure retry here.
 * https://registry.khronos.org/webgl/specs/latest/2.0/#3.7.14
 */
export class RenderQueue {
  private fence: WebGLSync | null = null;
  private submittedAtMs = 0;
  private completedAtMs: number | null = null;
  private lastCompletedPendingMs: number | null = null;
  private completedFrameIntervalMs: number | null = null;
  private submittedCount = 0;
  private completedCount = 0;
  private skippedCount = 0;
  private failure: RenderQueueFailure | null = null;
  private disposed = false;

  constructor(private readonly gl: RenderQueueContext) {}

  poll(nowMs: number): RenderQueueStatus {
    if (this.failure) return 'failed';
    try {
      if (this.gl.isContextLost()) return this.fail('context-lost');
      if (!this.fence) return 'ready';

      // Zero flags and timeout: never block or flush again while polling.
      const result = this.gl.clientWaitSync(this.fence, 0, 0);
      if (result === this.gl.TIMEOUT_EXPIRED) {
        this.skippedCount++;
        return this.pendingStatus(nowMs);
      }
      if (result !== this.gl.ALREADY_SIGNALED && result !== this.gl.CONDITION_SATISFIED) {
        // WAIT_FAILED (or any unexpected result) cannot silently freeze the view.
        return this.fail(this.gl.isContextLost() ? 'context-lost' : 'wait-failed');
      }

      const pendingMs = this.pendingMs(nowMs);
      if (!this.releaseFence()) return this.fail('api-error');
      this.lastCompletedPendingMs = pendingMs;
      this.completedFrameIntervalMs = this.completedAtMs === null
        ? null : Math.max(0, nowMs - this.completedAtMs);
      this.completedAtMs = nowMs;
      this.completedCount++;
      return 'ready';
    } catch {
      return this.fail('api-error');
    }
  }

  submit(nowMs: number): void {
    if (this.failure) return;
    if (this.fence) {
      this.fail('submission-pending');
      return;
    }
    try {
      if (this.gl.isContextLost()) {
        this.fail('context-lost');
        return;
      }
      this.fence = this.gl.fenceSync(this.gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      if (!this.fence) {
        this.fail(this.gl.isContextLost() ? 'context-lost' : 'fence-unavailable');
        return;
      }
      this.submittedAtMs = nowMs;
      this.gl.flush();
      this.submittedCount++;
    } catch {
      this.fail('api-error');
    }
  }

  /** Pure snapshot: does not poll GL, change counters, or acknowledge completion. */
  diagnostics(nowMs: number): RenderQueueDiagnostics {
    return {
      status: this.failure ? 'failed' : this.fence ? this.pendingStatus(nowMs) : 'ready',
      failure: this.failure,
      pendingMs: this.pendingMs(nowMs),
      lastCompletedPendingMs: this.lastCompletedPendingMs,
      completedFrameIntervalMs: this.completedFrameIntervalMs,
      submittedCount: this.submittedCount,
      completedCount: this.completedCount,
      skippedCount: this.skippedCount,
    };
  }

  /**
   * Begin a fresh measurement epoch after explicit recovery or completed warmup.
   * Deleting a fence does NOT drain GPU work: do not reset on ordinary timeouts.
   * The owner must drain/rebuild the context before retrying an unknown failure.
   */
  reset(): void {
    if (this.disposed) return;
    this.failure = this.releaseFence() ? null : 'api-error';
    this.submittedAtMs = 0;
    this.completedAtMs = this.lastCompletedPendingMs = this.completedFrameIntervalMs = null;
    this.submittedCount = this.completedCount = this.skippedCount = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseFence();
    this.failure = 'disposed';
  }

  private pendingMs(nowMs: number): number {
    return this.fence ? Math.max(0, nowMs - this.submittedAtMs) : 0;
  }

  private pendingStatus(nowMs: number): 'pending' | 'stalled' {
    return this.pendingMs(nowMs) > STALL_AFTER_MS ? 'stalled' : 'pending';
  }

  private fail(reason: RenderQueueFailure): 'failed' {
    this.failure = reason;
    this.releaseFence();
    return 'failed';
  }

  private releaseFence(): boolean {
    const fence = this.fence;
    this.fence = null;
    if (!fence) return true;
    // Drop ownership first, so cleanup cannot delete this fence twice on error.
    try {
      this.gl.deleteSync(fence);
      return true;
    } catch {
      return false;
    }
  }
}
