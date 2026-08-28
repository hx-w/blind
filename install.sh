#!/bin/sh
set -eu

repo="hx-w/blind"
version="${BLIND_VERSION:-latest}"

if [ "$(/usr/bin/uname -s)" != "Darwin" ]; then
  echo "blind: only macOS is supported by this release" >&2
  exit 1
fi

case "$(/usr/bin/uname -m)" in
  arm64) target="aarch64-apple-darwin" ;;
  x86_64) target="x86_64-apple-darwin" ;;
  *) echo "blind: unsupported architecture: $(/usr/bin/uname -m)" >&2; exit 1 ;;
esac

if [ "$version" = "latest" ]; then
  release_path="latest/download"
else
  tag="${version#v}"
  case "$tag" in
    ""|*[!0-9.]*) echo "blind: BLIND_VERSION must be latest or a version such as 0.1.0" >&2; exit 1 ;;
  esac
  saved_ifs="$IFS"
  IFS=.
  set -- $tag
  IFS="$saved_ifs"
  if [ "$#" -ne 3 ] || [ -z "$1" ] || [ -z "$2" ] || [ -z "$3" ] || [ "$tag" != "$1.$2.$3" ]; then
    echo "blind: BLIND_VERSION must be latest or a version such as 0.1.0" >&2
    exit 1
  fi
  version="v$1.$2.$3"
  release_path="download/$version"
fi

asset="blind-$target.tar.gz"
base_url="https://github.com/$repo/releases/$release_path"

if [ -n "${BLIND_INSTALL_DIR:-}" ]; then
  install_dir="$BLIND_INSTALL_DIR"
elif command -v blind >/dev/null 2>&1; then
  install_dir="$(/usr/bin/dirname "$(command -v blind)")"
elif [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then
  install_dir="/usr/local/bin"
elif [ -d /opt/homebrew/bin ] && [ -w /opt/homebrew/bin ]; then
  install_dir="/opt/homebrew/bin"
else
  install_dir="$HOME/.local/bin"
fi

/bin/mkdir -p "$install_dir"
install_dir="$(cd "$install_dir" && /bin/pwd -P)"
destination="$install_dir/blind"
if [ -L "$destination" ] && [ ! -e "$destination" ]; then
  echo "blind: refusing to replace dangling symlink $destination" >&2
  exit 1
fi
if [ -e "$destination" ]; then
  destination="$(/usr/bin/readlink -f "$destination")"
  install_dir="$(/usr/bin/dirname "$destination")"
fi
if [ ! -w "$install_dir" ]; then
  echo "blind: $install_dir is not writable; set BLIND_INSTALL_DIR to a writable PATH directory" >&2
  exit 1
fi

lock_file=""
lock_owned=0
staged=""
temp_dir=""
cleanup() {
  if [ "$lock_owned" -eq 1 ]; then
    /bin/rm -f "$lock_file"
  fi
  if [ -n "$staged" ]; then
    /bin/rm -f "$staged"
  fi
  if [ -n "$temp_dir" ]; then
    /bin/rm -rf "$temp_dir"
  fi
}
trap cleanup EXIT HUP INT TERM

lock_file="$install_dir/.blind.update.lock"
if ! /usr/bin/shlock -f "$lock_file" -p "$$"; then
  echo "blind: another install or update is already running" >&2
  exit 1
fi
lock_owned=1

temp_parent="$(/usr/bin/getconf DARWIN_USER_TEMP_DIR)"
temp_dir="$(/usr/bin/mktemp -d "$temp_parent/blind-install.XXXXXX")"

echo "blind: downloading $asset"
/usr/bin/curl --disable -fL --retry 3 --proto '=https' --proto-redir '=https' --tlsv1.2 \
  --connect-timeout 15 --max-time 300 --max-filesize 268435456 \
  "$base_url/$asset" -o "$temp_dir/$asset"
/usr/bin/curl --disable -fL --retry 3 --proto '=https' --proto-redir '=https' --tlsv1.2 \
  --connect-timeout 15 --max-time 300 --max-filesize 1048576 \
  "$base_url/SHA256SUMS" -o "$temp_dir/SHA256SUMS"

expected="$(/usr/bin/awk -v name="$asset" '$2 == name { print $1 }' "$temp_dir/SHA256SUMS")"
actual="$(/usr/bin/shasum -a 256 "$temp_dir/$asset" | /usr/bin/awk '{ print $1 }')"
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  echo "blind: checksum verification failed" >&2
  exit 1
fi

/bin/mkdir "$temp_dir/unpack"
if ! /usr/bin/tar -tzf "$temp_dir/$asset" | /usr/bin/awk '
  NR == 1 && $0 == "blind" { next }
  { exit 1 }
  END { if (NR != 1) exit 1 }
'; then
  echo "blind: unexpected release archive contents" >&2
  exit 1
fi
if ! /usr/bin/tar -tvzf "$temp_dir/$asset" | /usr/bin/awk '
  NR == 1 && substr($0, 1, 1) == "-" { next }
  { exit 1 }
  END { if (NR != 1) exit 1 }
'; then
  echo "blind: release archive does not contain a regular file" >&2
  exit 1
fi
(ulimit -f 262144; /usr/bin/tar -xzf "$temp_dir/$asset" -C "$temp_dir/unpack")
if [ ! -f "$temp_dir/unpack/blind" ] || [ -L "$temp_dir/unpack/blind" ]; then
  echo "blind: release archive does not contain a regular blind binary" >&2
  exit 1
fi

staged="$(/usr/bin/mktemp "$install_dir/.blind.install.XXXXXX")"
/usr/bin/install -m 0755 "$temp_dir/unpack/blind" "$staged"
/bin/mv -f "$staged" "$destination"
staged=""

installed_version="$($destination --version)"
echo "blind: installed $installed_version to $destination"
case ":$PATH:" in
  *":$install_dir:"*) ;;
  *) echo "blind: add $install_dir to PATH" ;;
esac
