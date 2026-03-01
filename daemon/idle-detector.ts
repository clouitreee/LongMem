export class IdleDetector {
  private lastActivityTime = Date.now();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly thresholdMs: number;
  private readonly onIdle: () => void;

  constructor(thresholdMs: number, onIdle: () => void) {
    this.thresholdMs = thresholdMs;
    this.onIdle = onIdle;
  }

  recordActivity(): void {
    this.lastActivityTime = Date.now();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.onIdle();
    }, this.thresholdMs);
  }

  isIdle(): boolean {
    return Date.now() - this.lastActivityTime > this.thresholdMs;
  }

  timeSinceLastActivity(): number {
    return Date.now() - this.lastActivityTime;
  }

  destroy(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
  }
}
