from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import yaml


DEFAULT_LOGGER_URL = "http://host.docker.internal:8787/dify/log"
ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / "dify_app" / "local" / "インタビューBOT_v2_local_logger.yml"

OPENING_STATEMENT = """これからチャットによるアンケートをスタートします。

※このインタビューは5日間のあいだ、途中で時間を空けながら続けていただけます
※同じチャット画面から戻っていただければ、前回の続きから再開できます
※おおよその質問数は10問程ですが、会話のやりとりによって少し質問数が増える場合があります
※所要時間は合計20〜30分程度です。一度にすべての会話を完了せず、時間をおいてお答え頂いても構いません

準備が出来たらお知らせください。"""

PROMPT_PATCH = """# 5日間継続インタビューの運用ルール
このインタビューは最大5日間にわたって継続される可能性があります。
ユーザーが途中で時間を空けて戻ってきた場合も、会話履歴を踏まえて、直前のフェーズから自然に再開してください。

ユーザーが「再開します」「続きから」「昨日の続き」などと入力した場合、新しいPhase 1からやり直してはいけません。
直前に質問していたフェーズ、または直前の未回答項目を短く確認し、その続きだけを尋ねてください。

会話の冒頭で、以下を自然な言葉で伝えてください。
「このインタビューは5日間のあいだ、途中で時間を空けながら続けていただけます。同じチャット画面から戻っていただければ、前回の続きから再開できます。」

5日間の途中で回答が途切れたように見える場合でも、催促や評価はせず、再開時には中立的に「前回は〜について伺っていました」とだけ述べてください。

終了Phaseに到達するまでは、途中離脱・一時停止・翌日再開をすべて通常の継続として扱ってください。
"""


def find_node(app: dict[str, Any], node_type: str) -> dict[str, Any]:
    nodes = app["workflow"]["graph"]["nodes"]
    for node in nodes:
        if node.get("data", {}).get("type") == node_type:
            return node
    raise ValueError(f"{node_type!r} node not found")


def add_participant_id(start_node: dict[str, Any]) -> None:
    variables = start_node["data"].setdefault("variables", [])
    if any(item.get("variable") == "participant_id" for item in variables):
        return

    variables.insert(
        0,
        {
            "default": "",
            "hint": "5日間の途中再開に使う任意IDです。空欄の場合はDifyの会話IDで記録します。",
            "label": "回答者ID（任意）",
            "options": [],
            "placeholder": "例: M001",
            "required": False,
            "type": "text-input",
            "variable": "participant_id",
        },
    )


def patch_prompt(llm_node: dict[str, Any]) -> None:
    prompts = llm_node["data"].get("prompt_template", [])
    system_prompt = next((item for item in prompts if item.get("role") == "system"), None)
    if not system_prompt:
        raise ValueError("system prompt not found")

    text = system_prompt.get("text", "")
    if "# 5日間継続インタビューの運用ルール" not in text:
        marker = "# 高度な対話設計とアンケート姿勢（厳格遵守）"
        text = text.replace(marker, PROMPT_PATCH + "\n" + marker, 1)

    text = text.replace(
        "全体で30分程度を想定しております。当時の状況をじっくりと思い出しながら、ご自身のペースで進めていただいて構いません。途中で時間を空けて戻ってきても同じ設問から再開できますので、急いで全部お答えいただかなくても大丈夫ですよ。",
        "全体では30分程度を想定しておりますが、5日間のあいだ途中で時間を空けながら続けていただけます。当時の状況をじっくりと思い出しながら、ご自身のペースで進めていただいて構いません。同じチャット画面から戻っていただければ前回の続きから再開できますので、急いで全部お答えいただかなくても大丈夫ですよ。",
        1,
    )

    system_prompt["text"] = text


def patch_http_request(http_node: dict[str, Any], logger_url: str) -> None:
    data = http_node["data"]
    data["url"] = logger_url
    data["method"] = "post"

    body = {
        "event": "message",
        "interview_id": "{{#1743130596309.participant_id#}}",
        "participant_id": "{{#1743130596309.participant_id#}}",
        "user_id": "{{#sys.user_id#}}",
        "conversation_id": "{{#sys.conversation_id#}}",
        "name": "{{#1743130596309.name#}}",
        "user_age": "{{#1743130596309.user_age#}}",
        "user_location": "{{#1743130596309.user_location#}}",
        "son_name": "{{#1743130596309.son_name#}}",
        "son_age": "{{#1743130596309.son_age#}}",
        "user_input": "{{#sys.query#}}",
        "llm_reply": "{{#llm.text#}}",
    }

    data.setdefault("body", {}).setdefault("data", [])
    if not data["body"]["data"]:
        data["body"]["data"].append({"id": "key-value-logger", "key": "", "type": "text"})
    data["body"]["type"] = "json"
    data["body"]["data"][0]["key"] = ""
    data["body"]["data"][0]["type"] = "text"
    data["body"]["data"][0]["value"] = json.dumps(body, ensure_ascii=False, indent=2)


def build(source: Path, output: Path, logger_url: str) -> None:
    app = yaml.safe_load(source.read_text(encoding="utf-8"))

    app["app"]["name"] = "インタビューBOT_v2_local_logger"
    app["app"]["description"] = "メンターママ用BOT（5日間継続・ローカル記録対応）"
    app["workflow"]["features"]["opening_statement"] = OPENING_STATEMENT

    start_node = find_node(app, "start")
    llm_node = find_node(app, "llm")
    http_node = find_node(app, "http-request")

    add_participant_id(start_node)
    patch_prompt(llm_node)
    patch_http_request(http_node, logger_url)

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        yaml.safe_dump(app, allow_unicode=True, sort_keys=False, width=120),
        encoding="utf-8",
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path, help="Original Dify app YAML export.")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--logger-url", default=DEFAULT_LOGGER_URL)
    args = parser.parse_args()

    build(args.source, args.output, args.logger_url)
    print(args.output)


if __name__ == "__main__":
    main()
