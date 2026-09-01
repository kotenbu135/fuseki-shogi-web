"""C++版(Python拡張)とWASM版の布石ロジックを突き合わせるための参照データ生成。

同一のLCG（JS側とBigIntで一致する64bit線形合同法）で決定的にプレイアウトし、
各手番で legalDrops / 特徴量 / 指し手ラベル のチェックサムを記録する。
チェックサムは整数演算だけで作る（浮動小数の文字列化やハッシュ実装の差で
偽の不一致が出ないようにするため。特徴量の値は0/1のみ）。
"""
import json
import sys

import numpy as np
from dlshogi import cppshogi
from dlshogi.common import MAX_MOVE_LABEL_NUM

# 布石専用ネット（scripts/fuseki_net.py の fuseki6x64 等）の出力空間は 8スロット × 81マス = 648。
# 既存の 28 × 81 = 2268 のラベルから、盤上の指し手ぶん 81 × (28 - 8) = 1620 を引いた値になる。
# **この引き算をここで独立に書き直しているのは意図的**で、C++/WASM側の
# make_fuseki_compact_label とこの式が食い違っていないことが照合項目になる。
# 取り違え（片方が288空間、片方が648空間）は、既存の照合項目を全部通したまま
# argmaxだけを別の手にする壊れ方をするので、専用の項目が要る。
FUSEKI_PIECE_SLOTS = 8
FUSEKI_LABEL_OFFSET = 81 * (MAX_MOVE_LABEL_NUM - FUSEKI_PIECE_SLOTS)
FUSEKI_LABEL_NUM = 81 * FUSEKI_PIECE_SLOTS

M32 = 0xFFFFFFFF
M64 = 0xFFFFFFFFFFFFFFFF


class Lcg:
    def __init__(self, seed):
        self.s = seed & M64

    def next(self):
        self.s = (self.s * 6364136223846793005 + 1442695040888963407) & M64
        return self.s >> 33


def csum_pairs(pairs):
    h = 0
    for i, (pt, sq) in enumerate(pairs):
        h = (h + (i + 1) * (pt * 1000003 + sq * 31 + 7)) & M32
    return h


def csum_floats(arr):
    flat = arr.reshape(-1)
    nz = np.nonzero(flat)[0]
    h = 0
    for i in nz:
        h = (h + (int(i) + 1) * int(round(float(flat[i]) * 1000))) & M32
    return h, int(len(nz))


def main(games=20, seed=12345):
    from dlshogi.common import FEATURES1_NUM, FEATURES2_NUM
    f1 = np.empty((FEATURES1_NUM, 9, 9), dtype=np.float32)
    f2 = np.empty((FEATURES2_NUM, 9, 9), dtype=np.float32)
    out = []
    rng = Lcg(seed)
    for g in range(games):
        cppshogi.fuseki_reset()
        plies = []
        while not cppshogi.fuseki_is_placement_done():
            legal = cppshogi.fuseki_legal_drops()
            cppshogi.fuseki_make_input_features(f1, f2)
            h1, nz1 = csum_floats(f1)
            h2, nz2 = csum_floats(f2)
            color = cppshogi.fuseki_turn()
            labels = 0
            compact = 0
            compact_max = -1
            for i, (pt, sq) in enumerate(legal):
                label = cppshogi.fuseki_move_label(pt, sq, color)
                labels = (labels + (i + 1) * (label + 1)) & M32
                c = label - FUSEKI_LABEL_OFFSET
                assert 0 <= c < FUSEKI_LABEL_NUM, (pt, sq, color, label, c)
                compact = (compact + (i + 1) * (c + 1)) & M32
                compact_max = max(compact_max, c)
            idx = rng.next() % len(legal)
            pt, sq = legal[idx]
            plies.append({
                "ply": cppshogi.fuseki_ply(), "turn": color, "n": len(legal),
                "legal_csum": csum_pairs(legal), "f1_csum": h1, "f1_nz": nz1,
                "f2_csum": h2, "f2_nz": nz2, "label_csum": labels,
                "compact_csum": compact, "compact_max": compact_max,
                "pick": [pt, sq], "usi": cppshogi.fuseki_move_to_usi(pt, sq) if hasattr(cppshogi, "fuseki_move_to_usi") else "",
            })
            cppshogi.fuseki_do_drop(pt, sq)
        sfen = cppshogi.fuseki_to_sfen()
        out.append({"game": g, "sfen": sfen,
                    "verify": cppshogi.fuseki_verify_final_sfen(sfen),
                    "king_attacked": [cppshogi.fuseki_is_king_attacked(0), cppshogi.fuseki_is_king_attacked(1)],
                    "plies": plies})
    json.dump({"seed": seed, "games": games, "data": out}, open(sys.argv[1], "w"))
    print(f"wrote {games} games x 40 plies -> {sys.argv[1]}")


if __name__ == "__main__":
    main()
