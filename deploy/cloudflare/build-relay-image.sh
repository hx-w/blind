#!/bin/sh
set -eu

relay_source=${1:?usage: build-relay-image.sh /path/to/deepshape-ai/relay}
expected_ref=e369f1fdce5b8c9807f14dbd748aaa032ab1e9e3
image=blind-sso-relay:e369f1fdce5b

actual_ref=$(git -C "$relay_source" rev-parse HEAD)
if [ "$actual_ref" != "$expected_ref" ]; then
    echo "relay source must be exactly $expected_ref; got $actual_ref" >&2
    exit 1
fi
if [ -n "$(git -C "$relay_source" status --porcelain)" ]; then
    echo "relay source has uncommitted changes; refusing an unreproducible build" >&2
    exit 1
fi

docker build --platform linux/amd64 --tag "$image" "$relay_source"
