// 論文ノート — 画面の動き
// 研究資料・研究ログ・締切・論文の本文は、このブラウザの中に保存します(store.js)。
// 研究ログや資料を追加するたびに、サーバー(/api/write)に頼んで論文を書き進めます。

import { loadState, saveState } from './store.js';
import { ACCEPT, extractText, fileKind, unsupportedReason } from './readers.js';

// ---- 決まった値 ----
const KINDS = {
  卒業論文: 20000,
  修士論文: 40000,
  博士論文: 100000,
  レポート: 8000,
};
const DEFAULT_SECTIONS = [
  ['序論', 1],
  ['先行研究', 2],
  ['研究方法', 2],
  ['結果', 2],
  ['考察', 2],
  ['結論', 1],
];
const LOG_TAGS = ['実験', '調査', '文献', 'ゼミ・相談', '考え', 'その他'];
const MAX_SEND_CHARS = 60000; // 要約に送る資料の文字数
const MAX_KEEP_CHARS = 300000; // ブラウザに残す資料の文字数
const FRESH_MS = 3 * 60 * 1000; // 「たった今更新」を出す時間

// ---- 小さな道具 ----
const $ = (sel) => document.querySelector(sel);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysUntil(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  if (!y || !m || !d) return null;
  const target = new Date(y, m - 1, d);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target - today) / 86400000);
}

function formatDate(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  if (!y) return '';
  const w = '日月火水木金土'[new Date(y, m - 1, d).getDay()];
  return `${y}年${m}月${d}日(${w})`;
}

function formatTime(ms) {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function countChars(text) {
  return String(text || '').replace(/\s/g, '').length;
}

function paragraphs(text) {
  return String(text || '').split(/\n\s*\n/).map((t) => t.trim()).filter(Boolean);
}

// ---- データ ----
function newState() {
  return {
    version: 1,
    project: {
      setupDone: false,
      kind: '修士論文',
      title: '',
      field: '',
      author: '',
      affiliation: '',
      rq: '',
      targetChars: KINDS['修士論文'],
    },
    sections: DEFAULT_SECTIONS.map(([title, weight]) => ({ id: uid(), title, weight, text: '', locked: false, updatedAt: 0 })),
    materials: [],
    logs: [],
    deadlines: [],
  };
}

let state = newState();
let saveTimer = null;

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await saveState(state);
    } catch (err) {
      console.error(err);
      toast('データを保存できませんでした。ブラウザの空き容量が少ないか、プライベートモードの可能性があります。', true);
    }
  }, 250);
}

// ---- 論文の進み具合 ----
function sectionTargets() {
  const total = Number(state.project.targetChars) || 20000;
  const sum = state.sections.reduce((a, s) => a + (Number(s.weight) || 1), 0) || 1;
  return state.sections.map((s) => Math.round((total * (Number(s.weight) || 1)) / sum));
}

function progress() {
  const targets = sectionTargets();
  const total = targets.reduce((a, b) => a + b, 0) || 1;
  let done = 0;
  const per = state.sections.map((s, i) => {
    const chars = countChars(s.text);
    done += Math.min(chars, targets[i]);
    return { chars, target: targets[i], ratio: Math.min(1, chars / (targets[i] || 1)) };
  });
  const allChars = per.reduce((a, p) => a + p.chars, 0);
  return { ratio: done / total, per, allChars };
}

function nextDeadline() {
  return state.deadlines
    .filter((d) => !d.done && daysUntil(d.date) !== null && daysUntil(d.date) >= 0)
    .sort((a, b) => a.date.localeCompare(b.date))[0] || null;
}

function references() {
  return state.materials
    .filter((m) => m.status === 'done')
    .map((m) => m.citation || m.name)
    .sort((a, b) => a.localeCompare(b, 'ja'));
}

// ---- サーバーとのやりとり ----
async function api(path, body) {
  let res;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('サーバーにつながりませんでした。インターネットの接続を確認してください(Render の無料プランは、しばらく使わないと起動に1分ほどかかります)。');
  }
  if (!res.ok) {
    let msg = '';
    try { msg = (await res.json()).error; } catch { /* 文字で返ってこなかった */ }
    throw new Error(msg || `サーバーとのやりとりに失敗しました(${res.status})。少し待ってからもう一度試してください。`);
  }
  return res;
}

// ---- 論文に反映する(順番に1つずつ) ----
const queue = [];
let writing = false;

function enqueueWrite(trigger, target) {
  if (target) target.reflect = 'waiting';
  queue.push({ trigger, target });
  refresh();
  runQueue();
}

async function runQueue() {
  if (writing) return;
  writing = true;
  while (queue.length) {
    const job = queue.shift();
    await doWrite(job);
  }
  writing = false;
  updateBusy();
}

