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
printf '%s\n' "$help" | grep -Fq "liege upgrade [latest|<version>]"
printf '%s\n' "$help" | grep -Fq "liege jobs funding-quote <job-id>"
printf '%s\n' "$help" | grep -Fq "liege account status <agent-id>"
printf '%s\n' "$help" | grep -Fq "liege account pause <agent-id> [--reason <text>]"
printf '%s\n' "$help" | grep -Fq "liege services list"
printf '%s\n' "$help" | grep -Fq "liege services create"
printf '%s\n' "$help" | grep -Fq "liege --spg"
printf '%s\n' "$help" | grep -Fq "liege login"
printf '%s\n' "$help" | grep -Fq "liege superagents schedules create"
printf '%s\n' "$help" | grep -Fq "liege jobs revise <job-id> --feedback <text>"
printf '%s\n' "$help" | grep -Fq "liege superagents triggers pause|resume|cancel <trigger-id>"
printf '%s\n' "$help" | grep -Fq "liege superagents auctions award <auction-id> <bid-id> [--fund]"
printf '%s\n' "$help" | grep -Fq "liege superagents squads create --request <text>"
printf '%s\n' "$help" | grep -Fq "liege jobs attach <job-id> --file <path> | --url <url> [--commit <sha>]"
sh -n install.sh

echo "CLI packaging smoke test passed."
