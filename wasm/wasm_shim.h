// EmscriptenのSSE4.2エミュレーションには POPCNT 命令（_mm_popcnt_u64）が無い。
// POPCNTはSSE4.2とは別のISA拡張のため、nmmintrin.hに含まれていない。
// cppshogi/common.hpp の count1s() がこれを使うので、組み込み関数で埋める。
#pragma once
#include <cstdint>
#include <nmmintrin.h>
#ifndef _mm_popcnt_u64
static inline uint64_t _mm_popcnt_u64(uint64_t x) { return __builtin_popcountll(x); }
#endif
