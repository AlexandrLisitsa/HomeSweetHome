#!/bin/sh
# Build Homepage from its release tag, on the workstation, into
# Portal/.build/homepage-<version>.tar.gz.
#
#   sh Portal/tools/build_homepage.sh            # the version in deploy/_lxc_env.sh
#
# Why here and not in the LXC: a Next.js build wants 2+ GB of RAM and the
# Proxmox host has well under 1 GB free. The output is Next's "standalone"
# server -- plain JavaScript, no native modules -- so it runs on the box's Node.
#
# Needs Docker (Docker Desktop on Windows). Nothing is mounted: the source goes
# in on stdin and the build comes out on stdout, so it works from Git Bash
# without path translation. Same base image as Homepage's own Dockerfile.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
. "$here/../deploy/_lxc_env.sh"

out_dir="$here/../.build"
out="$out_dir/homepage-$HOMEPAGE_VERSION.tar.gz"
mkdir -p "$out_dir"

if [ -s "$out" ]; then
    echo "already built: $out"
    exit 0
fi

src="https://github.com/gethomepage/homepage/archive/refs/tags/$HOMEPAGE_VERSION.tar.gz"
echo "building Homepage $HOMEPAGE_VERSION (a few minutes)..."

curl -fsSL "$src" | docker run --rm -i \
    -e VERSION="$HOMEPAGE_VERSION" \
    node:22-slim sh -c '
set -e
mkdir /src && cd /src
tar xzf - --strip-components=1
corepack enable >&2
corepack prepare pnpm@latest --activate >&2
pnpm install --frozen-lockfile >&2
NEXT_TELEMETRY_DISABLED=1 NEXT_PUBLIC_VERSION="$VERSION" pnpm run build >&2
# The layout Homepage'"'"'s image uses: standalone server + static + public.
mkdir /out
cp -a .next/standalone/. /out/
cp -a .next/static /out/.next/static
cp -a public /out/public
echo "$VERSION" > /out/VERSION
tar czf - -C /out --owner=0 --group=0 --numeric-owner .
' > "$out.part"

mv "$out.part" "$out"
echo "built: $out ($(du -h "$out" | cut -f1))"
