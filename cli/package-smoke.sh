#!/usr/bin/env sh
set -eu

artifact="$(mktemp "${TMPDIR:-/tmp}/liege-cli.XXXXXX")"
trap 'rm -f "$artifact"' EXIT

bun build --compile src/index.ts --outfile="$artifact"
help="$($artifact --help)"
printf '%s\n' "$help" | grep -Fq "liege policy get <agent-id>"
printf '%s\n' "$help" | grep -Fq "liege invoices issue '<json-invoice>'"
printf '%s\n' "$help" | grep -Fq "liege proposals approve <proposal-id>"
printf '%s\n' "$help" | grep -Fq "liege runner simulate <agent-id>"
printf '%s\n' "$help" | grep -Fq "liege proposals wait <proposal-id>"
printf '%s\n' "$help" | grep -Fq "liege account status <agent-id>"
printf '%s\n' "$help" | grep -Fq "liege account pause <agent-id> [--reason <text>]"
printf '%s\n' "$help" | grep -Fq "liege services list"
printf '%s\n' "$help" | grep -Fq "liege services create"
sh -n install.sh

echo "CLI packaging smoke test passed."
