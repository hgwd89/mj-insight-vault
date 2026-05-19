# Dify Interview Logger

DifyのチャットボットからHTTP Requestで会話ログを受け取り、ローカルSQLiteに継続保存し、必要なタイミングでCSVまたはExcel形式の`.xlsx`に出力する小さなローカルAPIです。

## できること

- 5日間の継続インタビューを、同じ`interview_id`単位で蓄積
- 途中で休んで再開しても、過去ログを同じセッションに追記
- Difyの各ターンごとに、ユーザー入力とLLM回答をローカル保存
- SQLiteを正本として残し、Excel/CSVを必要時に書き出し
- Dify Cloud利用時は、ngrokやCloudflare Tunnelなどの公開URL経由で受信

## 起動

```powershell
cd "<workspace>\dify_interview_logger"
.\start_logger.ps1
```

起動後、ローカル確認:

```text
http://127.0.0.1:8787/health
```

## Dify側のHTTP Request設定

既存BOTのGoogle Apps Script向けHTTP Requestノードを、以下に差し替えます。

- Method: `POST`
- URL:
  - ローカルDify/Dockerから使う場合: `http://host.docker.internal:8787/dify/log`
  - 同じWindows上の通常プロセスから使う場合: `http://127.0.0.1:8787/dify/log`
  - Dify Cloudから使う場合: `https://<tunnel-domain>/dify/log`
- Body type: `JSON`
- Body: [dify_http_request_body.json](dify_http_request_body.json) の内容

Dify Cloudなど、外部から到達できるURLにする場合は必ずトークンを設定してください。

```powershell
$env:DIFY_LOG_TOKEN="長いランダム文字列"
.\start_logger.ps1
```

その場合、Dify HTTP RequestノードのHeaderに以下を追加します。

```text
Authorization: Bearer 長いランダム文字列
```

## Excel / CSV出力

全件Excel:

```text
http://127.0.0.1:8787/export/xlsx
```

全件CSV:

```text
http://127.0.0.1:8787/export/csv
```

特定セッションだけ出力:

```text
http://127.0.0.1:8787/export/xlsx?interview_id=<interview_id>
```

出力ファイルは`exports`フォルダにも保存されます。

## 5日間継続の運用ルール

1. Difyの会話は、回答者に同じチャットURL/同じ会話から戻ってもらう。
2. ローカルDB側では`interview_id`が同じなら追記される。
3. 原則は`{{#sys.conversation_id#}}`を`interview_id`に使う。
4. Difyで新規会話を作り直す可能性がある場合は、開始フォームに「回答者ID」を追加し、それを`interview_id`として送る。
5. 5日を超えたログも保存されるが、`status`は`over_5_days`になります。

## 再開の考え方

Difyの同一会話内であれば、Dify側の会話履歴とconversation variablesで再開できます。ローカル側は全ターンを保存し続けるので、あとから「いつ、どこで止まり、どこから再開したか」を追えます。

さらに堅くする場合は、Difyの開始直後に`GET /state?interview_id=...`を呼び、過去の`last_phase`や`last_llm_reply`をプロンプトへ渡す設計にします。

## 保存場所

- DB: `%LOCALAPPDATA%\DifyInterviewLogger\interview_logs.sqlite3`
- Excel/CSV: `exports/`

SQLiteが正本です。Excelファイルを開いたままでもDB保存は継続でき、必要なタイミングで改めて`.xlsx`を書き出せます。

DB保存場所を変えたい場合は、起動前に`DIFY_LOG_DATA_DIR`を設定してください。
