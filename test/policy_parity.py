"""布石方策のパリティ検証その2。

policy_probe.mjs が書き出した特徴量を Python の onnxruntime に同じように食わせ、
onnxruntime-web が返した logits / value と一致するかを見る。ここが合っていれば、
ブラウザの布石AIは開発用リポジトリのエンジンと同じ手を選ぶ。

    node test/policy_probe.mjs policy_probe.json
    python3 test/policy_parity.py policy_probe.json models/fuseki_rollout_iter38.onnx
"""
import json
import sys

import numpy as np
import onnxruntime

TOL = 1e-4


def main(probe_path: str, model_path: str) -> int:
    with open(probe_path, encoding="utf-8") as f:
        probe = json.load(f)

    sess = onnxruntime.InferenceSession(model_path, providers=["CPUExecutionProvider"])
    max_logit_diff = 0.0
    max_value_diff = 0.0
    argmax_mismatch = 0

    for s in probe["samples"]:
        f1 = np.array(s["input1"], dtype=np.float32).reshape(1, 62, 9, 9)
        f2 = np.array(s["input2"], dtype=np.float32).reshape(1, 59, 9, 9)
        policy, value = sess.run(None, {"input1": f1, "input2": f2})

        web_logits = np.array(s["logits"], dtype=np.float32)
        logit_diff = float(np.max(np.abs(policy[0] - web_logits)))
        value_diff = abs(float(value[0][0]) - s["value"])
        max_logit_diff = max(max_logit_diff, logit_diff)
        max_value_diff = max(max_value_diff, value_diff)

        # 実際に選ぶ手が変わらないこと（合法手ラベルの中での最大値が同じか）。
        labels = [m["label"] for m in s["legal"]]
        if labels and int(np.argmax(policy[0][labels])) != int(np.argmax(web_logits[labels])):
            argmax_mismatch += 1
            print(f"  NG ply={s['ply']} 合法手中の最大logitが違う")

        print(f"  ply={s['ply']:2d} 合法手={len(labels):3d} "
              f"logit差={logit_diff:.3e} value差={value_diff:.3e}")

    print(f"\n{len(probe['samples'])}局面 / logit最大差 {max_logit_diff:.3e} / "
          f"value最大差 {max_value_diff:.3e} / 最有力手の不一致 {argmax_mismatch} 件")
    ok = max_logit_diff < TOL and max_value_diff < TOL and argmax_mismatch == 0
    print("一致" if ok else f"不一致（許容 {TOL:.0e}）")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2]))
