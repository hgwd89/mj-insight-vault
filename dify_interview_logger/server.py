from __future__ import annotations

import csv
import datetime as dt
import io
import json
import os
import re
import sqlite3
import sys
import zipfile
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse
from xml.sax.saxutils import escape as xml_escape


ROOT = Path(__file__).resolve().parent


def default_data_dir() -> Path:
    local_app_data = os.getenv("LOCALAPPDATA")
    if local_app_data:
        return Path(local_app_data) / "DifyInterviewLogger"
    return ROOT / "data"


DATA_DIR = Path(os.getenv("DIFY_LOG_DATA_DIR") or default_data_dir())
DB_PATH = Path(os.getenv("DIFY_LOG_DB", DATA_DIR / "interview_logs.sqlite3"))
EXPORT_DIR = Path(os.getenv("DIFY_LOG_EXPORT_DIR", ROOT / "exports"))
HOST = os.getenv("DIFY_LOG_HOST", "127.0.0.1")
PORT = int(os.getenv("DIFY_LOG_PORT", "8787"))
TOKEN = os.getenv("DIFY_LOG_TOKEN", "").strip()
JST = dt.timezone(dt.timedelta(hours=9))

PLACEHOLDER_RE = re.compile(r"\{\{#.*?#\}\}")
INVALID_XML_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")

SESSION_COLUMNS = [
    "interview_id",
    "first_seen_at",
    "last_seen_at",
    "elapsed_day",
    "remaining_days",
    "total_turns",
    "status",
    "last_phase",
    "user_id",
    "conversation_id",
    "participant_id",
    "name",
    "user_age",
    "user_location",
    "son_name",
    "son_age",
    "last_user_input",
    "last_llm_reply",
]

MESSAGE_COLUMNS = [
    "id",
    "interview_id",
    "message_at",
    "local_date",
    "elapsed_day",
    "remaining_days",
    "user_id",
    "conversation_id",
    "participant_id",
    "name",
    "son_name",
    "event",
    "phase",
    "probe_count",
    "user_input",
    "llm_reply",
    "raw_json",
]

PHASE_HINTS = [
    ("Phase 13: 終了", ["画面を閉じて終了", "最後までお付き合いいただき"]),
    ("Phase 12: 情報源", ["次で最後の質問", "どこから情報を取り入れていますか"]),
    ("Phase 11: 息子の存在定義", ["どのような存在", "息子さんは「どのような存在」"]),
    ("Phase 10: 将来のサポートと境界線", ["ご結婚されたり", "完全に独立"]),
    ("Phase 9: 母親の心理深掘り", ["一番の理由", "頼られること"]),
    ("Phase 8: 現在の親子のやり取り", ["現在に至るまで", "今はどちらから"]),
    ("Phase 7: 父親・家族の反応", ["お父様", "ご主人"]),
    ("Phase 6: 衝突や戸惑いの経験", ["やりすぎでは", "意見が合わなかったり"]),
    ("Phase 5: 大学生以降", ["大学生以降", "メイクや脱毛"]),
    ("Phase 4: 金銭的サポートの境界線", ["費用", "サロン代"]),
    ("Phase 3: 高校生の頃", ["高校生", "中学生の頃と比べて"]),
    ("Phase 2: 中学生の頃", ["中学生", "肌のケア"]),
    ("Phase 1: 導入", ["普段、息子さんとは", "共通の趣味"]),
]


def now_jst() -> dt.datetime:
    return dt.datetime.now(JST).replace(microsecond=0)


def iso_now() -> str:
    return now_jst().isoformat()


