#!/usr/bin/env sh
set -eu

REPO="LiegeAgents/LiegeAgentsApp"
BINARY="${LIEGE_BINARY_NAME:-liege}"
INSTALL_DIR="${LIEGE_INSTALL_DIR:-$HOME/.local/bin}"
VERSION_ARG="${1:-latest}"

latest_version() {
  curl -fsSL "https://api.github.com/repos/$REPO/releases" \
    | sed -n 's/.*"tag_name": "\(cli-v[^"]*\)".*/\1/p' \
    | head -n 1
}

if [ "$VERSION_ARG" = "latest" ]; then
  VERSION=$(latest_version)
else
  case "$VERSION_ARG" in
    cli-v*) VERSION="$VERSION_ARG" ;;
    v*) VERSION="cli-$VERSION_ARG" ;;
    *) VERSION="cli-v$VERSION_ARG" ;;
  esac
fi

case "$(uname -s):$(uname -m)" in
  Linux:x86_64) TARGET="liege-linux-x86_64" ;;
  Linux:aarch64|Linux:arm64) TARGET="liege-linux-arm64" ;;
  Darwin:x86_64) TARGET="liege-macos-x86_64" ;;
  Darwin:arm64) TARGET="liege-macos-arm64" ;;
  *) echo "Unsupported platform: $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac

URL="https://github.com/$REPO/releases/download/$VERSION/$TARGET"
CHECKSUM_URL="https://github.com/$REPO/releases/download/$VERSION/checksums.txt"
TMP_BIN="$(mktemp "${TMPDIR:-/tmp}/liege.XXXXXX")"
TMP_SUMS="$(mktemp "${TMPDIR:-/tmp}/liege-checksums.XXXXXX")"
trap 'rm -f "$TMP_BIN" "$TMP_SUMS"' EXIT
echo "Installing Liege CLI $VERSION for $TARGET..."
curl -fsSL "$URL" -o "$TMP_BIN"
curl -fsSL "$CHECKSUM_URL" -o "$TMP_SUMS"
EXPECTED="$(awk -v file="$TARGET" '$2 == file { print $1 }' "$TMP_SUMS")"
if [ -z "$EXPECTED" ]; then
  echo "No checksum was published for $TARGET in $VERSION." >&2
  exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL="$(sha256sum "$TMP_BIN" | awk '{print $1}')"
else
  ACTUAL="$(shasum -a 256 "$TMP_BIN" | awk '{print $1}')"
fi
if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "Checksum verification failed for $TARGET." >&2
  exit 1
fi
chmod +x "$TMP_BIN"

if [ -e "$INSTALL_DIR/$BINARY" ] && ! "$INSTALL_DIR/$BINARY" --help 2>&1 | grep -q "Liege operator CLI"; then
  echo "Refusing to overwrite $INSTALL_DIR/$BINARY: it is not a Liege CLI binary." >&2
  exit 1
fi
mkdir -p "$INSTALL_DIR"
mv -f "$TMP_BIN" "$INSTALL_DIR/$BINARY"
echo "Installed $BINARY to $INSTALL_DIR/$BINARY"
case ":${PATH:-}:" in *":$INSTALL_DIR:"*) ;; *) echo "Add $INSTALL_DIR to PATH if needed." ;; esac
echo "Run: $BINARY --help"
