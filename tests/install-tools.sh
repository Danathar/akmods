#!/usr/bin/env bash
# Installs the pinned `just` and `yq` binaries used by the unit and e2e tests
# into a directory (default: $HOME/.local/bin) after verifying their SHA-256.
#
# Why pinned and not the distro packages:
#   * The Justfile calls `which()`, which `just` >= 1.57 rejects without
#     `set lists` ("the `which()` function requires `set lists`"). 1.46.0 is
#     the newest release verified to evaluate this Justfile.
#   * The Justfile passes `--yaml-fix-merge-anchor-to-spec` to yq, which only
#     mikefarah/yq (Go) understands, and only in recent releases.
#
# Usage: tests/install-tools.sh [dest-dir]
set -euo pipefail

JUST_VERSION="1.46.0"
JUST_SHA256="79966e6e353f535ee7d1c6221641bcc8e3381c55b0d0a6dc6e54b34f9db36eaa"
YQ_VERSION="v4.54.1"
YQ_SHA256="8e34fc298390875de416e6a4afcb8cabeceb25d9aa8506c1a2f9353cf702ea5f"

if [[ "$(uname -s)-$(uname -m)" != "Linux-x86_64" ]]; then
    echo "install-tools.sh only has pinned checksums for linux/x86_64." >&2
    exit 1
fi

dest="${1:-${HOME}/.local/bin}"
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
mkdir -p "${dest}"

curl -fsSL -o "${work}/just.tar.gz" \
    "https://github.com/casey/just/releases/download/${JUST_VERSION}/just-${JUST_VERSION}-x86_64-unknown-linux-musl.tar.gz"
echo "${JUST_SHA256}  ${work}/just.tar.gz" | sha256sum -c -
tar -xzf "${work}/just.tar.gz" -C "${work}" just
install -m 0755 "${work}/just" "${dest}/just"

curl -fsSL -o "${work}/yq" \
    "https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}/yq_linux_amd64"
echo "${YQ_SHA256}  ${work}/yq" | sha256sum -c -
install -m 0755 "${work}/yq" "${dest}/yq"

echo "Installed just ${JUST_VERSION} and yq ${YQ_VERSION} into ${dest}"
