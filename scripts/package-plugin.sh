#!/usr/bin/env bash
set -euo pipefail

version="${1:?usage: package-plugin.sh <version> [output-directory]}"
output_dir="${2:-${OUTPUT_DIR:-}}"
root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="${version#v}"

if [[ -z "$output_dir" ]]; then
  echo 'set an output directory outside the project volume (for example $RUNNER_TEMP/chengying-release)' >&2
  exit 2
fi

mkdir -p "$output_dir"
release_ref="${RELEASE_REF:-v${version}}"
git -C "$root_dir" rev-parse --verify "${release_ref}^{commit}" >/dev/null

zip_path="$output_dir/Chengying-source-${version}.zip"
tar_path="$output_dir/Chengying-source-${version}.tar.gz"
git -C "$root_dir" archive --format=zip --prefix="chengying-${version}/" --output="$zip_path" "$release_ref"
git -C "$root_dir" archive --format=tar.gz --prefix="chengying-${version}/" --output="$tar_path" "$release_ref"

# Write the checksums with bare file names: the file is published as a release
# asset, and `sha256sum -c` only works when the paths are relative to where the
# user downloaded the archives (`/home/runner/work/...` entries made every
# source archive unverifiable).
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$output_dir" && sha256sum "$(basename "$zip_path")" "$(basename "$tar_path")") > "$output_dir/SHA256SUMS"
else
  (cd "$output_dir" && shasum -a 256 "$(basename "$zip_path")" "$(basename "$tar_path")") > "$output_dir/SHA256SUMS"
fi

printf 'Packaged %s\n' "$zip_path"
printf 'Packaged %s\n' "$tar_path"