def clean_value(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    text = str(value)
    if PLACEHOLDER_RE.search(text):
        return ""
    return text.strip()


def pick(payload: dict[str, Any], *names: str) -> str:
    for name in names:
        value = clean_value(payload.get(name))
        if value:
            return value
    return ""


def safe_json(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def parse_datetime(value: str) -> dt.datetime | None:
    if not value:
        return None
    try:
        parsed = dt.datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=JST)
    return parsed.astimezone(JST)


def elapsed_day(first_seen_at: str, current: dt.datetime) -> int:
    first_seen = parse_datetime(first_seen_at) or current
    return max(1, (current.date() - first_seen.date()).days + 1)


def infer_phase(reply: str) -> str:
    if not reply:
        return ""
    for phase, hints in PHASE_HINTS:
        if any(hint in reply for hint in hints):
            return phase
    return ""


def safe_filename(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "_", value).strip("_")
    return cleaned[:80] or "all"


def connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


@contextmanager
def db() -> Any:
    conn = connect()
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    EXPORT_DIR.mkdir(parents=True, exist_ok=True)
    with db() as conn:
        # OneDrive-synced folders on Windows can reject WAL sidecar files.
        # DELETE mode is slower but more reliable for this local logging use case.
        conn.execute("PRAGMA journal_mode=DELETE")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                interview_id TEXT PRIMARY KEY,
                first_seen_at TEXT NOT NULL,
                last_seen_at TEXT NOT NULL,
                elapsed_day INTEGER NOT NULL DEFAULT 1,
                remaining_days INTEGER NOT NULL DEFAULT 4,
                total_turns INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'active',
                last_phase TEXT NOT NULL DEFAULT '',
                user_id TEXT NOT NULL DEFAULT '',
                conversation_id TEXT NOT NULL DEFAULT '',
                participant_id TEXT NOT NULL DEFAULT '',
                name TEXT NOT NULL DEFAULT '',
                user_age TEXT NOT NULL DEFAULT '',
                user_location TEXT NOT NULL DEFAULT '',
                son_name TEXT NOT NULL DEFAULT '',
                son_age TEXT NOT NULL DEFAULT '',
                last_user_input TEXT NOT NULL DEFAULT '',
                last_llm_reply TEXT NOT NULL DEFAULT '',
                raw_last_json TEXT NOT NULL DEFAULT ''
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                interview_id TEXT NOT NULL,
                message_at TEXT NOT NULL,
                local_date TEXT NOT NULL,
                elapsed_day INTEGER NOT NULL,
                remaining_days INTEGER NOT NULL,
                user_id TEXT NOT NULL DEFAULT '',
                conversation_id TEXT NOT NULL DEFAULT '',
                participant_id TEXT NOT NULL DEFAULT '',
                name TEXT NOT NULL DEFAULT '',
                son_name TEXT NOT NULL DEFAULT '',
                event TEXT NOT NULL DEFAULT 'message',
                phase TEXT NOT NULL DEFAULT '',
                probe_count TEXT NOT NULL DEFAULT '',
                user_input TEXT NOT NULL DEFAULT '',
                llm_reply TEXT NOT NULL DEFAULT '',
                raw_json TEXT NOT NULL DEFAULT ''
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_messages_interview_id ON messages(interview_id)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_messages_message_at ON messages(message_at)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_sessions_conversation_id ON sessions(conversation_id)"
        )


def resolve_interview_id(payload: dict[str, Any]) -> str:
    return (
        pick(payload, "interview_id")
        or pick(payload, "participant_id")
        or pick(payload, "conversation_id")
        or pick(payload, "user_id")
        or f"anonymous-{now_jst().strftime('%Y%m%d')}"
    )


