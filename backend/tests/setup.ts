// The config module reads these at import time, so they are set before any test loads it.
process.env.CRON_SECRET ??= "integration-test-cron-secret";
