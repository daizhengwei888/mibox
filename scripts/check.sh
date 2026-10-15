#!/usr/bin/env sh
# 不需要安装任何依赖的检查：所有脚本能被解析、单元测试通过。
set -e
cd "$(dirname "$0")/.."
find extension -name '*.js' -print0 | xargs -0 -n 1 node --check
node --test tests/unit/*.test.mjs