def record_message(payload: dict[str, Any]) -> dict[str, Any]:
    current = now_jst()
    current_iso = current.isoformat()
    interview_id = resolve_interview_id(payload)
    user_input = pick(payload, "user_input", "query", "input")
    llm_reply = pick(payload, "llm_reply", "answer", "output")
    phase = pick(payload, "phase", "current_phase") or infer_phase(llm_reply)
    event = pick(payload, "event") or "message"
    status_from_payload = pick(payload, "status", "interview_status")
    raw_json = safe_json(payload)

    incoming = {
        "user_id": pick(payload, "user_id"),
        "conversation_id": pick(payload, "conversation_id"),
        "participant_id": pick(payload, "participant_id"),
        "name": pick(payload, "name"),
        "user_age": pick(payload, "user_age"),
        "user_location": pick(payload, "user_location"),
        "son_name": pick(payload, "son_name"),
        "son_age": pick(payload, "son_age"),
    }

    with db() as conn:
        existing_row = conn.execute(
            "SELECT * FROM sessions WHERE interview_id = ?", (interview_id,)
        ).fetchone()
        existing = dict(existing_row) if existing_row else {}
        first_seen_at = existing.get("first_seen_at") or current_iso
        day = elapsed_day(first_seen_at, current)
        remaining = max(0, 5 - day)

        if "Phase 13" in phase:
            status = "completed"
        elif day > 5 and existing.get("status") != "completed":
            status = "over_5_days"
        else:
            status = status_from_payload or existing.get("status") or "active"

        session_values = {
            "interview_id": interview_id,
            "first_seen_at": first_seen_at,
            "last_seen_at": current_iso,
            "elapsed_day": day,
            "remaining_days": remaining,
            "total_turns": int(existing.get("total_turns") or 0) + 1,
            "status": status,
            "last_phase": phase or existing.get("last_phase", ""),
            "user_id": incoming["user_id"] or existing.get("user_id", ""),
            "conversation_id": incoming["conversation_id"]
            or existing.get("conversation_id", ""),
            "participant_id": incoming["participant_id"]
            or existing.get("participant_id", ""),
            "name": incoming["name"] or existing.get("name", ""),
            "user_age": incoming["user_age"] or existing.get("user_age", ""),
            "user_location": incoming["user_location"]
            or existing.get("user_location", ""),
            "son_name": incoming["son_name"] or existing.get("son_name", ""),
            "son_age": incoming["son_age"] or existing.get("son_age", ""),
            "last_user_input": user_input or existing.get("last_user_input", ""),
            "last_llm_reply": llm_reply or existing.get("last_llm_reply", ""),
            "raw_last_json": raw_json,
        }

        conn.execute(
            """
            INSERT INTO sessions (
                interview_id, first_seen_at, last_seen_at, elapsed_day,
                remaining_days, total_turns, status, last_phase, user_id,
                conversation_id, participant_id, name, user_age, user_location,
                son_name, son_age, last_user_input, last_llm_reply, raw_last_json
            )
            VALUES (
                :interview_id, :first_seen_at, :last_seen_at, :elapsed_day,
                :remaining_days, :total_turns, :status, :last_phase, :user_id,
                :conversation_id, :participant_id, :name, :user_age,
                :user_location, :son_name, :son_age, :last_user_input,
                :last_llm_reply, :raw_last_json
            )
            ON CONFLICT(interview_id) DO UPDATE SET
                last_seen_at = excluded.last_seen_at,
                elapsed_day = excluded.elapsed_day,
                remaining_days = excluded.remaining_days,
                total_turns = excluded.total_turns,
                status = excluded.status,
                last_phase = excluded.last_phase,
                user_id = excluded.user_id,
                conversation_id = excluded.conversation_id,
                participant_id = excluded.participant_id,
                name = excluded.name,
                user_age = excluded.user_age,
                user_location = excluded.user_location,
                son_name = excluded.son_name,
                son_age = excluded.son_age,
                last_user_input = excluded.last_user_input,
                last_llm_reply = excluded.last_llm_reply,
                raw_last_json = excluded.raw_last_json
            """,
            session_values,
        )

        conn.execute(
            """
            INSERT INTO messages (
                interview_id, message_at, local_date, elapsed_day,
                remaining_days, user_id, conversation_id, participant_id,
                name, son_name, event, phase, probe_count, user_input,
                llm_reply, raw_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                interview_id,
                current_iso,
                current.date().isoformat(),
                day,
                remaining,
                session_values["user_id"],
                session_values["conversation_id"],
                session_values["participant_id"],
                session_values["name"],
                session_values["son_name"],
                event,
                phase,
                pick(payload, "probe_count"),
                user_input,
                llm_reply,
                raw_json,
            ),
        )

    return {
        "ok": True,
        "interview_id": interview_id,
        "elapsed_day": day,
        "remaining_days": remaining,
        "total_turns": session_values["total_turns"],
        "status": status,
        "last_phase": session_values["last_phase"],
        "resume_note": "同じinterview_idで再開すれば、記録は継続されます。",
    }


def rows_from_query(sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
    with db() as conn:
        rows = conn.execute(sql, params).fetchall()
    return [dict(row) for row in rows]


def get_export_data(interview_id: str = "") -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if interview_id:
        sessions = rows_from_query(
            "SELECT * FROM sessions WHERE interview_id = ? ORDER BY last_seen_at DESC",
            (interview_id,),
        )
        messages = rows_from_query(
            "SELECT * FROM messages WHERE interview_id = ? ORDER BY id ASC",
            (interview_id,),
        )
    else:
        sessions = rows_from_query(
            "SELECT * FROM sessions ORDER BY last_seen_at DESC, interview_id ASC"
        )
        messages = rows_from_query("SELECT * FROM messages ORDER BY id ASC")
    return messages, sessions


def find_session(query: dict[str, list[str]]) -> dict[str, Any] | None:
    interview_id = clean_value(query.get("interview_id", [""])[0])
    conversation_id = clean_value(query.get("conversation_id", [""])[0])
    user_id = clean_value(query.get("user_id", [""])[0])

    if interview_id:
        rows = rows_from_query(
            "SELECT * FROM sessions WHERE interview_id = ?", (interview_id,)
        )
    elif conversation_id:
        rows = rows_from_query(
            "SELECT * FROM sessions WHERE conversation_id = ? ORDER BY last_seen_at DESC LIMIT 1",
            (conversation_id,),
        )
    elif user_id:
        rows = rows_from_query(
            "SELECT * FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC LIMIT 1",
            (user_id,),
        )
    else:
        rows = []
    return rows[0] if rows else None


def dict_rows_to_csv(columns: list[str], rows: list[dict[str, Any]]) -> bytes:
    buffer = io.StringIO(newline="")
    writer = csv.DictWriter(buffer, fieldnames=columns, extrasaction="ignore")
    writer.writeheader()
    for row in rows:
        writer.writerow({column: row.get(column, "") for column in columns})
    return ("\ufeff" + buffer.getvalue()).encode("utf-8")


def column_name(index: int) -> str:
    result = ""
    while index:
        index, remainder = divmod(index - 1, 26)
        result = chr(65 + remainder) + result
    return result


def xml_text(value: Any) -> str:
    text = "" if value is None else str(value)
    text = INVALID_XML_RE.sub("", text)
    return xml_escape(text)


def sheet_xml(columns: list[str], rows: list[dict[str, Any]]) -> str:
    row_xml = []
    all_rows = [dict(zip(columns, columns))] + rows
    for row_index, row in enumerate(all_rows, start=1):
        cells = []
        for col_index, column in enumerate(columns, start=1):
            ref = f"{column_name(col_index)}{row_index}"
            value = row.get(column, "")
            preserve = ' xml:space="preserve"' if str(value).strip() != str(value) else ""
            cells.append(
                f'<c r="{ref}" t="inlineStr"><is><t{preserve}>{xml_text(value)}</t></is></c>'
            )
        row_xml.append(f'<row r="{row_index}">{"".join(cells)}</row>')
    max_col = column_name(max(1, len(columns)))
    max_row = max(1, len(all_rows))
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f'<dimension ref="A1:{max_col}{max_row}"/>'
        "<sheetData>"
        + "".join(row_xml)
        + "</sheetData></worksheet>"
    )


def build_xlsx(messages: list[dict[str, Any]], sessions: list[dict[str, Any]]) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(
            "[Content_Types].xml",
            """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>""",
        )
        zf.writestr(
            "_rels/.rels",
            """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>""",
        )
        zf.writestr(
            "xl/workbook.xml",
            """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>
<sheet name="Messages" sheetId="1" r:id="rId1"/>
<sheet name="Sessions" sheetId="2" r:id="rId2"/>
</sheets>
</workbook>""",
        )
        zf.writestr(
            "xl/_rels/workbook.xml.rels",
            """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>""",
        )
        zf.writestr(
            "xl/styles.xml",
            """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="1"><fill><patternFill patternType="none"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>
</styleSheet>""",
        )
        zf.writestr("xl/worksheets/sheet1.xml", sheet_xml(MESSAGE_COLUMNS, messages))
        zf.writestr("xl/worksheets/sheet2.xml", sheet_xml(SESSION_COLUMNS, sessions))
    return output.getvalue()


def export_file(kind: str, interview_id: str = "") -> tuple[Path, bytes, str]:
    messages, sessions = get_export_data(interview_id)
    timestamp = now_jst().strftime("%Y%m%d_%H%M%S")
    suffix = safe_filename(interview_id) if interview_id else "all"
    EXPORT_DIR.mkdir(parents=True, exist_ok=True)

    if kind == "csv":
        content = dict_rows_to_csv(MESSAGE_COLUMNS, messages)
        path = EXPORT_DIR / f"interview_messages_{suffix}_{timestamp}.csv"
        media_type = "text/csv; charset=utf-8"
    else:
        content = build_xlsx(messages, sessions)
        path = EXPORT_DIR / f"interview_logs_{suffix}_{timestamp}.xlsx"
        media_type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

    path.write_bytes(content)
    return path, content, media_type


class Handler(BaseHTTPRequestHandler):
    server_version = "DifyInterviewLogger/1.0"

    def send_common_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Dify-Log-Token")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_common_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_bytes(
        self, status: int, content: bytes, media_type: str, filename: str = ""
    ) -> None:
        self.send_response(status)
        self.send_common_headers()
        self.send_header("Content-Type", media_type)
        self.send_header("Content-Length", str(len(content)))
        if filename:
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.end_headers()
        self.wfile.write(content)

    def is_authorized(self, query: dict[str, list[str]]) -> bool:
        if not TOKEN:
            return True
        auth = self.headers.get("Authorization", "")
        header_token = self.headers.get("X-Dify-Log-Token", "")
        query_token = query.get("token", [""])[0]
        return (
            auth == f"Bearer {TOKEN}"
            or header_token == TOKEN
            or query_token == TOKEN
        )

    def read_json_body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            return {}
        body = self.rfile.read(length).decode("utf-8")
        parsed = json.loads(body)
        if not isinstance(parsed, dict):
            raise ValueError("JSON body must be an object.")
        return parsed

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_common_headers()
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        query = parse_qs(parsed.query)

        if path in {"/", "/health"}:
            self.send_json(
                200,
                {
                    "ok": True,
                    "service": "dify_interview_logger",
                    "db": str(DB_PATH),
                    "exports": str(EXPORT_DIR),
                    "token_required": bool(TOKEN),
                    "routes": [
                        "POST /dify/log",
                        "GET /sessions",
                        "GET /state?interview_id=...",
                        "GET /export/xlsx",
                        "GET /export/csv",
                    ],
                },
            )
            return

        if not self.is_authorized(query):
            self.send_json(401, {"ok": False, "error": "unauthorized"})
            return

        if path == "/sessions":
            rows = rows_from_query(
                "SELECT * FROM sessions ORDER BY last_seen_at DESC, interview_id ASC"
            )
            self.send_json(200, {"ok": True, "sessions": rows})
            return

        if path == "/state":
            session = find_session(query)
            if not session:
                self.send_json(404, {"ok": False, "error": "session_not_found"})
                return
            self.send_json(
                200,
                {
                    "ok": True,
                    "session": session,
                    "resume_instruction": "このsessionのlast_phaseとlast_llm_replyを参照して、次の回答から再開できます。",
                },
            )
            return

        if path in {"/export/xlsx", "/export/csv"}:
            interview_id = clean_value(query.get("interview_id", [""])[0])
            kind = "csv" if path.endswith("csv") else "xlsx"
            export_path, content, media_type = export_file(kind, interview_id)
            self.send_bytes(200, content, media_type, export_path.name)
            return

        self.send_json(404, {"ok": False, "error": "not_found"})

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        query = parse_qs(parsed.query)

        if not self.is_authorized(query):
            self.send_json(401, {"ok": False, "error": "unauthorized"})
            return

        if path != "/dify/log":
            self.send_json(404, {"ok": False, "error": "not_found"})
            return

        try:
            payload = self.read_json_body()
            result = record_message(payload)
        except json.JSONDecodeError as exc:
            self.send_json(400, {"ok": False, "error": "invalid_json", "detail": str(exc)})
            return
        except Exception as exc:
            self.send_json(500, {"ok": False, "error": "record_failed", "detail": str(exc)})
            return

        self.send_json(200, result)

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write(f"[{iso_now()}] {self.address_string()} {fmt % args}\n")


def main() -> None:
    init_db()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Dify interview logger is running: http://{HOST}:{PORT}")
    print(f"Database: {DB_PATH}")
    print(f"Exports:  {EXPORT_DIR}")
    if TOKEN:
        print("Auth:     enabled")
    else:
        print("Auth:     disabled. Set DIFY_LOG_TOKEN before exposing this server.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
