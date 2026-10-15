#!/usr/bin/env sh
# 打包可以直接加载、或发给别人的插件 zip：只包含 extension/ 里的文件。
# 用法：sh scripts/pack.sh          → dist/mibox-<版本号>.zip
set -e
cd "$(dirname "$0")/.."
VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' extension/manifest.json | head -n 1)
mkdir -p dist
OUT="dist/mibox-$VERSION.zip"
rm -f "$OUT"
(cd extension && zip -qr -X "../$OUT" . -x '.*')
echo "$OUT"
