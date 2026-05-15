# MJ Insight Vault

MJのキャプチャ画像を個人用に蓄積し、Google Vision OCRで記事候補化し、OpenAI APIでチャット分析・類似記事検索を行うPWAのMVPです。

## 実装済みの範囲

- PWA / Next.js App Router
- 固定パスコード方式の簡易保護
- PC・スマホ対応UI
- 最大20枚の画像一括アップロード
- アップロード時メモ
- Supabase Storageへの画像保存
- Google Vision OCR `documentTextDetection`
- OCRテキストからの記事候補分割
- 記事ごとのエンベディング生成
- Supabase pgvectorによる類似記事検索RPC
- チャット分析
- 回答の `chat_reports` 保存
- 記事詳細から元画像へ復帰
- タグ管理
- 分析メモの手修正保存

## MVPであえて未実装にしたもの

- 本格ログイン
- レポート一覧画面
- OCR本文の詳細手修正
- 完全な図表読解
- PowerPoint自動生成
- バックグラウンドキュー
- 複数ユーザー管理

## セットアップ

### 1. Supabase作成

Supabaseで新規プロジェクトを作成し、SQL Editorで `supabase/schema.sql` を実行してください。

Storageで `mj-images` というバケットを作成してください。最初は **private bucket** 推奨です。

### 2. Google Cloud Vision API

Google CloudでVision APIを有効化し、サービスアカウントJSONを取得してください。
Vercelでは `GOOGLE_APPLICATION_CREDENTIALS_JSON` にJSONを1行で貼ります。

### 3. OpenAI APIキー

OpenAI APIキーを取得してください。

### 4. 環境変数

`.env.example` を参考に、Vercelまたはローカル `.env.local` に設定します。

```bash
APP_PASSWORD=任意の固定パスコード
NEXT_PUBLIC_SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_STORAGE_BUCKET=mj-images
OPENAI_API_KEY=...
OPENAI_TEXT_MODEL=gpt-4o-mini
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
GOOGLE_APPLICATION_CREDENTIALS_JSON={...}
```

### 5. ローカル起動

```bash
npm install
npm run dev
```

### 6. Vercelデプロイ

GitHubにpushし、VercelでImportしてください。環境変数を設定すれば動きます。

## 重要な注意

### Vercelのアップロード制限

20枚を一括アップロードする場合、画像サイズが大きいとVercelのリクエスト制限や実行時間制限に当たる可能性があります。
実務運用では、スマホ側で画像を小さく撮る、または後続でブラウザ内リサイズを追加してください。

### 図表読解

OCRは図表内の文字を拾えますが、表構造・グラフ解釈は完全ではありません。重要な図表は記事詳細の元画像で確認してください。

### ログインなし運用

ログイン不要の代わりに固定パスコードを使います。URLを知った第三者がアクセスできないよう、`APP_PASSWORD` は必ず設定してください。

## 推奨する次の改善

1. ブラウザ側で画像をJPEG圧縮・リサイズしてからアップロード
2. OCR処理をキュー化して20枚投入時の安定性を上げる
3. レポート一覧画面を追加
4. 記事にタグを手動付与するUIを追加
5. 記事候補分割の精度検証
6. 図表だけ必要時に画像LLMへ渡すルートを追加
