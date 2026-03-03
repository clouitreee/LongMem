import {
  getPendingCompressionJobs,
  updateCompressionJob,
  getObservationById,
  updateObservationSummary,
  upsertConcepts,
  linkObservationConcepts,
} from "./db.ts";
import { CompressionSDK } from "./compression-sdk.ts";
import {
  redactSecrets, containsHighRiskPattern,
  compileCustomPatterns, redactWithCustomPatterns,
} from "./privacy.ts";
import type { PrivacyMode } from "./config.ts";

interface WorkerConfig {
  maxConcurrent: number;
  maxPerMinute: number;
  circuitBreakerThreshold: number;
  circuitBreakerCooldownMs: number;
  circuitBreakerMaxCooldownMs: number;
  maxRetries: number;
}

interface PrivacyConfig {
  mode: PrivacyMode;
  customPatterns: Array<{ pattern: string; name: string }>;
}

export class CompressionWorker {
  private processing = false;
  private consecutiveFailures = 0;
  private circuitOpen = false;
  private circuitOpenCount = 0;
  private circuitTimer: ReturnType<typeof setTimeout> | null = null;
  private requestCount = 0;
  private requestWindowStart = Date.now();
  private privacyMode: PrivacyMode;
  private compiledCustom: RegExp[];

  constructor(
    private sdk: CompressionSDK,
    private config: WorkerConfig,
    privacyConfig?: PrivacyConfig,
  ) {
    this.privacyMode = privacyConfig?.mode ?? "safe";
    this.compiledCustom = compileCustomPatterns(privacyConfig?.customPatterns ?? []);
  }

  async processQueue(): Promise<void> {
    if (this.processing || this.circuitOpen) return;
    this.processing = true;

    try {
      const jobs = getPendingCompressionJobs(this.config.maxConcurrent);
      if (jobs.length === 0) return;

      for (const job of jobs) {
        if (!this.canMakeRequest()) break;

        let obs;
        try {
          obs = getObservationById(job.observation_id);
          if (!obs) {
            updateCompressionJob(job.id, "failed", "Observation not found");
            continue;
          }

          updateCompressionJob(job.id, "processing");

          // ── Egress gate: re-sanitize before sending to external LLM ──
          let egressInput = obs.tool_input || "{}";
          let egressOutput = obs.tool_output || "";

          if (this.privacyMode !== "none") {
            egressInput = redactSecrets(egressInput);
            egressOutput = redactSecrets(egressOutput);
            if (this.compiledCustom.length > 0) {
              egressInput = redactWithCustomPatterns(egressInput, this.compiledCustom);
              egressOutput = redactWithCustomPatterns(egressOutput, this.compiledCustom);
            }
          }

          // Kill switch: if high-risk pattern survives redaction → quarantine
          if (this.privacyMode !== "none" && containsHighRiskPattern(egressOutput)) {
            updateCompressionJob(job.id, "quarantined", "high_risk_pattern_detected_post_redaction");
            continue;
          }
          if (this.privacyMode !== "none" && containsHighRiskPattern(egressInput)) {
            updateCompressionJob(job.id, "quarantined", "high_risk_pattern_in_input");
            continue;
          }

          // Path-excluded observations: skip compression (metadata-only in DB)
          if (egressOutput === "[EXCLUDED: path matched denylist]") {
            updateCompressionJob(job.id, "skipped", "path_excluded");
            continue;
          }

          const compressed = await this.sdk.compress(
            obs.tool_name,
            JSON.parse(egressInput),
            egressOutput
          );

          updateObservationSummary(
            obs.id,
            compressed.summary,
            compressed.type,
            compressed.files,
            compressed.concepts
          );

          if (compressed.concepts.length > 0) {
            upsertConcepts(compressed.concepts);
            linkObservationConcepts(obs.id, compressed.concepts);
          }

          updateCompressionJob(job.id, "completed");
          this.consecutiveFailures = 0;
          this.circuitOpenCount = 0;
          this.recordRequest();

        } catch (error: any) {
          this.handleError(job, error);
        }
      }

      // Schedule another round if jobs remain
      const remaining = getPendingCompressionJobs(1);
      if (remaining.length > 0 && !this.circuitOpen) {
        setTimeout(() => this.processQueue(), 2000);
      }
    } finally {
      this.processing = false;
    }
  }

  private handleError(job: { id: number; attempts: number }, error: unknown): void {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const status = (error as any)?.status;

    if (status === 401 || status === 403) {
      // Auth error — don't retry
      updateCompressionJob(job.id, "failed", `Auth error: ${errorMsg}`);
      this.consecutiveFailures += this.config.circuitBreakerThreshold; // Trip immediately
    } else if (job.attempts >= this.config.maxRetries) {
      updateCompressionJob(job.id, "failed", `Max retries: ${errorMsg}`);
    } else {
      updateCompressionJob(job.id, "pending", errorMsg);
    }

    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.config.circuitBreakerThreshold) {
      this.openCircuit();
    }
  }

  private canMakeRequest(): boolean {
    const now = Date.now();
    if (now - this.requestWindowStart > 60000) {
      this.requestCount = 0;
      this.requestWindowStart = now;
    }
    return this.requestCount < this.config.maxPerMinute;
  }

  private recordRequest(): void {
    this.requestCount++;
  }

  private openCircuit(): void {
    this.circuitOpen = true;
    this.circuitOpenCount++;
    if (this.circuitTimer) clearTimeout(this.circuitTimer);
    
    const baseDelay = this.config.circuitBreakerCooldownMs;
    const maxDelay = this.config.circuitBreakerMaxCooldownMs || 300000;
    const delay = Math.min(baseDelay * Math.pow(2, this.circuitOpenCount - 1), maxDelay);
    
    this.circuitTimer = setTimeout(() => {
      this.circuitOpen = false;
      this.consecutiveFailures = 0;
      this.processQueue();
    }, delay);
  }

  pendingCount(): number {
    return getPendingCompressionJobs(1000).length;
  }

  isCircuitOpen(): boolean {
    return this.circuitOpen;
  }
}
