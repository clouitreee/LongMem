// Re-export from shared — single source of truth
export {
  stripAllMemoryTags,
  isFullyPrivate,
  truncateInput,
  truncateOutput,
  redactSecrets,
  sanitize,
  extractPathHint,
  isExcludedPath,
  containsHighRiskPattern,
  compileCustomPatterns,
  redactWithCustomPatterns,
} from "../shared/privacy.ts";