async function doWrite({ trigger, target }) {
  if (target) target.reflect = 'writing';
  updateBusy('論文に反映しています…');
  refresh();

  const targets = sectionTargets();
  const body = {
    project: state.project,
    sections: state.sections.map((s, i) => ({ id: s.id, title: s.title, text: s.text, locked: s.locked, target: targets[i] })),
    materials: state.materials
      .filter((m) => m.status === 'done')
      .map((m) => ({ name: m.name, citation: m.citation, summary: m.summary })),
    logs: [...state.logs]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((l) => ({ date: l.date, tag: l.tag, text: l.text })),
    trigger,
  };

  try {
    const res = await api('/api/write', body);
    const out = await res.json();
    const changed = [];
    for (const u of out.updates || []) {
      const s = state.sections.find((x) => x.id === u.id);
      if (!s || s.locked) continue;
      s.text = u.text;
      s.updatedAt = Date.now();
      changed.push(s.title);
    }
    if (target) {
      target.reflect = 'done';
      target.reflectedTo = changed;
      target.reflectError = '';
    }
    toast(changed.length ? (out.note || `「${changed.join('」「')}」に反映しました。`) : '今回は論文に書き足す内容がありませんでした。');
  } catch (err) {
    if (target) {
      target.reflect = 'error';
      target.reflectError = err.message;
    }
    toast(err.message, true);
  }
  save();
  refresh();
}

function updateBusy(text) {
  const el = $('#busy');
  const waiting = queue.length;
  if (writing || text) {
    el.hidden = false;
    el.textContent = (text || '論文に反映しています…') + (waiting ? `(あと${waiting}件待ち)` : '');
  } else {
    el.hidden = true;
  }
}

// ---- 研究資料を追加する ----
async function addFiles(files) {
  for (const file of files) {
    if (!fileKind(file.name)) {
      toast(`「${file.name}」は読めません。${unsupportedReason(file.name)}`, true);
      continue;
    }
    const m = {
      id: uid(),
      name: file.name,
      type: fileKind(file.name),
      size: file.size,
      addedAt: Date.now(),
      status: 'reading',
      text: '',
      summary: '',
      points: [],
      citation: '',
      error: '',
    };
    state.materials.unshift(m);
    refresh();
    try {
      const text = await extractText(file);
      if (!text) throw new Error('文字を読み取れませんでした(写真やスキャンだけのPDFは読めません)。');
      m.text = text.slice(0, MAX_KEEP_CHARS);
      save();
      await summarize(m);
    } catch (err) {
      m.status = 'error';
      m.error = err.message || '読み取りに失敗しました。';
      save();
      refresh();
    }
  }
}

async function summarize(m) {
  m.status = 'summarizing';
  m.error = '';
  refresh();
  try {
    const res = await api('/api/summarize', { name: m.name, text: m.text.slice(0, MAX_SEND_CHARS) });
    const out = await res.json();
    m.summary = out.summary || '';
    m.points = out.points || [];
    m.citation = out.citation || '';
    m.status = 'done';
    save();
    enqueueWrite({ kind: 'material', text: m.citation || m.name }, m);
  } catch (err) {
    m.status = 'error';
    m.error = err.message;
    save();
    refresh();
  }
}

// ---- 画面の切り替え ----
let view = 'home';
let searchQuery = '';
let editingSection = null;
let openMaterial = null;

function go(name) {
  view = name;
  editingSection = null;
  if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
  render();
  window.scrollTo(0, 0);
}

