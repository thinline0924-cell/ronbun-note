// 論文ノート — 研究の記録から日本語の論文が育っていくアプリのサーバー
// 要約と論文の執筆は Google Gemini API(@google/genai の Interactions API)で行います。
// APIキーはこのファイルの中(サーバー側)だけで使い、ブラウザには送りません。
// 研究のデータはブラウザの中に保存します。サーバーには保存しません。

import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { GoogleGenAI } from '@google/genai';
import {
  AlignmentType, Document, HeadingLevel, Packer, Paragraph, TextRun,
} from 'docx';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- 設定(環境変数から読む。Render の画面で入力します) ----
const PORT = Number(process.env.PORT) || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const MODEL = process.env.GEMINI_MODEL || 'gemini-4-argon';

const MAX_MATERIAL_CHARS = 60000; // 要約に送る資料の文字数の上限
const MAX_SECTION_CHARS = 20000; // 1つの章の文字数の上限
const MAX_SECTIONS = 20;
const MAX_LOGS = 80; // 執筆に使う研究ログの件数
const MAX_MATERIALS = 60; // 執筆に使う資料の件数
const TEN_MINUTES = 10 * 60 * 1000;

const ai = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

const app = express();
// Render の中継サーバー(プロキシ)越しでも、利用者の本当の IP を使う
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '3mb' }));
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// ファイルを読むためのライブラリ(npm install で入ったもの)をブラウザに渡す
const modules = path.join(__dirname, 'node_modules');
app.use('/vendor/pdfjs', express.static(path.join(modules, 'pdfjs-dist', 'build')));
app.use('/vendor/pdfjs/cmaps', express.static(path.join(modules, 'pdfjs-dist', 'cmaps')));
app.use('/vendor/pdfjs/standard_fonts', express.static(path.join(modules, 'pdfjs-dist', 'standard_fonts')));
app.get('/vendor/mammoth.js', (req, res) => res.sendFile(path.join(modules, 'mammoth', 'mammoth.browser.min.js')));
app.get('/vendor/jszip.js', (req, res) => res.sendFile(path.join(modules, 'jszip', 'dist', 'jszip.min.js')));

// ---- 回数制限(同じ IP からの使いすぎを防ぐ) ----
function createRateLimiter(limit, windowMs, message) {
  const hits = new Map(); // ip -> 呼ばれた時刻の一覧
  setInterval(() => {
    const now = Date.now();
    for (const [ip, times] of hits) {
      const recent = times.filter((t) => now - t < windowMs);
      if (recent.length) hits.set(ip, recent);
      else hits.delete(ip);
    }
  }, 60 * 1000).unref();

  return (req, res, next) => {
    const now = Date.now();
    const ip = req.ip || 'unknown';
    const recent = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    if (recent.length >= limit) {
      const retrySec = Math.ceil((windowMs - (now - recent[0])) / 1000);
      res.set('Retry-After', String(retrySec));
      return res.status(429).json({ error: message });
    }
    recent.push(now);
    hits.set(ip, recent);
    next();
  };
}

const summarizeLimiter = createRateLimiter(
  20,
  TEN_MINUTES,
  '資料の読み取りが多すぎます(10分に20件まで)。少し待ってから「要約をやり直す」を押してください。'
);
const writeLimiter = createRateLimiter(
  40,
  TEN_MINUTES,
  '論文への反映が多すぎます(10分に40回まで)。少し待ってから「もう一度反映」を押してください。'
);
const exportLimiter = createRateLimiter(
  30,
  TEN_MINUTES,
  'Word の書き出しが多すぎます(10分に30回まで)。少し待ってから試してください。'
);

function requireApiKey(req, res, next) {
  if (ai) return next();
  res.status(500).json({
    error: 'Gemini の APIキーが設定されていません(Render の Environment で GEMINI_API_KEY を設定してください)。',
  });
}

