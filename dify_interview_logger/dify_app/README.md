# Dify App v2

このフォルダは、既存Dify BOTのexport YAMLから、5日間継続・ローカル記録対応のv2 YAMLを生成するための手順です。

GitHubリポジトリがpublicの場合、調査票やプロンプト全文を含む実物YAMLは公開しない方針にしています。生成されたYAMLは`dify_app/local/`に作られ、`.gitignore`で除外されます。

## 生成

```powershell
cd "<workspace>\dify_interview_logger"
python .\tools\build_dify_app_v2.py "C:\path\to\インタビューBOT.yml"
```

今回のローカル環境での例:

```powershell
python .\tools\build_dify_app_v2.py "C:\Users\<user>\Downloads\インタビューBOT.yml"
```

出力:

```text
dify_app/local/インタビューBOT_v2_local_logger.yml
```

## Difyでの使い方

1. DifyのStudioで「Import DSL file」を選ぶ。
2. `dify_app/local/インタビューBOT_v2_local_logger.yml`を読み込む。
3. HTTP RequestノードのURLを運用環境に合わせて確認する。

URLの目安:

- DifyをローカルDockerで動かす場合: `http://host.docker.internal:8787/dify/log`
- Dify Cloudから送る場合: `https://<tunnel-domain>/dify/log`
- 同じWindows上のローカルプロセスから直接試す場合: `http://127.0.0.1:8787/dify/log`

Dify Cloudや外部公開URLで使う場合は、ローカルロガー側で`DIFY_LOG_TOKEN`を設定し、DifyのHTTP Request Headerに以下を追加してください。

```text
Authorization: Bearer <token>
```

## v2で変わること

- 開始フォームに「回答者ID（任意）」を追加
- Google Apps Script送信をローカルロガー送信に変更
- 同じ回答者ID、または同じDify conversation IDで継続記録
- 5日間の途中離脱・翌日再開を前提にした案内を追加
- 生成されたログはローカルSQLiteへ保存され、必要時にExcel/CSVへ出力
