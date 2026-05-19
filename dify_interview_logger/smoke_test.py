from __future__ import annotations

import tempfile
from pathlib import Path

import server


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        server.DATA_DIR = root / "data"
        server.DB_PATH = server.DATA_DIR / "interviews.sqlite3"
        server.EXPORT_DIR = root / "exports"
        server.init_db()

        result = server.record_message(
            {
                "event": "message",
                "interview_id": "smoke-session",
                "user_id": "user-001",
                "conversation_id": "conversation-001",
                "name": "テストユーザー",
                "son_name": "テスト太郎",
                "user_input": "再開します",
                "llm_reply": "【次のご質問】続いて「高校生」の頃についてお伺いします。",
            }
        )
        assert result["ok"] is True
        assert result["interview_id"] == "smoke-session"
        assert result["total_turns"] == 1

        xlsx_path, xlsx_content, _ = server.export_file("xlsx")
        csv_path, csv_content, _ = server.export_file("csv")

        assert xlsx_path.exists()
        assert xlsx_content[:2] == b"PK"
        assert csv_path.exists()
        assert "smoke-session".encode("utf-8") in csv_content

    print("smoke test passed")


if __name__ == "__main__":
    main()