// ---- Gemini のエラーを、初心者にも分かる日本語に直す ----
function toJapaneseError(err) {
  const status = err?.status ?? err?.statusCode;
  const msg = String(err?.message || '');

  if (/api key|api_key|apikey/i.test(msg) && (status === 400 || status === 401 || status === 403)) {
    return { status: 500, error: 'Gemini のAPIキーが正しくありません(GEMINI_API_KEY を確認)。' };
  }
  if (status === 401 || status === 403) {
    return {
      status: 500,
      error: 'Gemini のAPIキーに使う権限がありません(GEMINI_API_KEY が正しいか、Google AI Studio でキーが有効か確認)。',
    };
  }
  if (status === 429) {
    return {
      status: 429,
      error: 'Gemini の利用上限に達しました。しばらく待ってから試すか、Google AI Studio で利用状況を確認してください。',
    };
  }
  if (status === 404) {
    return { status: 500, error: `Gemini のモデル「${MODEL}」が見つかりません(GEMINI_MODEL のモデル名を確認)。` };
  }
  if (status === 400) {
    return {
      status: 500,
      error: `Gemini へのリクエストが受け付けられませんでした(GEMINI_MODEL のモデル名が合っているか確認)。詳細: ${msg.slice(0, 200)}`,
    };
  }
  if (status >= 500) {
    return { status: 502, error: 'Gemini 側が混み合っているか、一時的な不具合です。少し待ってからもう一度試してください。' };
  }
  if (/fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|timeout|connection/i.test(msg)) {
    return { status: 502, error: 'Gemini につながりませんでした。少し待ってからもう一度試してください。' };
  }
  return { status: 500, error: `思わぬエラーが起きました。少し待ってからもう一度試してください。詳細: ${msg.slice(0, 200)}` };
}

function sendGeminiError(res, err, where) {
  console.error(`[${where}] Gemini error:`, err?.status, err?.message);
  const e = toJapaneseError(err);
  res.status(e.status).json({ error: e.error });
}

// Gemini に JSON で答えてもらう
async function askJson(systemInstruction, text, schema, maxTokens) {
  const interaction = await ai.interactions.create({
    model: MODEL,
    system_instruction: systemInstruction,
    input: [{ type: 'user_input', content: [{ type: 'text', text }] }],
    store: false,
    response_format: { type: 'text', mime_type: 'application/json', schema },
    generation_config: {
      max_output_tokens: maxTokens,
      thinking_level: 'low',
    },
  });
  const raw = String(interaction.output_text || '').trim();
  // 念のため、```json … ``` で囲まれていたら外す
  const body = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(body);
}

function str(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

// ---- 資料の要約 ----
const SUMMARY_INSTRUCTION = `あなたは大学の研究室で、研究資料を読んで要点をまとめる手伝いをしています。
渡された資料の本文を読み、日本語で次のものを作ってください。
- summary:資料の要約(400〜800字。である調。資料に書かれていないことは書かない)
- points:論文を書くときに使えそうな要点(3〜6個。各60字以内)
- citation:資料から分かる書誌情報(著者・年・タイトル・掲載誌や出版社)。
  「著者(年)『タイトル』掲載誌」のような形で1行に。分からない部分は書かない。何も分からなければ空文字`;

const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    points: { type: 'array', items: { type: 'string' } },
    citation: { type: 'string' },
  },
  required: ['summary', 'points', 'citation'],
};

app.post('/api/summarize', summarizeLimiter, requireApiKey, async (req, res) => {
  const name = str(req.body?.name, 200);
  const text = str(req.body?.text, MAX_MATERIAL_CHARS).trim();
  if (!text) {
    return res.status(400).json({ error: '資料から文字を読み取れませんでした(画像だけのPDFなどは読めません)。' });
  }

  try {
    const out = await askJson(SUMMARY_INSTRUCTION, `資料名:${name}\n\n--- 本文 ---\n${text}`, SUMMARY_SCHEMA, 2048);
    res.json({
      summary: str(out.summary, 2000),
      points: Array.isArray(out.points) ? out.points.slice(0, 8).map((p) => str(p, 200)) : [],
      citation: str(out.citation, 300),
    });
  } catch (err) {
    if (err instanceof SyntaxError) {
      return res.status(502).json({ error: 'Gemini の答えを読み取れませんでした。もう一度「要約をやり直す」を押してください。' });
    }
    sendGeminiError(res, err, 'summarize');
  }
});

