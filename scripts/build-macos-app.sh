#!/usr/bin/env bash
set -euo pipefail

# Assembles CodexCommander.app by hand.
#
# No Xcode project, so there is nothing to keep in sync with the package manifest. The
# bundle is staged in a temp directory and moved into place at the end, so an interrupted
# build never leaves a half-written .app that launches and misbehaves.

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd "$script_dir/.." && pwd -P)"
package_dir="$repo_root/app"
output_root="${OUTPUT_DIR:-$repo_root/dist/macos}"
configuration="${CONFIGURATION:-release}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build:macos requires macOS." >&2
  exit 1
fi

die_unsafe_source() {
  echo "Refusing unsafe packaging source ($2): $1" >&2
  exit 1
}

physical_existing_path() {
  local path="$1" parent base
  parent="$(cd "$(dirname "$path")" && pwd -P)" || return 1
  base="$(basename "$path")"
  printf '%s/%s' "${parent%/}" "$base"
}

assert_within_root() {
  local path="$1" label="$2" allowed_root="$3" physical
  physical="$(physical_existing_path "$path")" || die_unsafe_source "$path" "$label"
  case "$physical" in
    "$allowed_root"|"$allowed_root"/*) ;;
    *) die_unsafe_source "$path escapes its trusted root" "$label" ;;
  esac
}

link_count() {
  stat -f '%l' "$1"
}

assert_safe_file() {
  local path="$1" label="$2" allowed_root="$3" links
  [[ ! -L "$path" ]] || die_unsafe_source "$path is a symbolic link" "$label"
  [[ -f "$path" ]] || die_unsafe_source "$path is not a regular file" "$label"
  links="$(link_count "$path")" || die_unsafe_source "$path cannot be inspected" "$label"
  [[ "$links" == "1" ]] || die_unsafe_source "$path is multiply linked" "$label"
  assert_within_root "$path" "$label" "$allowed_root"
}

assert_safe_tree() {
  local path="$1" label="$2" allowed_root="$3" entry links
  [[ ! -L "$path" ]] || die_unsafe_source "$path is a symbolic link" "$label"
  [[ -d "$path" ]] || die_unsafe_source "$path is not a physical directory" "$label"
  assert_within_root "$path" "$label" "$allowed_root"

  # -P is explicit: this must never recurse through a symlink even if a platform's
  # find default changes. The entire source tree is checked before the first copy.
  while IFS= read -r -d '' entry; do
    [[ ! -L "$entry" ]] || die_unsafe_source "$entry is a symbolic link" "$label"
    assert_within_root "$entry" "$label" "$allowed_root"
    if [[ -d "$entry" ]]; then
      continue
    fi
    [[ -f "$entry" ]] || die_unsafe_source "$entry is not a regular file" "$label"
    links="$(link_count "$entry")" || die_unsafe_source "$entry cannot be inspected" "$label"
    [[ "$links" == "1" ]] || die_unsafe_source "$entry is multiply linked" "$label"
  done < <(find -P "$path" -print0)
}

copy_verified_file() {
  local source="$1" destination="$2" label="$3" source_root="$4" destination_root="$5"
  assert_safe_file "$source" "$label" "$source_root"
  # -P is required even after validation: if a source path changes into a link between
  # lstat and copy, stage the link itself and let the post-copy assertion fail closed.
  cp -P "$source" "$destination"
  assert_safe_file "$destination" "staged $label" "$destination_root"
}

copy_verified_tree() {
  local source="$1" destination="$2" label="$3" source_root="$4" destination_root="$5"
  assert_safe_tree "$source" "$label" "$source_root"
  cp -RP "$source" "$destination"
  assert_safe_tree "$destination" "staged $label" "$destination_root"
}

# Package only physical, single-link repository inputs. This checks source roots before
# the Swift build as well as immediately around each copy, then verifies the clean staging
# tree again. A stale or compromised GUI output cannot smuggle host files into the app.
assert_safe_file "$repo_root/package.json" "package.json" "$repo_root"
assert_safe_file "$repo_root/bun.lock" "bun.lock" "$repo_root"
assert_safe_file "$repo_root/app/Info.plist" "app/Info.plist" "$repo_root"
assert_safe_file "$repo_root/gui/public/logo.png" "gui/public/logo.png" "$repo_root"
assert_safe_file "$repo_root/gui/public/favicon.png" "gui/public/favicon.png" "$repo_root"
assert_safe_file "$repo_root/LICENSE" "LICENSE" "$repo_root"
assert_safe_file "$repo_root/THIRD_PARTY_NOTICES.md" "THIRD_PARTY_NOTICES.md" "$repo_root"
assert_safe_tree "$repo_root/src" "src" "$repo_root"
assert_safe_tree "$repo_root/bin" "bin" "$repo_root"
assert_safe_tree "$repo_root/gui/dist" "gui/dist" "$repo_root"
assert_safe_tree "$repo_root/gui/public/provider-icons" "gui/public/provider-icons" "$repo_root"

# Validate BEFORE creating anything, so the script cannot leave a directory behind at a
# path it then refuses to build into.
#
# `cd … && pwd` keeps LOGICAL paths on macOS, so a symlink inside the repository that
# points elsewhere would satisfy the prefix check below and then be deleted for real.
# Resolve physically: walk up to the nearest existing ancestor, resolve that, and
# re-append the parts that do not exist yet.
resolve_physical() {
  local target="$1" part resolved
  # Absolute-ise relative input against the caller's directory.
  [[ "$target" = /* ]] || target="$PWD/$target"

  # ORDER MATTERS, and getting it wrong has been a bypass twice.
  #
  # 1. Normalise lexically FIRST. Resolving physically first and normalising afterwards
  #    lets `..` reveal a symlink that is then never physically resolved — so
  #    <repo>/.missing/../some-symlink passed containment while pointing elsewhere.
  # 2. THEN walk up to the nearest existing ancestor of the normalised path and resolve
  #    that with `pwd -P`, which follows any symlinks that survived normalisation.
  #
  # Iteration is over a quoted array, never `for part in $tail`: word splitting there
  # let a literal glob such as `rel*` expand against the filesystem.
  local -a parts=() stack=()
  local IFS=/
  read -r -a parts <<< "$target"
  unset IFS

  for part in "${parts[@]}"; do
    case "$part" in
      "" | ".") continue ;;
      "..")
        # `unset 'stack[-1]'` is a bad subscript in bash 3.2 (what macOS ships), so it
        # silently failed and `..` was never applied. Compute the index instead.
        if [[ ${#stack[@]} -gt 0 ]]; then
          unset "stack[$(( ${#stack[@]} - 1 ))]"
          stack=("${stack[@]}")
        fi
        ;;
      *) stack+=("$part") ;;
    esac
  done

  # Now resolve physically, component by component, so a symlink ANYWHERE along the
  # surviving path is followed — including one that only became reachable because a
  # `..` removed a non-existent parent above it.
  #
  # Resolving only the nearest existing ancestor is not enough: for
  # <repo>/.missing/../outward-link the ancestor is <repo>, and the trailing
  # `outward-link` symlink was re-appended unresolved and never followed.
  resolved="/"
  for part in "${stack[@]}"; do
    local candidate="${resolved%/}/$part"
    if [[ -L "$candidate" && ! -d "$candidate" ]]; then
      # A symlink that is not a directory: dangling, or pointing at a file. Following it
      # lexically was the third bypass here — a link to `../../outside` produced
      # `<repo>/../../outside`, which satisfied the `<repo>/*` prefix check and then
      # escaped during `mkdir -p`. There is no legitimate reason for OUTPUT_DIR to pass
      # through such a link, so refuse instead of trying to be clever.
      echo "Refusing to build through '$candidate': it is a symlink that does not" >&2
      echo "resolve to an existing directory." >&2
      exit 1
    fi
    if [[ -d "$candidate" ]]; then
      # `cd … && pwd -P` follows the symlink and any chain behind it.
      resolved="$(cd "$candidate" && pwd -P)"
    else
      resolved="${resolved%/}/$part"
    fi
  done
  printf '%s' "$resolved"
}

output_root="$(resolve_physical "$output_root")"
app_bundle="$output_root/CodexCommander.app"

# The build deletes whatever sits at $app_bundle, so the destination must be somewhere
# this project owns. Comparing $app_bundle against $output_root proves nothing — both
# come from the same variable, so pointing OUTPUT_DIR at /Applications would have passed
# and then recursively removed a real app.
allowed_root="$(cd "$repo_root" && pwd -P)"
if [[ -n "${TMPDIR:-}" ]]; then
  allowed_tmp="$(cd "${TMPDIR%/}" 2>/dev/null && pwd -P || echo "")"
else
  allowed_tmp=""
fi
case "$output_root" in
  "$allowed_root"/*) ;;
  /private/tmp/*|/tmp/*) ;;
  *)
    if [[ -z "$allowed_tmp" || "$output_root" != "$allowed_tmp"/* ]]; then
      echo "Refusing to build into '$output_root': it is outside the repository and the" >&2
      echo "temp directory. Set OUTPUT_DIR to a path under $repo_root." >&2
      exit 1
    fi
    ;;
esac

mkdir -p "$output_root"

swift_args=(--package-path "$package_dir" -c "$configuration" --product CodexCommanderMenuBar)

if [[ "${UNIVERSAL:-0}" == "1" ]]; then
  developer_dir="$(xcode-select -p 2>/dev/null || true)"
  if [[ "$developer_dir" == *"CommandLineTools"* ]]; then
    echo "UNIVERSAL=1 requires the full Xcode toolchain; Command Line Tools ships only" >&2
    echo "current-architecture Swift compatibility libraries, so the x86_64 slice cannot" >&2
    echo "link. Install Xcode, then:" >&2
    echo "  sudo xcode-select -s /Applications/Xcode.app/Contents/Developer" >&2
    exit 1
  fi
  swift_args+=(--arch arm64 --arch x86_64)
fi

echo "==> Building ($configuration)…"
swift build "${swift_args[@]}"
bin_dir="$(swift build "${swift_args[@]}" --show-bin-path)"
executable="$bin_dir/CodexCommanderMenuBar"

if [[ ! -x "$executable" ]]; then
  echo "Build did not produce an executable at $executable" >&2
  exit 1
fi

staging_root="$(mktemp -d "$output_root/.CodexCommander-build.XXXXXX")"
staged_app="$staging_root/CodexCommander.app"
iconset="$staging_root/CodexCommander.iconset"
cleanup() { rm -rf "$staging_root"; }
trap cleanup EXIT

mkdir -p "$staged_app/Contents/MacOS" "$staged_app/Contents/Resources"
copy_verified_file "$executable" "$staged_app/Contents/MacOS/CodexCommanderMenuBar" \
  "Swift menu-bar executable" "$bin_dir" "$staging_root"
copy_verified_file "$package_dir/Info.plist" "$staged_app/Contents/Info.plist" \
  "app/Info.plist" "$repo_root" "$staging_root"

# A release app owns the proxy runtime. Keep the package-shaped layout intact so Bun
# can resolve the existing TypeScript entrypoints, workers, and dependency graph without
# relying on the caller's checkout, PATH, npm, or a separately installed Bun. Resolve one
# lockfile-pinned production install for both Darwin architectures; the installed app never
# repeats this step or performs a first-launch network install.
runtime_root="$staged_app/Contents/Resources/runtime"
assert_safe_file "$repo_root/gui/dist/index.html" "gui/dist/index.html" "$repo_root"
mkdir -p "$runtime_root"
copy_verified_file "$repo_root/package.json" "$runtime_root/package.json" "package.json" "$repo_root" "$staging_root"
copy_verified_file "$repo_root/bun.lock" "$runtime_root/bun.lock" "bun.lock" "$repo_root" "$staging_root"
copy_verified_tree "$repo_root/src" "$runtime_root/src" "src" "$repo_root" "$staging_root"
copy_verified_tree "$repo_root/bin" "$runtime_root/bin" "bin" "$repo_root" "$staging_root"
mkdir -p "$runtime_root/gui"
copy_verified_tree "$repo_root/gui/dist" "$runtime_root/gui/dist" "gui/dist" "$repo_root" "$staging_root"

deps_root="$(mktemp -d "$staging_root/.CodexCommander-runtime-deps.XXXXXX")"
copy_verified_file "$repo_root/package.json" "$deps_root/package.json" "package.json" "$repo_root" "$staging_root"
copy_verified_file "$repo_root/bun.lock" "$deps_root/bun.lock" "bun.lock" "$repo_root" "$staging_root"
if ! (cd "$deps_root" && bun install --production --frozen-lockfile --ignore-scripts --os=darwin --cpu='*' --force >/dev/null); then
  echo "Could not resolve lockfile-pinned Darwin production dependencies." >&2
  echo "Retry the build with network access; the installed app never performs this step." >&2
  exit 1
fi
cp -R "$deps_root/node_modules" "$runtime_root/node_modules"

arm_bun="$runtime_root/node_modules/@oven/bun-darwin-aarch64/bin/bun"
x64_bun="$runtime_root/node_modules/@oven/bun-darwin-x64-baseline/bin/bun"
if [[ ! -x "$x64_bun" ]]; then
  x64_bun="$runtime_root/node_modules/@oven/bun-darwin-x64/bin/bun"
fi
if [[ ! -x "$arm_bun" || ! -x "$x64_bun" ]]; then
  echo "Darwin arm64/x86_64 Bun binaries are missing from the production install." >&2
  exit 1
fi

host_arch="$(uname -m)"
runtime_bun="$runtime_root/node_modules/bun/bin/bun.exe"
if [[ "${UNIVERSAL:-0}" == "1" ]]; then
  lipo -create "$arm_bun" "$x64_bun" -output "$runtime_bun"
else
  case "$host_arch" in
    arm64|aarch64) cp "$arm_bun" "$runtime_bun" ;;
    x86_64) cp "$x64_bun" "$runtime_bun" ;;
    *) echo "Unsupported macOS host architecture: $host_arch" >&2; exit 1 ;;
  esac
fi
chmod 755 "$runtime_bun"
rm -f "$runtime_root/node_modules/bun/bin/bunx" "$runtime_root/node_modules/bun/bin/bunx.exe" \
  "$runtime_root/node_modules/.bin/bunx"
ln -s bun.exe "$runtime_root/node_modules/bun/bin/bunx.exe"

keyring_version="$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)",/\1/p' \
  "$runtime_root/node_modules/@napi-rs/keyring/package.json" | head -n 1)"
for keyring_package in keyring-darwin-arm64 keyring-darwin-x64; do
  keyring_meta="$runtime_root/node_modules/@napi-rs/$keyring_package/package.json"
  keyring_binary="$runtime_root/node_modules/@napi-rs/$keyring_package/keyring.darwin-${keyring_package##*-}.node"
  if [[ ! -f "$keyring_binary" || ! -f "$keyring_meta" ]]; then
    echo "Missing bundled keyring slice: $keyring_package" >&2
    exit 1
  fi
  slice_version="$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)",/\1/p' "$keyring_meta" | head -n 1)"
  if [[ -z "$keyring_version" || "$slice_version" != "$keyring_version" ]]; then
    echo "Bundled keyring version mismatch for $keyring_package (expected $keyring_version, got $slice_version)." >&2
    exit 1
  fi
done

# The materialized Bun executable above is the only runtime entrypoint. Drop the three
# architecture payload packages after lipo/copy so the app does not carry ~190 MB of
# duplicate Bun slices that no resolver can select at runtime.
for bun_slice_package in bun-darwin-aarch64 bun-darwin-x64 bun-darwin-x64-baseline; do
  rm -rf "$runtime_root/node_modules/@oven/$bun_slice_package"
  if [[ -e "$runtime_root/node_modules/@oven/$bun_slice_package" ]]; then
    echo "Failed to remove duplicate Bun slice package: $bun_slice_package" >&2
    exit 1
  fi
done

runtime_architectures="$(lipo -archs "$runtime_bun")"
if [[ "${UNIVERSAL:-0}" == "1" ]]; then
  for required_arch in arm64 x86_64; do
    if [[ " $runtime_architectures " != *" $required_arch "* ]]; then
      echo "Universal bundled Bun is missing $required_arch (got: $runtime_architectures)" >&2
      exit 1
    fi
  done
fi
if [[ ! -f "$runtime_root/bin/ccx.mjs" \
  || ! -f "$runtime_root/src/cli/index.ts" \
  || ! -f "$runtime_root/gui/dist/index.html" ]]; then
  echo "Bundled CodexCommander runtime is incomplete under $runtime_root." >&2
  exit 1
fi

# Reuse the dashboard's real brand/provider assets. The AppKit surface loads these
# files directly; no duplicate drawn logos or generated placeholders live in app/.
mkdir -p "$staged_app/Contents/Resources"
copy_verified_file "$repo_root/gui/public/logo.png" "$staged_app/Contents/Resources/CodexCommander.png" \
  "gui/public/logo.png" "$repo_root" "$staging_root"
copy_verified_file "$repo_root/LICENSE" "$staged_app/Contents/Resources/LICENSE.txt" \
  "LICENSE" "$repo_root" "$staging_root"
copy_verified_file "$repo_root/THIRD_PARTY_NOTICES.md" "$staged_app/Contents/Resources/THIRD_PARTY_NOTICES.md" \
  "THIRD_PARTY_NOTICES.md" "$repo_root" "$staging_root"
# Quota responses are provider-agnostic, so package the complete existing icon set.
# Copying only the three featured rows made every additional connected provider fall
# back to a question mark in release builds even though its real asset existed in-repo.
copy_verified_tree "$repo_root/gui/public/provider-icons" \
  "$staged_app/Contents/Resources/provider-icons" "gui/public/provider-icons" "$repo_root" "$staging_root"

# Re-check the copied release inputs as a coherent fresh stage. This is intentionally
# before dependency installation: package-manager node_modules legitimately contains a
# small number of executable shim links, while application-owned source assets do not.
assert_safe_tree "$runtime_root/src" "staged runtime src" "$staging_root"
assert_safe_file "$runtime_root/src/skills/codexcommander-delegation/SKILL.md" \
  "staged delegation skill" "$staging_root"
assert_safe_tree "$runtime_root/bin" "staged runtime bin" "$staging_root"
assert_safe_tree "$runtime_root/gui/dist" "staged runtime gui/dist" "$staging_root"
assert_safe_tree "$staged_app/Contents/Resources/provider-icons" "staged provider icons" "$staging_root"

# The app version comes from package.json, so it can never claim a version the release
# did not ship.
version="$(sed -n 's/^[[:space:]]*"version": "\([^"]*\)",/\1/p' "$repo_root/package.json" | head -n 1)"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "Could not read a valid version from package.json: '$version'" >&2
  exit 1
fi

# Apple constrains BOTH version fields, and differently from the npm version string:
#
#   CFBundleShortVersionString - three period-separated integers. A prerelease suffix
#                                like "-preview.1" is not valid here.
#   CFBundleVersion            - ONE TO THREE period-separated integers. A fourth
#                                component is ignored, so appending a build number to a
#                                full semver produces no additional identity at all.
#
# So the short version is the numeric core, and when CI supplies a run number it becomes
# the CFBundleVersion outright — a monotonically increasing single integer is both valid
# and genuinely distinguishing, which "0.1.0.<run>" would not be.
version_core="${version%%-*}"
if [[ ! "$version_core" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Version core must be three integers for CFBundleShortVersionString: '$version_core'" >&2
  exit 1
fi

if [[ -n "${MACOS_BUILD_NUMBER:-}" ]]; then
  if [[ ! "$MACOS_BUILD_NUMBER" =~ ^[0-9]+$ ]]; then
    echo "MACOS_BUILD_NUMBER must be a positive integer, got '$MACOS_BUILD_NUMBER'" >&2
    exit 1
  fi
  build_version="$MACOS_BUILD_NUMBER"
else
  build_version="$version_core"
fi
if [[ ! "$build_version" =~ ^[0-9]+(\.[0-9]+){0,2}$ ]]; then
  echo "CFBundleVersion must be one to three integers, got '$build_version'" >&2
  exit 1
fi

plutil -replace CFBundleShortVersionString -string "$version_core" "$staged_app/Contents/Info.plist"
plutil -replace CFBundleVersion            -string "$build_version" "$staged_app/Contents/Info.plist"

# Same-version bundles can coexist when contributors build from multiple worktrees.
# Stamp the exact source revision so diagnostics can distinguish them without relying
# on the bundle path or a release version shared by both copies. A dirty suffix is
# deliberate: claiming the HEAD commit for uncommitted source would be false provenance.
source_revision="${CCX_BUILD_REVISION:-}"
if [[ -z "$source_revision" ]]; then
  source_revision="$(git -C "$repo_root" rev-parse --verify HEAD 2>/dev/null || true)"
  # `git diff` ignores untracked source files. Porcelain status covers staged,
  # unstaged, and untracked (but not ignored build output), so `-dirty` cannot
  # falsely claim that a newly added source file belongs to HEAD.
  if [[ -n "$source_revision" ]] \
    && [[ -n "$(git -C "$repo_root" status --porcelain --untracked-files=normal 2>/dev/null)" ]]; then
    source_revision="${source_revision}-dirty"
  fi
fi
if [[ -z "$source_revision" ]]; then
  source_revision="unknown"
elif [[ ! "$source_revision" =~ ^[0-9a-fA-F]{40}(-dirty)?$ ]]; then
  echo "CCX_BUILD_REVISION must be a 40-character git SHA with optional -dirty suffix." >&2
  exit 1
fi
if ! plutil -replace CodexCommanderSourceRevision -string "$source_revision" "$staged_app/Contents/Info.plist" 2>/dev/null; then
  plutil -insert CodexCommanderSourceRevision -string "$source_revision" "$staged_app/Contents/Info.plist"
fi

# Icon: reuse the dashboard favicon rather than adding another binary asset to the repo.
icon_source="$repo_root/gui/public/favicon.png"
if [[ ! -f "$icon_source" ]]; then
  echo "Missing icon source: $icon_source" >&2
  exit 1
fi
mkdir -p "$iconset"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$icon_source" \
    --out "$iconset/icon_${size}x${size}.png" >/dev/null
  sips -z "$((size * 2))" "$((size * 2))" "$icon_source" \
    --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$iconset" -o "$staged_app/Contents/Resources/CodexCommander.icns"

# Signing. Sign nested Mach-O payloads first and the bundle last. This order is
# deterministic for Developer ID/notarization and avoids relying on codesign --deep
# to discover or repair nested code implicitly.
#
# MACOS_SIGN_IDENTITY selects a Developer ID Application certificate already present in
# the caller's keychain and enables the hardened runtime, which is what notarization
# requires. It is a LOCAL hook: CI does not set it, because an identity name alone
# cannot sign on a hosted runner — nothing imports the certificate and private key, so
# codesign fails with "no identity found". Wiring CI signing properly means a protected
# P12 import, a temporary keychain, notarytool credentials, and stapling.
#
# Without it the bundle is ad-hoc signed: structurally valid, but `spctl --assess`
# rejects it and a downloaded copy shows "cannot be opened because the developer cannot
# be verified". The project has no Developer ID certificate today, so ad-hoc is what
# ships and the docs must carry the right-click-Open path rather than pretend
# otherwise.
nested_code=(
  "$runtime_bun"
  "$runtime_root/node_modules/@napi-rs/keyring-darwin-arm64/keyring.darwin-arm64.node"
  "$runtime_root/node_modules/@napi-rs/keyring-darwin-x64/keyring.darwin-x64.node"
  "$staged_app/Contents/MacOS/CodexCommanderMenuBar"
)

if [[ -n "${MACOS_SIGN_IDENTITY:-}" ]]; then
  for code_path in "${nested_code[@]}"; do
    codesign --force --options runtime --timestamp --sign "$MACOS_SIGN_IDENTITY" "$code_path"
    codesign --verify --strict --verbose=2 "$code_path"
  done
  codesign --force --options runtime --timestamp --sign "$MACOS_SIGN_IDENTITY" "$staged_app"
  echo "==> Signed with $MACOS_SIGN_IDENTITY (hardened runtime)"
else
  for code_path in "${nested_code[@]}"; do
    codesign --force --sign - --timestamp=none "$code_path"
    codesign --verify --strict --verbose=2 "$code_path"
  done
  codesign --force --sign - --timestamp=none "$staged_app"
  echo "==> Ad-hoc signed (no MACOS_SIGN_IDENTITY): Gatekeeper will require the" >&2
  echo "    right-click-Open path on first launch." >&2
fi

if [[ -L "$app_bundle" ]]; then
  echo "Refusing to replace '$app_bundle': it is a symlink." >&2
  exit 1
fi
rm -rf "$app_bundle"
mv "$staged_app" "$app_bundle"

echo "==> Built $app_bundle (release $version, short $version_core, build $build_version, source $source_revision)"
lipo -archs "$app_bundle/Contents/MacOS/CodexCommanderMenuBar"
