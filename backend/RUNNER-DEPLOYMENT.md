# Runner worker deployment

The API can delegate execution by setting `RUNNER_WORKER_URL` and a matching `RUNNER_WORKER_TOKEN` (at least 32 characters). The worker image is built from `runner.Dockerfile` and exposes only `/health` and the authenticated `/run` endpoint.

Run the worker with a platform that supports these restrictions:

```sh
docker run --rm --name liege-runner \
  --network=none --read-only --tmpfs /tmp:rw,noexec,nosuid,size=128m \
  --cap-drop=ALL --security-opt=no-new-privileges \
  --pids-limit=64 --memory=512m --cpus=1 \
  -e RUNNER_WORKER_TOKEN="$RUNNER_WORKER_TOKEN" \
  -p 127.0.0.1:3200:3200 ghcr.io/liegeagents/liegeagentsapp-runner:latest
```

The API remains responsible for ownership checks, persistence, encrypted artifacts, and audit records. The worker has no database, wallet, or deployment credentials. The local process fallback is development-only and the API refuses to start in production without the remote worker configuration.

Render can deploy the image but does not enforce the Docker restrictions above. Treat a Render runner as bounded execution, not a safe host for untrusted code. Before accepting untrusted workloads, deploy the worker on a microVM or gVisor-backed platform and verify outbound network controls there.