function render() {
  const p = state.project;
  $('#top-kind').textContent = p.kind;
  $('#top-title').textContent = p.title || '(タイトル未設定)';
  for (const b of document.querySelectorAll('.nav')) {
    b.classList.toggle('active', b.dataset.view === view);
    if (b.dataset.view === view) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  const views = { home: viewHome, materials: viewMaterials, logs: viewLogs, paper: viewPaper, deadlines: viewDeadlines, settings: viewSettings, search: viewSearch };
  // 入力中の文字を消さないように、ほかの画面の入力欄は描き直しの前に覚えておく
  const keep = keepInputs();
  $('#view').innerHTML = (views[view] || viewHome)();
  restoreInputs(keep);
}

// 裏で進む処理(読み取り・反映)が終わったときの描き直し。
// 設定や本文を編集中なら、入力が消えないように画面はそのままにする
function refresh() {
  if (view === 'settings' || editingSection) {
    $('#top-title').textContent = state.project.title || '(タイトル未設定)';
    return;
  }
  render();
}

function keepInputs() {
  const out = {};
  for (const el of document.querySelectorAll('#view [data-keep]')) out[el.dataset.keep] = el.value;
  const active = document.activeElement?.dataset?.keep || null;
  return { values: out, active };
}

function restoreInputs({ values, active }) {
  for (const el of document.querySelectorAll('#view [data-keep]')) {
    if (values[el.dataset.keep] !== undefined) el.value = values[el.dataset.keep];
  }
  if (active) document.querySelector(`#view [data-keep="${active}"]`)?.focus();
}

// ---- ホーム ----
function viewHome() {
  const p = state.project;
  const pr = progress();
  const dl = nextDeadline();
  const days = dl ? daysUntil(dl.date) : null;

  const deadlineCard = dl
    ? `<div class="card-label">次の締切</div>
       <div class="big">${days === 0 ? '今日' : `あと ${days}日`}</div>
       <div class="card-sub">${esc(dl.title)} ${esc(formatDate(dl.date))}</div>`
    : `<div class="card-label">次の締切</div>
       <div class="card-empty">まだ登録されていません</div>
       <button class="btn btn-onaccent" data-go="deadlines">締切を登録する</button>`;

  const rqCard = p.rq
    ? `<p class="rq">${esc(p.rq)}</p>`
    : `<p class="muted">研究の問いが未設定です。</p><button class="btn btn-plain" data-go="settings">設定する</button>`;

  const rows = state.sections.map((s, i) => {
    const r = pr.per[i];
    const label = r.ratio >= 1 ? '目安に到達' : `${Math.round(r.ratio * 100)}%`;
    return `<div class="sec-row">
      <div class="sec-row-head"><span>${esc(s.title)}</span><span class="muted">${r.chars.toLocaleString()}字 · ${label}</span></div>
      <div class="bar"><div style="width:${Math.round(r.ratio * 100)}%"></div></div>
    </div>`;
  }).join('');

  const recent = state.materials.slice(0, 5).map((m) => `
    <li class="file-row">
      <span class="badge">${esc(m.type)}</span>
      <span class="file-name">${esc(m.name)}</span>
      <span class="muted small">${materialStatus(m)}</span>
    </li>`).join('') || '<li class="muted">まだ資料がありません。右上の「＋ 資料を追加」から読み込めます。</li>';

  return `
  <div class="grid3">
    <section class="card card-accent">${deadlineCard}</section>
    <section class="card">
      <div class="card-label">研究の問い</div>
      ${rqCard}
    </section>
    <section class="card">
      <div class="card-label">論文の完成度</div>
      <div class="big accent-text">${Math.round(pr.ratio * 100)}%</div>
      <div class="bar"><div style="width:${Math.round(pr.ratio * 100)}%"></div></div>
      <div class="card-sub muted">${pr.allChars.toLocaleString()}字 / 目標 ${Number(p.targetChars).toLocaleString()}字</div>
    </section>
  </div>
  <div class="grid2">
    <section class="card">
      <div class="card-head"><h2>論文の構成</h2><button class="link" data-go="paper">論文を開く</button></div>
      ${rows}
    </section>
    <section class="card">
      <div class="card-head"><h2>最近読み込んだ資料</h2><button class="link" data-go="materials">すべて見る</button></div>
      <ul class="plain">${recent}</ul>
      <form class="quick-log" data-form="quick-log">
        <label for="quick-log">今日の研究メモ</label>
        <div class="row">
          <input id="quick-log" data-keep="quick-log" maxlength="1500" placeholder="やったこと・わかったことを書く(論文に反映されます)">
          <button class="btn btn-accent">記録</button>
        </div>
      </form>
    </section>
  </div>`;
}

// ---- 研究資料 ----
function materialStatus(m) {
  if (m.status === 'reading') return '読み取り中…';
  if (m.status === 'summarizing') return '要約中…';
  if (m.status === 'error') return '読み取れませんでした';
  if (m.reflect === 'waiting') return '反映待ち';
  if (m.reflect === 'writing') return '論文に反映中…';
  return '要約済み';
}

function reflectLine(item) {
  if (item.reflect === 'waiting') return '<div class="reflect">論文への反映を待っています</div>';
  if (item.reflect === 'writing') return '<div class="reflect">論文に反映しています…</div>';
  if (item.reflect === 'error') {
    return `<div class="reflect error">反映できませんでした:${esc(item.reflectError)}
      <button class="link" data-action="retry-reflect" data-id="${item.id}">もう一度反映</button></div>`;
  }
  if (item.reflect === 'done') {
    return item.reflectedTo?.length
      ? `<div class="reflect">→ 論文「${item.reflectedTo.map(esc).join('」「')}」に反映</div>`
      : '<div class="reflect muted">→ 論文に書き足す内容はありませんでした</div>';
  }
  return '';
}

function viewMaterials() {
  const list = state.materials.map((m) => {
    const open = openMaterial === m.id;
    const detail = open && m.status === 'done' ? `
      <div class="m-detail">
        ${m.citation ? `<div class="small muted">書誌情報:${esc(m.citation)}</div>` : ''}
        <h3>要約</h3>
        ${paragraphs(m.summary).map((t) => `<p>${esc(t)}</p>`).join('')}
        ${m.points?.length ? `<h3>使えそうな要点</h3><ul>${m.points.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
        ${m.text.length > MAX_SEND_CHARS ? `<p class="small muted">※ 長い資料のため、はじめの${MAX_SEND_CHARS.toLocaleString()}字をもとに要約しています。</p>` : ''}
      </div>` : '';
    return `
    <li class="card m-item">
      <div class="m-head">
        <span class="badge">${esc(m.type)}</span>
        <div class="m-title">
          <div class="file-name">${esc(m.name)}</div>
          <div class="small muted">${formatTime(m.addedAt)} 追加 · ${materialStatus(m)}</div>
        </div>
        <div class="m-buttons">
          ${m.status === 'done' ? `<button class="btn btn-plain" data-action="toggle-material" data-id="${m.id}" aria-expanded="${open}">${open ? '閉じる' : '要約を見る'}</button>` : ''}
          ${(m.status === 'done' || m.status === 'error') && m.text ? `<button class="btn btn-plain" data-action="resummarize" data-id="${m.id}">要約をやり直す</button>` : ''}
          <button class="btn btn-plain" data-action="delete-material" data-id="${m.id}">削除</button>
        </div>
      </div>
      ${m.status === 'error' ? `<div class="reflect error">${esc(m.error)}</div>` : ''}
      ${reflectLine(m)}
      ${detail}
    </li>`;
  }).join('');

  return `
  <section class="card">
    <h2>研究資料を読み込む</h2>
    <button class="drop" data-action="pick-files" id="drop">
      ここにファイルをドラッグ、またはクリックして選ぶ<br>
      <span class="small">PDF・Word(.docx)・PowerPoint(.pptx)・テキスト(.txt .md .csv)</span>
    </button>
    <p class="small muted">読み込んだ資料は要約され、論文(主に先行研究)に反映されます。写真やスキャンだけの PDF は文字を読み取れません。</p>
  </section>
  <ul class="plain stack">${list || '<li class="muted">まだ資料がありません。</li>'}</ul>`;
}

// ---- 研究ログ ----
function viewLogs() {
  const logs = [...state.logs].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
  const list = logs.map((l) => `
    <li class="log">
      <div class="dot" aria-hidden="true"></div>
      <div class="log-body">
        <div class="log-meta"><span>${esc(formatDate(l.date))}</span><span class="tag">${esc(l.tag)}</span>
          <button class="link small" data-action="delete-log" data-id="${l.id}">削除</button></div>
        <p>${esc(l.text)}</p>
        ${reflectLine(l)}
      </div>
    </li>`).join('');

  return `
  <section class="card">
    <h2>研究ログを書く</h2>
    <form class="log-form" data-form="log">
      <div class="row wrap">
        <label class="field">日付 <input type="date" name="date" value="${todayStr()}" required></label>
        <label class="field">種類
          <select name="tag">${LOG_TAGS.map((t) => `<option>${t}</option>`).join('')}</select>
        </label>
      </div>
      <label class="field" for="log-text">やったこと・わかったこと・考えたこと</label>
      <textarea id="log-text" name="text" data-keep="log-text" rows="4" maxlength="1500" required
        placeholder="例:実験2の結果、条件Bのほうが反応時間が短かった(平均 412ms と 455ms)。"></textarea>
      <div class="row end"><button class="btn btn-accent">記録して論文に反映</button></div>
    </form>
    <p class="small muted">数値や結果は、ここに書いたものだけが論文に使われます。書いていないことが論文に足されることはありません。</p>
  </section>
  <section class="card">
    <h2>これまでのログ</h2>
    <ul class="plain timeline">${list || '<li class="muted">まだログがありません。</li>'}</ul>
  </section>`;
}

// ---- 論文 ----
function paperBody({ forPrint } = {}) {
  const p = state.project;
  const now = Date.now();
  const secs = state.sections.map((s, i) => {
    const fresh = !forPrint && s.updatedAt && now - s.updatedAt < FRESH_MS;
    const head = `<h3>${i + 1}. ${esc(s.title)}${fresh ? ' <span class="fresh">たった今更新</span>' : ''}</h3>`;
    if (!forPrint && editingSection === s.id) {
      return `<section class="p-sec">
        ${head}
        <form data-form="edit-section" data-id="${s.id}">
          <label class="small muted" for="edit-${s.id}">本文(段落の間は空行を1つ)</label>
          <textarea id="edit-${s.id}" name="text" rows="14">${esc(s.text)}</textarea>
          <div class="row end">
            <button type="button" class="btn btn-plain" data-action="cancel-edit">やめる</button>
            <button class="btn btn-accent">保存</button>
          </div>
        </form>
      </section>`;
    }
    const body = paragraphs(s.text).map((t) => {
      const html = esc(t).replace(/【要確認[::]?([^】]*)】/g, '<mark class="todo">【要確認:$1】</mark>');
      return `<p>${html}</p>`;
    }).join('') || (forPrint ? '' : '<p class="empty">(まだ書かれていません。研究ログや資料を追加すると書き進みます)</p>');
    const tools = forPrint ? '' : `
      <div class="p-tools">
        <button class="link small" data-action="edit-section" data-id="${s.id}">自分で直す</button>
        <label class="small"><input type="checkbox" data-action="lock-section" data-id="${s.id}" ${s.locked ? 'checked' : ''}> 書き換え禁止</label>
      </div>`;
    return `<section class="p-sec">${head}${tools}${body}</section>`;
  }).join('');

  const refs = references();
  return `
    <h2 class="p-title">${esc(p.title || '(タイトル未設定)')}</h2>
    <div class="p-author">${esc([p.affiliation, p.author].filter(Boolean).join(' '))}</div>
    ${secs}
    ${refs.length ? `<section class="p-sec"><h3>参考文献</h3><ul class="refs">${refs.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></section>` : ''}`;
}

function viewPaper() {
  return `
  <div class="paper-bar">
    <button class="btn btn-accent" data-action="export-docx">Word で書き出す</button>
    <button class="btn btn-plain" data-action="export-pdf">PDF で保存</button>
    <button class="btn btn-plain" data-action="rewrite-all">全体を見直して整える</button>
  </div>
  <p class="small muted">【要確認】の部分は、材料が足りずに書けなかった所です。研究ログを足すか、「自分で直す」で書き足してください。「書き換え禁止」にした章は、自動では変わりません。</p>
  <article class="paper">${paperBody()}</article>`;
}

// ---- 締切 ----
function viewDeadlines() {
  const list = [...state.deadlines].sort((a, b) => Number(a.done) - Number(b.done) || a.date.localeCompare(b.date)).map((d) => {
    const days = daysUntil(d.date);
    let label = days > 0 ? `あと ${days}日` : days === 0 ? '今日' : `${-days}日過ぎています`;
    if (d.done) label = '完了';
    const cls = d.done ? 'done' : days < 0 ? 'over' : days <= 7 ? 'soon' : '';
    return `
    <li class="dl ${cls}">
      <label class="dl-check"><input type="checkbox" data-action="toggle-deadline" data-id="${d.id}" ${d.done ? 'checked' : ''}><span class="sr">完了にする</span></label>
      <div class="dl-main">
        <div class="dl-title">${esc(d.title)}</div>
        <div class="small muted">${esc(formatDate(d.date))}</div>
      </div>
      <div class="dl-days">${label}</div>
      <button class="link small" data-action="delete-deadline" data-id="${d.id}">削除</button>
    </li>`;
  }).join('');

  return `
  <section class="card">
    <h2>締切を登録する</h2>
    <form class="row wrap" data-form="deadline">
      <label class="field grow">内容 <input name="title" data-keep="dl-title" maxlength="100" required placeholder="例:中間発表のスライド提出"></label>
      <label class="field">日付 <input type="date" name="date" data-keep="dl-date" required></label>
      <button class="btn btn-accent self-end">登録</button>
    </form>
  </section>
  <section class="card">
    <h2>締切の一覧</h2>
    <ul class="plain">${list || '<li class="muted">まだ締切がありません。</li>'}</ul>
  </section>`;
}

// ---- 設定 ----
function viewSettings() {
  const p = state.project;
  const welcome = p.setupDone ? '' : `
    <section class="card welcome">
      <h2>はじめに</h2>
      <p>まず、あなたの研究について入力してください。ここに書いた「研究の問い」をもとに論文が書き進みます。あとからいつでも変えられます。</p>
    </section>`;
  const secs = state.sections.map((s, i) => `
    <li class="row sec-edit">
      <label class="sr" for="sec-${s.id}">章 ${i + 1} の名前</label>
      <input id="sec-${s.id}" name="sec-${s.id}" value="${esc(s.title)}" maxlength="40" required>
      <label class="small field-inline">分量
        <select name="w-${s.id}">${[1, 2, 3].map((w) => `<option value="${w}" ${Number(s.weight) === w ? 'selected' : ''}>${['少なめ', 'ふつう', '多め'][w - 1]}</option>`).join('')}</select>
      </label>
      <button type="button" class="btn btn-plain" data-action="move-section" data-dir="-1" data-id="${s.id}" aria-label="上へ" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button type="button" class="btn btn-plain" data-action="move-section" data-dir="1" data-id="${s.id}" aria-label="下へ" ${i === state.sections.length - 1 ? 'disabled' : ''}>↓</button>
      <button type="button" class="btn btn-plain" data-action="delete-section" data-id="${s.id}">削除</button>
    </li>`).join('');

  return `
  ${welcome}
  <form class="card settings" data-form="settings">
    <h2>研究の情報</h2>
    <label class="field">論文の種類
      <select name="kind">${Object.keys(KINDS).map((k) => `<option ${p.kind === k ? 'selected' : ''}>${k}</option>`).join('')}</select>
    </label>
    <label class="field">論文のタイトル(仮でかまいません)<input name="title" value="${esc(p.title)}" maxlength="200"></label>
    <label class="field">研究の問い<textarea name="rq" rows="3" maxlength="1000" placeholder="例:オンライン授業での発言のしやすさは、カメラのオン・オフで変わるか">${esc(p.rq)}</textarea></label>
    <label class="field">分野<input name="field" value="${esc(p.field)}" maxlength="100" placeholder="例:教育心理学"></label>
    <div class="row wrap">
      <label class="field grow">氏名<input name="author" value="${esc(p.author)}" maxlength="100"></label>
      <label class="field grow">所属<input name="affiliation" value="${esc(p.affiliation)}" maxlength="100" placeholder="例:〇〇大学大学院 〇〇研究科"></label>
    </div>
    <label class="field">全体の目標文字数<input type="number" name="targetChars" min="1000" max="300000" step="1000" value="${Number(p.targetChars)}"></label>

    <h2>章立て</h2>
    <ul class="plain stack-s">${secs}</ul>
    <button type="button" class="btn btn-plain" data-action="add-section">＋ 章を追加</button>

    <div class="row end"><button class="btn btn-accent">保存する</button></div>
  </form>

  <section class="card">
    <h2>バックアップ</h2>
    <p class="small muted">データはこのブラウザの中だけにあります。ブラウザの履歴を消すと消えることがあるので、ときどきバックアップを保存してください。別のパソコンへ移すときも使えます。</p>
    <div class="row wrap">
      <button class="btn btn-plain" data-action="backup">バックアップを保存</button>
      <button class="btn btn-plain" data-action="restore">バックアップから戻す</button>
      <button class="btn btn-danger-plain" data-action="reset">すべてのデータを消す</button>
    </div>
  </section>`;
}

// ---- 検索 ----
function viewSearch() {
  const q = searchQuery.trim().toLowerCase();
  if (!q) return '<section class="card"><p class="muted">検索する言葉を入力してください。</p></section>';
  const hit = (t) => String(t || '').toLowerCase().includes(q);
  const snippet = (t) => {
    const s = String(t || '');
    const i = s.toLowerCase().indexOf(q);
    const from = Math.max(0, i - 40);
    return (from ? '…' : '') + esc(s.slice(from, i)) + `<mark>${esc(s.slice(i, i + q.length))}</mark>` + esc(s.slice(i + q.length, i + q.length + 60)) + '…';
  };
  const out = [];
  for (const s of state.sections) {
    if (hit(s.text) || hit(s.title)) out.push({ where: '論文', title: s.title, text: hit(s.text) ? snippet(s.text) : '', go: 'paper' });
  }
  for (const m of state.materials) {
    const t = hit(m.summary) ? m.summary : hit(m.text) ? m.text : '';
    if (hit(m.name) || t) out.push({ where: '研究資料', title: m.name, text: t ? snippet(t) : '', go: 'materials' });
  }
  for (const l of state.logs) {
    if (hit(l.text)) out.push({ where: '研究ログ', title: formatDate(l.date), text: snippet(l.text), go: 'logs' });
  }
  for (const d of state.deadlines) {
    if (hit(d.title)) out.push({ where: '締切', title: d.title, text: esc(formatDate(d.date)), go: 'deadlines' });
  }
  const list = out.map((r) => `
    <li class="search-hit">
      <button class="link" data-go="${r.go}"><span class="tag">${r.where}</span> ${esc(r.title)}</button>
      ${r.text ? `<p class="small">${r.text}</p>` : ''}
    </li>`).join('');
  return `<section class="card"><h2>「${esc(searchQuery)}」の検索結果(${out.length}件)</h2>
    <ul class="plain stack-s">${list || '<li class="muted">見つかりませんでした。</li>'}</ul></section>`;
}

// ---- 操作 ----
function find(list, id) {
  return list.find((x) => x.id === id);
}

function addLog(text, date = todayStr(), tag = 'その他') {
  const log = { id: uid(), date, tag, text, createdAt: Date.now(), reflect: '', reflectedTo: [] };
  state.logs.push(log);
  save();
  enqueueWrite({ kind: 'log', text: `${date} [${tag}] ${text}` }, log);
}

const actions = {
  'pick-files': () => $('#file-input').click(),
  'toggle-material': (id) => { openMaterial = openMaterial === id ? null : id; render(); },
  resummarize: (id) => { const m = find(state.materials, id); if (m) summarize(m); },
  'delete-material': async (id) => {
    const m = find(state.materials, id);
    if (!m || !(await ask(`「${m.name}」を削除しますか?(論文に書かれた文は残ります)`))) return;
    state.materials = state.materials.filter((x) => x.id !== id);
    save();
    render();
  },
  'retry-reflect': (id) => {
    const l = find(state.logs, id);
    if (l) return enqueueWrite({ kind: 'log', text: `${l.date} [${l.tag}] ${l.text}` }, l);
    const m = find(state.materials, id);
    if (m) enqueueWrite({ kind: 'material', text: m.citation || m.name }, m);
  },
  'delete-log': async (id) => {
    if (!(await ask('このログを削除しますか?(論文に書かれた文は残ります)'))) return;
    state.logs = state.logs.filter((x) => x.id !== id);
    save();
    render();
  },
  'edit-section': (id) => { editingSection = id; render(); document.querySelector(`#edit-${id}`)?.focus(); },
  'cancel-edit': () => { editingSection = null; render(); },
  'lock-section': (id, el) => {
    const s = find(state.sections, id);
    if (s) { s.locked = el.checked; save(); }
  },
  'export-docx': exportDocx,
  'export-pdf': exportPdf,
  'rewrite-all': async () => {
    if (!(await ask('すべての材料を見直して、論文全体を整えますか?(「書き換え禁止」の章は変わりません)'))) return;
    enqueueWrite({ kind: 'all' }, null);
  },
  'toggle-deadline': (id, el) => {
    const d = find(state.deadlines, id);
    if (d) { d.done = el.checked; save(); render(); }
  },
  'delete-deadline': async (id) => {
    if (!(await ask('この締切を削除しますか?'))) return;
    state.deadlines = state.deadlines.filter((x) => x.id !== id);
    save();
    render();
  },
  'add-section': () => {
    readSettingsForm();
    state.sections.push({ id: uid(), title: '新しい章', weight: 2, text: '', locked: false, updatedAt: 0 });
    render();
  },
  'move-section': (id, el) => {
    readSettingsForm();
    const i = state.sections.findIndex((s) => s.id === id);
    const j = i + Number(el.dataset.dir);
    if (i < 0 || j < 0 || j >= state.sections.length) return;
    [state.sections[i], state.sections[j]] = [state.sections[j], state.sections[i]];
    render();
  },
  'delete-section': async (id) => {
    const s = find(state.sections, id);
    if (!s) return;
    if (state.sections.length <= 1) return toast('章は1つ以上必要です。', true);
    readSettingsForm();
    if (!(await ask(`章「${s.title}」を削除しますか?この章の本文も消えます。`))) return;
    state.sections = state.sections.filter((x) => x.id !== id);
    save();
    render();
  },
  backup: () => {
    const blob = new Blob([JSON.stringify(state, null, 1)], { type: 'application/json' });
    download(blob, `論文ノート_バックアップ_${todayStr()}.json`);
  },
  restore: () => $('#backup-input').click(),
  reset: async () => {
    if (!(await ask('すべてのデータ(資料・ログ・締切・論文)を消しますか?元に戻せません。'))) return;
    state = newState();
    save();
    go('settings');
  },
};

// 設定画面の入力を、保存ボタンを押す前でも state に写す(章の追加・並べ替えで入力が消えないように)
function readSettingsForm() {
  const f = document.querySelector('[data-form="settings"]');
  if (!f) return;
  const fd = new FormData(f);
  const p = state.project;
  p.kind = fd.get('kind') || p.kind;
  p.title = String(fd.get('title') || '').trim();
  p.rq = String(fd.get('rq') || '').trim();
  p.field = String(fd.get('field') || '').trim();
  p.author = String(fd.get('author') || '').trim();
  p.affiliation = String(fd.get('affiliation') || '').trim();
  p.targetChars = Math.min(300000, Math.max(1000, Number(fd.get('targetChars')) || KINDS[p.kind]));
  for (const s of state.sections) {
    const t = String(fd.get(`sec-${s.id}`) || '').trim();
    if (t) s.title = t;
    s.weight = Number(fd.get(`w-${s.id}`)) || s.weight;
  }
}

const forms = {
  'quick-log': (f) => {
    const input = f.querySelector('input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    addLog(text);
  },
  log: (f) => {
    const fd = new FormData(f);
    const text = String(fd.get('text') || '').trim();
    if (!text) return;
    f.querySelector('textarea').value = '';
    addLog(text, String(fd.get('date')) || todayStr(), String(fd.get('tag')));
  },
  'edit-section': (f) => {
    const s = find(state.sections, f.dataset.id);
    if (!s) return;
    s.text = String(new FormData(f).get('text') || '').trim();
    s.updatedAt = Date.now();
    editingSection = null;
    save();
    render();
    toast(`「${s.title}」を保存しました。`);
  },
  deadline: (f) => {
    const fd = new FormData(f);
    const title = String(fd.get('title') || '').trim();
    const date = String(fd.get('date') || '');
    if (!title || !date) return;
    state.deadlines.push({ id: uid(), title, date, done: false });
    for (const el of f.querySelectorAll('input')) el.value = '';
    save();
    render();
  },
  settings: (f) => {
    const before = state.project.kind;
    readSettingsForm();
    // 種類を変えたのに目標文字数がそのままなら、種類の目安に合わせる
    if (before !== state.project.kind && Number(new FormData(f).get('targetChars')) === KINDS[before]) {
      state.project.targetChars = KINDS[state.project.kind];
    }
    const first = !state.project.setupDone;
    state.project.setupDone = true;
    save();
    toast('保存しました。');
    if (first) go('home');
    else render();
  },
};

// ---- 書き出し ----
function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

function fileSafe(name) {
  return String(name || '論文').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || '論文';
}

async function exportDocx() {
  try {
    const res = await api('/api/export/docx', {
      project: state.project,
      sections: state.sections.map((s) => ({ title: s.title, text: s.text })),
      references: references(),
    });
    download(await res.blob(), `${fileSafe(state.project.title)}.docx`);
  } catch (err) {
    toast(err.message, true);
  }
}

function exportPdf() {
  $('#print-paper').innerHTML = paperBody({ forPrint: true });
  toast('印刷の画面で、送信先(プリンター)を「PDFに保存」にしてください。');
  setTimeout(() => window.print(), 300);
}

// ---- 確認ダイアログ(confirm() は環境によって出ないので自前) ----
function ask(message) {
  return new Promise((resolve) => {
    const back = $('#dialog');
    $('#dialog-text').textContent = message;
    back.hidden = false;
    $('#dialog-no').focus();
    const done = (v) => {
      back.hidden = true;
      $('#dialog-yes').onclick = null;
      $('#dialog-no').onclick = null;
      back.onkeydown = null;
      resolve(v);
    };
    $('#dialog-yes').onclick = () => done(true);
    $('#dialog-no').onclick = () => done(false);
    back.onkeydown = (e) => { if (e.key === 'Escape') done(false); };
  });
}

let toastTimer = null;
function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 8000 : 4000);
}

// ---- イベント ----
document.addEventListener('click', (e) => {
  const nav = e.target.closest('[data-view]');
  if (nav) return go(nav.dataset.view);
  const goBtn = e.target.closest('[data-go]');
  if (goBtn) return go(goBtn.dataset.go);
  const act = e.target.closest('[data-action]');
  if (act && act.tagName !== 'INPUT' && actions[act.dataset.action]) {
    e.preventDefault();
    actions[act.dataset.action](act.dataset.id, act);
  }
});

document.addEventListener('change', (e) => {
  const act = e.target.closest('input[data-action]');
  if (act && actions[act.dataset.action]) actions[act.dataset.action](act.dataset.id, act);
});

document.addEventListener('submit', (e) => {
  const f = e.target.closest('[data-form]');
  if (f && forms[f.dataset.form]) {
    e.preventDefault();
    forms[f.dataset.form](f);
  }
});

$('#search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  searchQuery = $('#search').value;
  go('search');
});

const fileInput = $('#file-input');
fileInput.accept = ACCEPT;
fileInput.addEventListener('change', () => {
  const files = [...fileInput.files];
  fileInput.value = '';
  if (files.length) {
    if (view !== 'materials') go('materials');
    addFiles(files);
  }
});

// ファイルをドラッグして追加(研究資料の画面のどこに落としてもよい)
document.addEventListener('dragover', (e) => {
  if (e.dataTransfer?.types?.includes('Files')) {
    e.preventDefault();
    $('#drop')?.classList.add('over');
  }
});
document.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) $('#drop')?.classList.remove('over');
});
document.addEventListener('drop', (e) => {
  if (!e.dataTransfer?.files?.length) return;
  e.preventDefault();
  $('#drop')?.classList.remove('over');
  if (view !== 'materials') go('materials');
  addFiles([...e.dataTransfer.files]);
});

