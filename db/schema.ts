// Runtime code uses prepared D1 statements directly. These definitions are
// kept beside the migration so the durable data model remains auditable.
export const travelJobsTable = "travel_jobs";
export const apiUsageTable = "api_usage";
export const providerHealthTable = "provider_health";
export const responseCacheTable = "response_cache";

export interface TravelJobRow {
  id: string;
  idempotency_key: string;
  client_hash: string;
  access_token_hash: string;
  status: "queued" | "analysis" | "live" | "route" | "done" | "error";
  payload_json: string;
  progress_json: string | null;
  result_json: string | null;
  error_message: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

export interface ProviderHealthRow {
  provider: string;
  status: "healthy" | "degraded" | "unavailable" | "unknown";
  last_success_at: number | null;
  last_failure_at: number | null;
  latency_ms: number | null;
  last_error_code: string | null;
  last_error_message: string | null;
  total_requests: number;
  success_count: number;
  failure_count: number;
  rate_limited_count: number;
  cache_hits: number;
  updated_at: number;
}
