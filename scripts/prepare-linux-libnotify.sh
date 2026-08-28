#!/bin/sh
set -eu

if [ "$(uname -s)" != "Linux" ]; then
  echo "Linux libnotify preparation must run on Linux" >&2
  exit 1
fi

VERSION="0.8.7"
ARCHIVE="libnotify-$VERSION.tar.xz"
SOURCE_URL="https://download.gnome.org/sources/libnotify/0.8/$ARCHIVE"
EXPECTED_SHA256="4be15202ec4184fce1ac15997ece5530d2be32fe9573875aeb10e3b573858748"
REPOSITORY_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
OUTPUT="${CODEX_WEB_GPT_LINUX_LIBNOTIFY_OUTPUT:-$REPOSITORY_ROOT/launcher/build/linux-libs/libnotify.so.4}"
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/codex-web-gpt-libnotify.XXXXXX")"
trap 'rm -rf "$TEMP_DIR"' EXIT HUP INT TERM

for command in curl meson ninja pkg-config sha256sum tar nm; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Preparing Linux libnotify requires $command" >&2
    exit 1
  fi
done

curl -fsSL --retry 3 --retry-all-errors --connect-timeout 15 --max-time 300 \
  "$SOURCE_URL" -o "$TEMP_DIR/$ARCHIVE"
printf '%s  %s\n' "$EXPECTED_SHA256" "$TEMP_DIR/$ARCHIVE" | sha256sum -c - >/dev/null
tar -xJf "$TEMP_DIR/$ARCHIVE" -C "$TEMP_DIR"
meson setup "$TEMP_DIR/build" "$TEMP_DIR/libnotify-$VERSION" \
  --buildtype=release \
  --strip \
  -Dtests=false \
  -Dintrospection=disabled \
  -Dman=false \
  -Dgtk_doc=false \
  -Ddocbook_docs=disabled >/dev/null
meson compile -C "$TEMP_DIR/build" >/dev/null

LIBRARY="$(find "$TEMP_DIR/build" -type f -name 'libnotify.so.4.*' -print -quit)"
if [ -z "$LIBRARY" ]; then
  echo "libnotify build produced no libnotify.so.4" >&2
  exit 1
fi
if ! nm -D --defined-only "$LIBRARY" \
  | awk '$3 == "notify_notification_get_activation_app_launch_context" { found = 1 } END { exit found ? 0 : 1 }'; then
  echo "Built libnotify does not export notify_notification_get_activation_app_launch_context" >&2
  exit 1
fi

mkdir -p "$(dirname -- "$OUTPUT")"
install -m 0755 "$LIBRARY" "$OUTPUT"
if [ -n "${GITHUB_ENV:-}" ]; then
  printf 'CODEX_WEB_GPT_LINUX_LIBNOTIFY=%s\n' "$OUTPUT" >> "$GITHUB_ENV"
fi
printf '%s\n' "$OUTPUT"