$('#backup-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || data.version !== 1 || !data.project || !Array.isArray(data.sections)) throw new Error();
    if (!(await ask('バックアップの内容で、今のデータを置き換えますか?'))) return;
    state = { ...newState(), ...data };
    save();
    toast('バックアップから戻しました。');
    go('home');
  } catch {
    toast('このファイルは論文ノートのバックアップとして読めませんでした。', true);
  }
});

window.addEventListener('hashchange', () => {
  const name = location.hash.slice(1);
  if (name && name !== view) go(name);
});

// 「たった今更新」の印を時間がたったら消す
setInterval(() => { if (view === 'paper' && !editingSection) render(); }, 60 * 1000);

// ---- はじめに ----
(async () => {
  try {
    const saved = await loadState();
    if (saved) {
      state = { ...newState(), ...saved };
      // 途中で閉じられた処理は「失敗」として扱い、やり直せるようにする
      for (const m of state.materials) {
        if (m.status === 'reading' || m.status === 'summarizing') {
          m.status = 'error';
          m.error = m.text ? '要約の途中でページが閉じられました。「要約をやり直す」を押してください。' : '読み取りの途中でページが閉じられました。もう一度追加してください。';
        }
      }
      for (const item of [...state.materials, ...state.logs]) {
        if (item.reflect === 'waiting' || item.reflect === 'writing') {
          item.reflect = 'error';
          item.reflectError = '反映の途中でページが閉じられました。';
        }
      }
    }
  } catch (err) {
    console.error(err);
    toast('保存したデータを読み込めませんでした。プライベートモードではデータが残りません。', true);
  }
  const hash = location.hash.slice(1);
  view = !state.project.setupDone ? 'settings' : ['home', 'materials', 'logs', 'paper', 'deadlines', 'settings'].includes(hash) ? hash : 'home';
  render();
})();
