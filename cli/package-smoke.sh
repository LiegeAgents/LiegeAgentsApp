#!/usr/bin/env sh
set -eu

artifact="$(mktemp "${TMPDIR:-/tmp}/liege-cli.XXXXXX")"
trap 'rm -f "$artifact"' EXIT

bun build --compile src/index.ts --outfile="$artifact"
help="$($artifact --help)"
printf '%s\n' "$help" | grep -Fq "liege policy get <agent-id>"
printf '%s\n' "$help" | grep -Fq "liege proposals approve <proposal-id>"
sh -n install.sh

echo "CLI packaging smoke test passed."
