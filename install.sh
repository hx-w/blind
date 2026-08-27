#!/bin/sh
set -eu

repo="hx-w/blind"
version="${BLIND_VERSION:-latest}"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "blind: only macOS is supported by this release" >&2
  exit 1
fi

case "$(uname -m)" in
  arm64) target="aarch64-apple-darwin" ;;
  x86_64) target="x86_64-apple-darwin" ;;
  *) echo "blind: unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

case "$version" in
  latest) release_path="latest/download" ;;
  v[0-9]*.[0-9]*.[0-9]*) release_path="download/$version" ;;
  [0-9]*.[0-9]*.[0-9]*) version="v$version"; release_path="download/$version" ;;
  *) echo "blind: BLIND_VERSION must be latest or a version such as 0.1.0" >&2; exit 1 ;;
esac

asset="blind-$target.tar.gz"
base_url="https://github.com/$repo/releases/$release_path"
temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/blind-install.XXXXXX")"
trap 'rm -rf "$temp_dir"' EXIT HUP INT TERM

echo "blind: downloading $asset"
curl -fL --retry 3 --proto '=https' --tlsv1.2 "$base_url/$asset" -o "$temp_dir/$asset"
curl -fL --retry 3 --proto '=https' --tlsv1.2 "$base_url/SHA256SUMS" -o "$temp_dir/SHA256SUMS"

expected="$(awk -v name="$asset" '$2 == name { print $1 }' "$temp_dir/SHA256SUMS")"
actual="$(shasum -a 256 "$temp_dir/$asset" | awk '{ print $1 }')"
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  echo "blind: checksum verification failed" >&2
  exit 1
fi

mkdir "$temp_dir/unpack"
archive_entries="$(tar -tzf "$temp_dir/$asset")"
if [ "$archive_entries" != "blind" ]; then
  echo "blind: unexpected release archive contents" >&2
  exit 1
fi
tar -xzf "$temp_dir/$asset" -C "$temp_dir/unpack"
if [ ! -f "$temp_dir/unpack/blind" ] || [ -L "$temp_dir/unpack/blind" ]; then
  echo "blind: release archive does not contain a regular blind binary" >&2
  exit 1
fi

if [ -n "${BLIND_INSTALL_DIR:-}" ]; then
  install_dir="$BLIND_INSTALL_DIR"
elif command -v blind >/dev/null 2>&1; then
  install_dir="$(dirname "$(command -v blind)")"
elif [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then
  install_dir="/usr/local/bin"
elif [ -d /opt/homebrew/bin ] && [ -w /opt/homebrew/bin ]; then
  install_dir="/opt/homebrew/bin"
else
  install_dir="$HOME/.local/bin"
fi

mkdir -p "$install_dir"
if [ ! -w "$install_dir" ]; then
  echo "blind: $install_dir is not writable; set BLIND_INSTALL_DIR to a writable PATH directory" >&2
  exit 1
fi

destination="$install_dir/blind"
staged="$install_dir/.blind.install.$$"
install -m 0755 "$temp_dir/unpack/blind" "$staged"
mv -f "$staged" "$destination"

installed_version="$($destination --version)"
echo "blind: installed $installed_version to $destination"
case ":$PATH:" in
  *":$install_dir:"*) ;;
  *) echo "blind: add $install_dir to PATH" ;;
esac
