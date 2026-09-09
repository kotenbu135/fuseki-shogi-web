// Cookieの同意を尋ねる帯。EEA・英国・スイスからの訪問にだけ出す。
//
// 既定の可否は head の Consent Mode v2 が決めていて、この帯は「拒否で始まる地域」の
// 人に選ばせるためだけにある。それ以外の地域では最初から granted なので出さない。
//
// 国は Cloudflare の /cdn-cgi/trace から取る。同一オリジンなので connect-src 'self' を
// 満たし、Worker も要らない。取れなかったときは**出す側に倒す**——黙って測るより聞く。
//
// 文言は置き場所の data-* から取る（heat.js と同じ作法。このファイルは2言語で共有する）。
(() => {
  const KEY = 'fuseki-consent';
  const box = document.getElementById('consent');
  if (!box) return;

  const read = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const save = v => { try { localStorage.setItem(KEY, v); } catch { /* 残せなくても効く */ } };
  const apply = v => window.gtag?.('consent', 'update', { analytics_storage: v });

  // 設定（歯車）にも同じ切り替えを出す。同意は「いつでも、与えるのと同じ手軽さで」
  // 撤回できる必要がある。帯は一度きりなので、後から変える口はここになる。
  // ポップのHTMLは index と文章のページで別々にあるので、DOMはこちらで足す。
  const pop = document.getElementById('display-settings');
  if (pop) {
    const label = document.createElement('label');
    label.className = 'check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = 'opt-consent';
    // 未回答なら「拒否で始まる地域」以外は既定で許可なので、入りで見せる。
    cb.checked = read() !== 'denied';
    const span = document.createElement('span');
    span.textContent = box.dataset.opt;
    cb.addEventListener('change', () => {
      const v = cb.checked ? 'granted' : 'denied';
      save(v); apply(v);
      box.hidden = true;   // 帯が出たままなら引く
    });
    label.append(cb, span);
    // 「押し方」の注記があるページでは、その前に入れる。
    pop.insertBefore(label, pop.querySelector('.pop-note'));
  }

  // 答え済みなら帯は出さない（head で既に consent update を送っている）。
  const prev = read();
  if (prev === 'granted' || prev === 'denied') return;

  const answer = v => {
    save(v);
    apply(v);
    box.hidden = true;
    const cb = document.getElementById('opt-consent');
    if (cb) cb.checked = v === 'granted';
  };

  const build = () => {
    const p = document.createElement('p');
    p.className = 'consent-text';
    p.textContent = box.dataset.text;
    const row = document.createElement('div');
    row.className = 'consent-actions';
    // 拒否は同意と同じ手軽さで押せること（同じ大きさ・同じ並び）。
    for (const [label, v] of [[box.dataset.reject, 'denied'], [box.dataset.accept, 'granted']]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', () => answer(v));
      row.append(b);
    }
    box.append(p, row);
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', box.dataset.label);
    box.hidden = false;   // 割り込まない。焦点は奪わずTabで届くところに置く
  };

  fetch('/cdn-cgi/trace', { cache: 'no-store' })
    .then(r => (r.ok ? r.text() : Promise.reject()))
    .then(t => (t.match(/^loc=([A-Z]{2})$/m) ?? [])[1])
    .then(loc => { if (!loc || (window.CONSENT_REGIONS ?? []).includes(loc)) build(); })
    .catch(() => build());   // 分からなければ尋ねる
})();
