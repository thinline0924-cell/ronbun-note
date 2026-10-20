// 研究資料(PDF・Word・PowerPoint・テキスト)から文字を取り出す
// 読み取りはすべてブラウザの中で行います。

const KINDS = [
  { kind: 'PDF', exts: ['pdf'] },
  { kind: 'Word', exts: ['docx'] },
  { kind: 'PPT', exts: ['pptx'] },
  { kind: 'テキスト', exts: ['txt', 'md', 'csv'] },
];

export const ACCEPT = '.pdf,.docx,.pptx,.txt,.md,.csv';

function extOf(name) {
  const m = String(name).toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

// 読める種類なら 'PDF' などを、読めなければ null を返す
export function fileKind(name) {
  const ext = extOf(name);
  return KINDS.find((k) => k.exts.includes(ext))?.kind || null;
}

// 読めない種類のときの説明
export function unsupportedReason(name) {
  const ext = extOf(name);
  if (ext === 'doc') return '古い Word 形式(.doc)は読めません。Word で開いて「.docx」で保存し直してください。';
  if (ext === 'ppt') return '古い PowerPoint 形式(.ppt)は読めません。PowerPoint で開いて「.pptx」で保存し直してください。';
  return '読める形式は PDF・Word(.docx)・PowerPoint(.pptx)・テキスト(.txt .md .csv)です。';
}

let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('/vendor/pdfjs/pdf.min.mjs').then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
      return pdfjs;
    });
  }
  return pdfjsPromise;
}

const scriptPromises = {};
function loadScript(src) {
  if (!scriptPromises[src]) {
    scriptPromises[src] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('読み取り用の部品を読み込めませんでした。ページを再読み込みしてください。'));
      document.head.appendChild(s);
    });
  }
  return scriptPromises[src];
}

async function readPdf(file) {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    // 日本語の PDF を読むための文字の対応表
    cMapUrl: '/vendor/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
    isEvalSupported: false,
  });
  const doc = await task.promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let text = '';
    for (const item of content.items) {
      if (typeof item.str !== 'string') continue;
      text += item.str;
      if (item.hasEOL) text += '\n';
    }
    pages.push(text);
  }
  await task.destroy();
  return pages.join('\n\n');
}

async function readDocx(file) {
  await loadScript('/vendor/mammoth.js');
  const result = await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  return result.value;
}

async function readPptx(file) {
  await loadScript('/vendor/jszip.js');
  const zip = await window.JSZip.loadAsync(await file.arrayBuffer());
  const slides = Object.keys(zip.files)
    .map((name) => ({ name, n: Number(name.match(/^ppt\/slides\/slide(\d+)\.xml$/)?.[1]) }))
    .filter((s) => s.n)
    .sort((a, b) => a.n - b.n);
  const out = [];
  for (const s of slides) {
    const xml = new DOMParser().parseFromString(await zip.file(s.name).async('string'), 'application/xml');
    const paras = [...xml.getElementsByTagNameNS('*', 'p')]
      .map((p) => [...p.getElementsByTagNameNS('*', 't')].map((t) => t.textContent).join(''))
      .filter((t) => t.trim());
    out.push(`[スライド${s.n}]\n${paras.join('\n')}`);
  }
  return out.join('\n\n');
}

// ファイルから文字を取り出す
export async function extractText(file) {
  const kind = fileKind(file.name);
  let text = '';
  if (kind === 'PDF') text = await readPdf(file);
  else if (kind === 'Word') text = await readDocx(file);
  else if (kind === 'PPT') text = await readPptx(file);
  else if (kind === 'テキスト') text = await file.text();
  else throw new Error(unsupportedReason(file.name));
  return text.replace(/\r\n?/g, '\n').replace(/[ \t　]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
