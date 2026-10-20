# CLAUDE.md — このリポジトリで作業するときのルール

大学生・大学院生向けの「論文ノート」。研究資料と研究ログから、日本語の論文がその場で書き進むブラウザのアプリ。
持ち主はプログラミング初心者。**説明は日本語で、専門用語には短い説明を付ける。**
**分からないことや決めていないことは、勝手に進めずに毎回持ち主に聞く**(持ち主の希望)。

## 持ち主の環境

- 持ち主のパソコンには Node.js が入っていない。ローカル実行を前提にしない
- 公開は Render(Blueprint、`render.yaml`)。手順は README.md。手順が変わったら README も直す

## 守る約束

1. **APIキーをコードやファイルに書かない。** キーは環境変数 `GEMINI_API_KEY` から server.js だけが読む。`public/` 以下には書かない・送らない
2. AI は **Google Gemini API だけ**(`@google/genai` の Interactions API `client.interactions.create`)。
   書き方が分からない所は推測せず、公式ドキュメントか `@google/genai` の型定義で確かめる
   - モデルは持ち主の希望で **Gemini 4**(`gemini-4-argon`。「4.0」という名前のモデルは無い)。環境変数 `GEMINI_MODEL` で変えられる
3. **研究データはブラウザの中(IndexedDB)だけに保存する**(持ち主の決定)。サーバーには保存しない。Gemini には `store: false` で送る
4. **合言葉は付けない**(持ち主の決定)。代わりに IP ごとの回数制限を外さない・ゆるめない
   (要約 10分20件、反映 10分40回、Word 書き出し 10分30回、`app.set('trust proxy', 1)`)
5. **ビルドツールを入れない。** 画面は素の HTML / CSS / JavaScript(ES モジュール)。React・bundler などは使わない
6. 論文の中身を作り話にしない:研究ログ・資料の要約・今の本文に無いデータや文献は書かせない。足りない所は【要確認:…】

## 見た目

- UI は候補3案のうち **案A(ダッシュボード型)**:左に青紫のメニュー、上に「次の締切・研究の問い・論文の完成度」のカード
- 色は案Aのまま(青紫 #3B44C6、黄色 #FFC93C)。**「AIっぽく」しない**(持ち主の希望):
  グラデーション、光る効果、大きな影、キラキラのアイコン、絵文字、「AIが生成」のような表示は使わない
- フォントは Noto Sans JP、論文の本文は Noto Serif JP。820px 以下ではメニューが上に並ぶ

## ファイルの役割

| ファイル | 役割 |
|---|---|
| `server.js` | Express。静的ファイル、`/api/summarize`(資料の要約)、`/api/write`(論文の執筆)、`/api/export/docx`(Word)、回数制限、エラーの日本語化。読み取り用ライブラリを `/vendor/` で配る |
| `public/index.html` | 画面の骨組み |
| `public/style.css` | 見た目。印刷(PDF で保存)用の指定もここ |
| `public/app.js` | 画面の切り替え、資料・ログ・締切・設定、論文への反映(1件ずつ順番に)、書き出し、検索、バックアップ |
| `public/readers.js` | PDF(pdfjs-dist)・Word(mammoth)・PowerPoint(jszip)・テキストから文字を取り出す。画像の文字読み取りはしない(持ち主の決定) |
| `public/store.js` | IndexedDB への保存と読み込み |
| `render.yaml` | Render Blueprint(`GEMINI_API_KEY` は `sync: false`) |

## 論文の仕様

- 論文は日本語・である調。既定の章立ては 序論・先行研究・研究方法・結果・考察・結論(設定で変えられる)
- 研究ログを追加 → `/api/write`(trigger: log)で関係する章だけ更新。資料を追加 → 要約のあと trigger: material
- Gemini には JSON で答えさせる(`response_format: { type: 'text', mime_type: 'application/json', schema }`)
- 完成度は、各章の文字数 ÷ 目安(全体の目標文字数を章の「分量」で割り振ったもの)
- 書き出し:Word はサーバーで `docx` を使って作る。PDF はブラウザの印刷(「PDFに保存」)
- 参考文献は、要約済みの資料の書誌情報(無ければファイル名)の一覧
