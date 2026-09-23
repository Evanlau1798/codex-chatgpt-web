#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "Usage: smoke-linux-appimage-symbols.sh /absolute/path/to.AppImage" >&2
  exit 64
fi
APPIMAGE_PATH="$1"
case "$APPIMAGE_PATH" in
  /*) ;;
  *) echo "AppImage smoke requires an absolute path" >&2; exit 64 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) ELF_MACHINE="Advanced Micro Devices X86-64" ;;
  aarch64|arm64) ELF_MACHINE="AArch64" ;;
  *) echo "Unsupported Linux AppImage architecture: $(uname -m)" >&2; exit 1 ;;
esac
require_native_elf() {
  header="$(LC_ALL=C readelf -h "$1")"
  if ! printf '%s\n' "$header" | grep -Eq 'Class:[[:space:]]+ELF64' \
    || ! printf '%s\n' "$header" | grep -Eq "Machine:[[:space:]]+$ELF_MACHINE[[:space:]]*$"; then
    echo "Expected $ELF_MACHINE ELF64 binary: $1" >&2
    exit 1
  fi
}
require_native_elf "$APPIMAGE_PATH"
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/codex-web-gpt-appimage-smoke.XXXXXX")"
trap 'rm -rf "$TEMP_DIR"' EXIT HUP INT TERM
SMOKE_APPIMAGE="$TEMP_DIR/$(basename -- "$APPIMAGE_PATH")"
cp "$APPIMAGE_PATH" "$SMOKE_APPIMAGE"
chmod 0755 "$SMOKE_APPIMAGE"
(
  cd "$TEMP_DIR"
  "$SMOKE_APPIMAGE" --appimage-extract >/dev/null
)
APP_DIR="$TEMP_DIR/squashfs-root"
LIBNOTIFY="$(find "$APP_DIR" -type f -name 'libnotify.so.4' -print -quit)"
if [ -z "$LIBNOTIFY" ]; then
  echo "Final AppImage contains no libnotify.so.4" >&2
  exit 1
fi
require_native_elf "$LIBNOTIFY"
if ! nm -D --defined-only "$LIBNOTIFY" \
  | awk '$3 == "notify_notification_get_activation_app_launch_context" { found = 1 } END { exit found ? 0 : 1 }'; then
  echo "Final AppImage libnotify is missing notify_notification_get_activation_app_launch_context" >&2
  exit 1
fi

EXECUTABLE=""
for candidate in "$APP_DIR"/*; do
  [ -f "$candidate" ] && [ -x "$candidate" ] || continue
  case "$(basename -- "$candidate")" in
    AppRun|chrome-sandbox|chrome_crashpad_handler) continue ;;
  esac
  if file "$candidate" | grep -q 'ELF .* executable'; then
    EXECUTABLE="$candidate"
    break
  fi
done
if [ -z "$EXECUTABLE" ]; then
  echo "Final AppImage contains no launcher executable" >&2
  exit 1
fi
require_native_elf "$EXECUTABLE"
require_native_elf "$APP_DIR/resources/runtime/runtime/bun"
if ! RESOLUTION="$(LD_LIBRARY_PATH="$(dirname -- "$LIBNOTIFY")" ldd -r "$EXECUTABLE" 2>&1)"; then
  printf '%s\n' "$RESOLUTION" >&2
  echo "Final AppImage dynamic dependency inspection failed" >&2
  exit 1
fi
if printf '%s\n' "$RESOLUTION" | grep -Eq 'undefined symbol:|not found'; then
  printf '%s\n' "$RESOLUTION" >&2
  echo "Final AppImage has unresolved dynamic dependencies" >&2
  exit 1
fi
printf 'LINUX_APPIMAGE_SYMBOL_SMOKE_OK %s\n' "$LIBNOTIFY"
