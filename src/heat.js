// 両玉の価値表のヒートマップ。コラム（天秤将棋ができるまで）とルールの両方が使う。
//
// 表は models/ に公開しているものをそのまま読む。表を作り直せばページも追従するので、
// 数字をHTMLに書き写さない。文言は置き場所の data-* から取る（ページごとに言語が違い、
// このファイルは2言語で共有するため）。
//
// 対局画面の app.js には入れない。文章のページは app.js を読み込まないので、
// ここだけ独立した小さなモジュールにして build.mjs が dist/ へ写す。
for (const el of document.querySelectorAll('.heat[data-table]')) draw(el);

async function draw(el) {
  const d = el.dataset;
  try {
    const t = await (await fetch(`/models/${d.table}`)).json();
    const boards = [
      { title: d.black, vals: t.black_king_value_pt, ranks: ['f', 'g', 'h', 'i'] },
      { title: d.white, vals: t.white_king_value_pt, ranks: ['a', 'b', 'c', 'd'] },
    ];
    const lim = 50;
    const color = v => {
      const x = Math.max(-1, Math.min(1, v / lim));
      // 青（後手に有利）〜 紙 〜 朱（先手に有利）
      const mix = (a, b, k) => a.map((c, i) => Math.round(c + (b[i] - c) * k));
      const paper = [244, 242, 234], blue = [78, 121, 196], red = [217, 84, 45];
      const c = x < 0 ? mix(paper, blue, -x) : mix(paper, red, x);
      return `rgb(${c.join(',')})`;
    };
    for (const b of boards) {
      const box = document.createElement('div');
      box.className = 'heat-board';
      const title = document.createElement('div');
      title.className = 'heat-title';
      title.textContent = b.title;
      const grid = document.createElement('div');
      grid.className = 'heat-grid';
      for (const r of b.ranks) for (let f = 9; f >= 1; f--) {
        const v = b.vals[`${f}${r}`];
        const cell = document.createElement('div');
        cell.className = 'heat-cell';
        // CSPの style-src は 'self' だけだが、CSSOM への代入は属性ではないので通る。
        cell.style.background = color(v);
        cell.style.color = Math.abs(v) > 30 ? '#fff' : '#1d1b16';
        cell.textContent = v > 0 ? `+${Math.round(v)}` : String(Math.round(v));
        cell.title = `${f}${r}: ${v.toFixed(1)} pt`;
        grid.appendChild(cell);
      }
      box.append(title, grid);
      el.appendChild(box);
    }
    const scale = document.createElement('div');
    scale.className = 'heat-scale';
    scale.append(span(`${d.low} −${lim}`), document.createElement('i'), span(`+${lim} ${d.high}`));
    el.after(scale);
  } catch (e) {
    el.textContent = `${d.error}: ${e.message}`;
  }
}

const span = text => {
  const s = document.createElement('span');
  s.textContent = text;
  return s;
};