// ---- 論文の執筆(研究が進むたびに呼ばれる) ----
const WRITE_INSTRUCTION = `あなたは大学生・大学院生の論文執筆を手伝う、ていねいな共同執筆者です。
研究者本人が書いた「研究ログ」と「研究資料の要約」をもとに、日本語の学術論文の本文を少しずつ書き進めます。

守ること:
- 文体は学術論文の「である調」。見出し記号(#)、箇条書き、Markdown は使わない。段落と段落の間は空行1つ
- 材料(研究ログ・資料の要約・今の本文)に書かれていないデータ、数値、結果、引用、文献を作らない
- 材料が足りない所は、無理に書かず【要確認:何が必要か】と書いておく
- 資料を使うときは、本文中に(資料の書誌情報 または 資料名)を添える
- 今の本文の内容は、新しい材料と矛盾しない限り残し、自然につながるように書き足す・整える
- 「書き換え禁止」の章は絶対に出力しない
- 新しい材料に関係する章だけを更新する。更新する章は、その章の本文全体を出力する
- note には、どの章に何を反映したかを、研究者本人に向けて1〜2文で書く`;

const WRITE_SCHEMA = {
  type: 'object',
  properties: {
    updates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['id', 'text'],
      },
    },
    note: { type: 'string' },
  },
  required: ['updates', 'note'],
};

function buildWritePrompt(body) {
  const p = body.project || {};
  const sections = (Array.isArray(body.sections) ? body.sections : []).slice(0, MAX_SECTIONS);
  const materials = (Array.isArray(body.materials) ? body.materials : []).slice(-MAX_MATERIALS);
  const logs = (Array.isArray(body.logs) ? body.logs : []).slice(-MAX_LOGS);
  const trigger = body.trigger || {};

  const lines = [];
  lines.push('# 論文の情報');
  lines.push(`種類:${str(p.kind, 30)}`);
  lines.push(`タイトル:${str(p.title, 200)}`);
  lines.push(`分野:${str(p.field, 100)}`);
  lines.push(`研究の問い:${str(p.rq, 1000)}`);
  lines.push(`全体の目標文字数:${Number(p.targetChars) || 20000}字`);
  lines.push('');
  lines.push('# 章と今の本文');
  for (const s of sections) {
    lines.push(`## id=${str(s.id, 40)} 「${str(s.title, 60)}」${s.locked ? '(書き換え禁止)' : ''} 目安${Number(s.target) || 0}字`);
    lines.push(str(s.text, MAX_SECTION_CHARS) || '(まだ何も書かれていない)');
    lines.push('');
  }
  lines.push('# 研究資料の要約');
  if (materials.length === 0) lines.push('(まだ無い)');
  for (const m of materials) {
    lines.push(`## ${str(m.citation, 300) || str(m.name, 200)}`);
    lines.push(str(m.summary, 2000));
    lines.push('');
  }
  lines.push('# 研究ログ(古い順)');
  if (logs.length === 0) lines.push('(まだ無い)');
  for (const l of logs) {
    lines.push(`- ${str(l.date, 30)} [${str(l.tag, 20)}] ${str(l.text, 1500)}`);
  }
  lines.push('');
  lines.push('# 今回のお願い');
  if (trigger.kind === 'log') {
    lines.push(`新しい研究ログが追加された:「${str(trigger.text, 1500)}」`);
    lines.push('このログに関係する章を書き進めてください。');
  } else if (trigger.kind === 'material') {
    lines.push(`新しい研究資料が追加された:「${str(trigger.text, 300)}」`);
    lines.push('この資料を、関係する章(主に先行研究)に反映してください。');
  } else {
    lines.push('すべての材料を見直して、書き換え禁止でない章を全体として整えてください。');
  }
  return { text: lines.join('\n'), sectionIds: new Set(sections.filter((s) => !s.locked).map((s) => String(s.id))) };
}

