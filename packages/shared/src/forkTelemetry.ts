/**
 * Fork-only: no surface sends product analytics, relay traces, or crash reports to T3 Code's
 * services unless a server is started with `T3CODE_TELEMETRY_ENABLED=true`. Export to an OTLP
 * receiver the user configures is unaffected. Keep this file when merging upstream.
 */
export const telemetryOnByDefault: boolean = false;
