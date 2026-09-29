-- Supports pruning expired rate limit buckets.
CREATE INDEX rate_limit_buckets_window_idx ON rate_limit_buckets (window_started_at);