app.post('/api/write', writeLimiter, requireApiKey, async (req, res) => {
  const { text, sectionIds } = buildWritePrompt(req.body || {});
  if (sectionIds.size === 0) {
    return res.status(400).json({ error: '書き進められる章がありません(すべて「書き換え禁止」になっていないか確認)。' });
  }

  try {
    const out = await askJson(WRITE_INSTRUCTION, text, WRITE_SCHEMA, 16384);
    const updates = (Array.isArray(out.updates) ? out.updates : [])
      .filter((u) => sectionIds.has(String(u?.id)) && typeof u.text === 'string' && u.text.trim())
      .map((u) => ({ id: String(u.id), text: u.text.trim().slice(0, MAX_SECTION_CHARS) }));
    res.json({ updates, note: str(out.note, 400) });
  } catch (err) {
    if (err instanceof SyntaxError) {
      return res.status(502).json({ error: 'Gemini の答えが途中で切れたか、読み取れませんでした。もう一度「もう一度反映」を押してください。' });
    }
    sendGeminiError(res, err, 'write');
  }
});

// ---- Word(.docx)で書き出す ----
const MINCHO = { ascii: 'Times New Roman', hAnsi: 'Times New Roman', eastAsia: '游明朝' };

function paragraphsOf(text) {
  return String(text || '')
    .split(/\n\s*\n/)
    .map((t) => t.replace(/\s*\n\s*/g, '').trim())
    .filter(Boolean);
}

app.post('/api/export/docx', exportLimiter, async (req, res) => {
  const p = req.body?.project || {};
  const sections = (Array.isArray(req.body?.sections) ? req.body.sections : []).slice(0, MAX_SECTIONS);
  const references = (Array.isArray(req.body?.references) ? req.body.references : []).slice(0, 200);

  const children = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
      children: [new TextRun({ text: str(p.title, 200) || '(タイトル未設定)', bold: true, size: 32, font: MINCHO })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 400 },
      children: [new TextRun({ text: [str(p.affiliation, 100), str(p.author, 100)].filter(Boolean).join(' '), size: 22, font: MINCHO })],
    }),
  ];

  sections.forEach((s, i) => {
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 360, after: 120 },
      children: [new TextRun({ text: `${i + 1}. ${str(s.title, 60)}`, bold: true, size: 26, font: MINCHO, color: '000000' })],
    }));
    for (const para of paragraphsOf(str(s.text, MAX_SECTION_CHARS))) {
      children.push(new Paragraph({
        indent: { firstLineChars: 100 },
        spacing: { line: 360 },
        children: [new TextRun({ text: para, size: 21, font: MINCHO })],
      }));
    }
  });

  if (references.length) {
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 360, after: 120 },
      children: [new TextRun({ text: '参考文献', bold: true, size: 26, font: MINCHO, color: '000000' })],
    }));
    for (const r of references) {
      children.push(new Paragraph({
        indent: { left: 420, hanging: 420 },
        children: [new TextRun({ text: str(r, 300), size: 21, font: MINCHO })],
      }));
    }
  }

  try {
    const doc = new Document({
      creator: str(p.author, 100) || '論文ノート',
      title: str(p.title, 200),
      sections: [{
        properties: {
          page: {
            size: { width: 11906, height: 16838 }, // A4
            margin: { top: 1701, bottom: 1701, left: 1418, right: 1418 },
          },
        },
        children,
      }],
    });
    const buffer = await Packer.toBuffer(doc);
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.set('Content-Disposition', 'attachment; filename="paper.docx"');
    res.set('Cache-Control', 'no-store');
    res.send(buffer);
  } catch (err) {
    console.error('[export] docx error:', err?.message);
    res.status(500).json({ error: 'Word ファイルを作れませんでした。少し待ってからもう一度試してください。' });
  }
});

app.get('/healthz', (req, res) => res.send('ok'));

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'そのAPIはありません。' });
});

// 大きすぎる送信などのエラーも日本語で返す
app.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: '送るデータが大きすぎます。資料や研究ログを減らしてから試してください。' });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: '送ったデータの形が正しくありません。ページを再読み込みしてから試してください。' });
  }
  console.error('[server] error:', err?.message);
  res.status(500).json({ error: '思わぬエラーが起きました。少し待ってからもう一度試してください。' });
});

app.listen(PORT, () => {
  console.log(`論文ノート is ready on port ${PORT}`);
  console.log(`model: ${MODEL}`);
  if (!GEMINI_API_KEY) console.warn('GEMINI_API_KEY が設定されていません。');
});
