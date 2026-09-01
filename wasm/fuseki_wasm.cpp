// 布石フェーズのmovegen・特徴量抽出をブラウザへ持ち込むためのC ABIラッパ。
// ロジックは一切書かず、Python拡張(python_module.cpp)が公開しているのと同じ
// __fuseki_* 関数をそのまま呼ぶ。C++とJSで実装が二重化しないようにするため。
//
// embindではなく素のC ABIにしているのは、(1) embindのRTTI版がリンクで
// typeinfoを要求して面倒、(2) 特徴量はHEAPF32のビューをJSに直接渡した方が
// コピーが1回減る、の2点による。
#include <cstring>
#include <string>
#include <emscripten/emscripten.h>
#include "cppshogi.h"
#include "fuseki.hpp"

void init();
void __fuseki_reset();
int __fuseki_legal_drops(int* outPieceTypes, int* outSquares, int maxCount);
void __fuseki_do_drop(int pieceType, int square);
bool __fuseki_is_placement_done();
int __fuseki_turn();
int __fuseki_ply();
bool __fuseki_is_king_attacked(int color);
int __fuseki_remaining(int color, int pieceType);
std::string __fuseki_to_sfen();
bool __fuseki_verify_final_sfen(const std::string& sfen);
void __fuseki_make_input_features(char* ndfeatures1, char* ndfeatures2);
int __fuseki_move_label(int pieceType, int square, int color);
int __fuseki_compact_label(int pieceType, int square, int color);
bool __fuseki_parse_usi_move(const std::string& moveStr, int* outPieceType, int* outSquare);

namespace {
    features1_t g_features1;
    features2_t g_features2;
    int g_pts[2048], g_sqs[2048];
    char g_str[256];
    bool g_initialized = false;
}

extern "C" {

EMSCRIPTEN_KEEPALIVE void fw_init() { if (!g_initialized) { init(); g_initialized = true; } }
EMSCRIPTEN_KEEPALIVE void fw_reset() { fw_init(); __fuseki_reset(); }
EMSCRIPTEN_KEEPALIVE int fw_legal_drops() { return __fuseki_legal_drops(g_pts, g_sqs, 2048); }
EMSCRIPTEN_KEEPALIVE int* fw_drops_pt_ptr() { return g_pts; }
EMSCRIPTEN_KEEPALIVE int* fw_drops_sq_ptr() { return g_sqs; }
EMSCRIPTEN_KEEPALIVE void fw_do_drop(int pt, int sq) { __fuseki_do_drop(pt, sq); }
EMSCRIPTEN_KEEPALIVE int fw_is_placement_done() { return __fuseki_is_placement_done() ? 1 : 0; }
EMSCRIPTEN_KEEPALIVE int fw_turn() { return __fuseki_turn(); }
EMSCRIPTEN_KEEPALIVE int fw_ply() { return __fuseki_ply(); }
EMSCRIPTEN_KEEPALIVE int fw_is_king_attacked(int c) { return __fuseki_is_king_attacked(c) ? 1 : 0; }
EMSCRIPTEN_KEEPALIVE int fw_remaining(int c, int pt) { return __fuseki_remaining(c, pt); }
EMSCRIPTEN_KEEPALIVE int fw_move_label(int pt, int sq, int c) { return __fuseki_move_label(pt, sq, c); }
// 布石専用ネット（648出力）のラベル。fw_move_label から 81*(28-8)=1620 を引いた値だが、
// 引き算はC++側（cppshogi.cpp の make_fuseki_compact_label）に閉じてある。
// ここで独自に引くと、C++が288空間・ONNXが648空間といった取り違えが起きたとき
// parity_test.mjs のビット一致検証をすり抜ける（argmaxだけが別の手を指す）。
EMSCRIPTEN_KEEPALIVE int fw_compact_label(int pt, int sq, int c) { return __fuseki_compact_label(pt, sq, c); }
EMSCRIPTEN_KEEPALIVE int fw_compact_label_num() { return FUSEKI_LABEL_NUM; }

// 特徴量は静的バッファに書き、JS側はHEAPF32のsubarrayとして読む。
EMSCRIPTEN_KEEPALIVE void fw_make_features() {
    __fuseki_make_input_features(reinterpret_cast<char*>(g_features1), reinterpret_cast<char*>(g_features2));
}
EMSCRIPTEN_KEEPALIVE float* fw_features1_ptr() { return reinterpret_cast<float*>(g_features1); }
EMSCRIPTEN_KEEPALIVE float* fw_features2_ptr() { return reinterpret_cast<float*>(g_features2); }
EMSCRIPTEN_KEEPALIVE int fw_features1_len() { return (int)(sizeof(features1_t) / sizeof(float)); }
EMSCRIPTEN_KEEPALIVE int fw_features2_len() { return (int)(sizeof(features2_t) / sizeof(float)); }

EMSCRIPTEN_KEEPALIVE const char* fw_to_sfen() {
    const std::string s = __fuseki_to_sfen();
    std::strncpy(g_str, s.c_str(), sizeof(g_str) - 1);
    g_str[sizeof(g_str) - 1] = '\0';
    return g_str;
}
EMSCRIPTEN_KEEPALIVE int fw_verify_final_sfen(const char* sfen) {
    return __fuseki_verify_final_sfen(std::string(sfen)) ? 1 : 0;
}
EMSCRIPTEN_KEEPALIVE const char* fw_move_to_usi(int pt, int sq) {
    const std::string s = fusekiMoveToUSI(static_cast<PieceType>(pt), static_cast<Square>(sq));
    std::strncpy(g_str, s.c_str(), sizeof(g_str) - 1);
    g_str[sizeof(g_str) - 1] = '\0';
    return g_str;
}
EMSCRIPTEN_KEEPALIVE int fw_parse_usi_move(const char* s, int* outPt, int* outSq) {
    return __fuseki_parse_usi_move(std::string(s), outPt, outSq) ? 1 : 0;
}

} // extern "C"
