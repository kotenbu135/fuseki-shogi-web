#!/bin/bash
# cppshogi（布石フェーズのmovegen・特徴量抽出）をWebAssemblyへビルドする。
#
#   source ~/emsdk/emsdk_env.sh && web/wasm/build.sh
#
# ロジックはengine/dlshogi/cppshogiのソースをそのまま使う。ブラウザ用にTypeScriptで
# 書き直すと、62プレーンの特徴量（利き数を含む）や禁じ手判定がC++版と静かにズレて
# 方策が劣化するため、同じコードをコンパイルする方針を取っている。
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
C="$HERE/../engine/dlshogi/cppshogi"
OUT="${1:-$HERE/dist}"
mkdir -p "$OUT"

SRC=(
  "$C/cppshogi.cpp" "$C/python_module.cpp" "$C/bitboard.cpp" "$C/book.cpp" "$C/common.cpp"
  "$C/fuseki.cpp" "$C/generateMoves.cpp" "$C/hand.cpp" "$C/init.cpp" "$C/move.cpp"
  "$C/mt64bit.cpp" "$C/position.cpp" "$C/search.cpp" "$C/square.cpp" "$C/usi.cpp"
)

# em++ を使う（emccだとlibc++がリンクされず operator new が未定義になる）。
# -msimd128 でEmscriptenのSSEエミュレーションを有効にし、足りないPOPCNT組み込み関数だけ
# wasm_shim.h で埋める。FP16は定義しない（定義するとcuda_fp16.hを要求する）。
em++ -std=c++17 -O2 -msimd128 -msse4.2 -mavx2 \
  -include "$HERE/wasm_shim.h" \
  -DHAVE_SSE4 -DHAVE_SSE42 -DHAVE_AVX2 \
  -I"$C" \
  -s MODULARIZE=1 -s EXPORT_ES6=1 -s EXPORT_NAME=FusekiModule \
  -s ALLOW_MEMORY_GROWTH=1 -s ENVIRONMENT=web,worker,node \
  -s EXPORTED_RUNTIME_METHODS=ccall,cwrap,HEAPF32,HEAP32,UTF8ToString,stringToNewUTF8 \
  "$HERE/fuseki_wasm.cpp" "${SRC[@]}" \
  -o "$OUT/fuseki.mjs"

# Workers（worker/src/judge.js）向けのグルー。同じ .wasm で JS だけ ENVIRONMENT=web にする。
# web,worker,node のグルーは wrangler dev/workerd で node と誤認し、import.meta.url が無くて
# 起動時に落ちる（実際に落ちた）。.wasm は上と同じ物になるので、確かめて片方だけ残す。
em++ -std=c++17 -O2 -msimd128 -msse4.2 -mavx2 \
  -include "$HERE/wasm_shim.h" \
  -DHAVE_SSE4 -DHAVE_SSE42 -DHAVE_AVX2 \
  -I"$C" \
  -s MODULARIZE=1 -s EXPORT_ES6=1 -s EXPORT_NAME=FusekiModule \
  -s ALLOW_MEMORY_GROWTH=1 -s ENVIRONMENT=web \
  -s EXPORTED_RUNTIME_METHODS=ccall,cwrap,HEAPF32,HEAP32,UTF8ToString,stringToNewUTF8 \
  "$HERE/fuseki_wasm.cpp" "${SRC[@]}" \
  -o "$OUT/fuseki-worker.mjs"
if cmp -s "$OUT/fuseki.wasm" "$OUT/fuseki-worker.wasm"; then
  rm "$OUT/fuseki-worker.wasm"
  sed -i 's/fuseki-worker\.wasm/fuseki.wasm/g' "$OUT/fuseki-worker.mjs"
else
  echo "警告: fuseki-worker.wasm が fuseki.wasm と一致しない。両方残す" >&2
fi

ls -la "$OUT"
