import sys
import os
import socket
import json
import argparse
import datetime
from typing import Dict, Any
from .protocol import send_message, recv_message
from .daemon import SOCKET_PATH

MAX_GOAL_CHARS = 4096
MAX_REVIEW_CHARS = 16384


def read_stdin_text(limit: int, label: str, parser: argparse.ArgumentParser) -> str:
    value = sys.stdin.read(limit + 1)
    if len(value) > limit:
        parser.error(f"{label} exceeds the {limit}-character limit.")
    return value

def format_seconds(seconds: float) -> str:
    mins = int(seconds) // 60
    secs = int(seconds) % 60
    return f"{mins}分{secs}秒"

def print_human_status(state: dict) -> None:
    status = state.get("status", "idle")
    phase = state.get("phase", "none")
    preset_key = state.get("preset")
    remaining = state.get("remaining_seconds")
    deadline = state.get("deadline")

    phase_zh = "专注" if phase == "work" else ("休息" if phase == "rest" else "无")
    preset_label = ""
    if preset_key:
        from .models import PRESETS
        preset_obj = PRESETS.get(preset_key)
        if preset_obj:
            preset_label = f" ({preset_obj.label})"

    if status == "idle":
        print("状态: 空闲 (无活动周期)")
    elif status == "running":
        rem_str = format_seconds(remaining) if remaining is not None else "未知"
        dl_str = ""
        if deadline is not None:
            dt = datetime.datetime.fromtimestamp(deadline)
            dl_str = f" | 截止时间: {dt.strftime('%Y-%m-%d %H:%M:%S')}"
        print(f"状态: 运行中 | 阶段: {phase_zh}{preset_label} | 剩余时间: {rem_str}{dl_str}")
    elif status == "paused":
        rem_str = format_seconds(remaining) if remaining is not None else "未知"
        print(f"状态: 已暂停 | 阶段: {phase_zh}{preset_label} | 剩余时间: {rem_str}")
    elif status == "completed":
        print(f"状态: 已完成{preset_label} (专注与休息已结束)")

def get_exit_code(error_msg: str) -> int:
    err_lower = error_msg.lower()
    if "notification" in err_lower or "notifier" in err_lower or "persist" in err_lower or "storage" in err_lower:
        return 4
    return 2

def main() -> None:
    parser = argparse.ArgumentParser(description="Codex Ultradian Rhythm Companion CLI")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # start
    parser_start = subparsers.add_parser("start")
    parser_start.add_argument("preset", nargs="?", choices=["start", "flow", "deep"], default="flow")
    goal_group = parser_start.add_mutually_exclusive_group(required=True)
    goal_group.add_argument("--goal")
    goal_group.add_argument("--goal-stdin", action="store_true")
    parser_start.add_argument("--replace", action="store_true")
    parser_start.add_argument("--json", action="store_true")

    # status
    parser_status = subparsers.add_parser("status")
    parser_status.add_argument("--json", action="store_true")

    # pause
    parser_pause = subparsers.add_parser("pause")
    parser_pause.add_argument("--json", action="store_true")

    # resume
    parser_resume = subparsers.add_parser("resume")
    parser_resume.add_argument("--json", action="store_true")

    # stop
    parser_stop = subparsers.add_parser("stop")
    parser_stop.add_argument("--json", action="store_true")

    # repeat
    parser_repeat = subparsers.add_parser("repeat")
    parser_repeat.add_argument("--json", action="store_true")

    # review
    parser_review = subparsers.add_parser("review")
    parser_review.add_argument("--outcome", choices=["done", "partial", "switched"], required=True)
    review_text_group = parser_review.add_mutually_exclusive_group()
    review_text_group.add_argument("--text")
    review_text_group.add_argument("--text-stdin", action="store_true")
    parser_review.add_argument("--json", action="store_true")

    # history
    parser_history = subparsers.add_parser("history")
    parser_history.add_argument("--limit", type=int, default=50)
    parser_history.add_argument("--json", action="store_true")

    # notify-test
    parser_notify = subparsers.add_parser("notify-test")
    parser_notify.add_argument("--json", action="store_true")

    args = parser.parse_args()

    # Formulate command dict
    cmd_dict = {"command": args.command}
    if args.command == "start":
        goal = args.goal if args.goal is not None else read_stdin_text(MAX_GOAL_CHARS, "Goal", parser)
        goal = goal.strip()
        if not goal:
            parser.error("Goal cannot be empty or whitespace only.")
        cmd_dict["preset"] = args.preset
        cmd_dict["intentionText"] = goal
        cmd_dict["replace"] = args.replace
    elif args.command == "review":
        cmd_dict["outcome"] = args.outcome
        text = args.text if args.text is not None else (
            read_stdin_text(MAX_REVIEW_CHARS, "Review text", parser) if args.text_stdin else ""
        )
        cmd_dict["text"] = text
    elif args.command == "history":
        limit = args.limit
        if limit < 1 or limit > 200:
            parser.error("Limit must be between 1 and 200.")
        cmd_dict["limit"] = limit

    # Check for CLI --json argument presence
    is_json = getattr(args, "json", False)

    # Check daemon socket file availability
    if not os.path.exists(SOCKET_PATH):
        if is_json:
            print(json.dumps({"ok": False, "operation": args.command, "error": "Daemon socket file not found. Daemon is likely not running.", "state": {}}, ensure_ascii=False))
        else:
            print("错误: 无法连接到计时器服务。守护进程未运行。", file=sys.stderr)
        sys.exit(3)

    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.connect(SOCKET_PATH)
    except (FileNotFoundError, ConnectionRefusedError, socket.error) as e:
        if is_json:
            print(json.dumps({"ok": False, "operation": args.command, "error": f"Daemon connection refused: {e}", "state": {}}, ensure_ascii=False))
        else:
            print(f"错误: 无法连接到计时器服务 ({e})。请确认服务已启动。", file=sys.stderr)
        sys.exit(3)

    # Send and receive message
    try:
        send_message(sock, cmd_dict)
        buffer = bytearray()
        response = recv_message(sock, buffer)
    except Exception as e:
        if is_json:
            print(json.dumps({"ok": False, "operation": args.command, "error": f"Protocol exchange error: {e}", "state": {}}, ensure_ascii=False))
        else:
            print(f"错误: 通信失败 ({e})。", file=sys.stderr)
        sys.exit(3)
    finally:
        sock.close()

    if not response:
        if is_json:
            print(json.dumps({"ok": False, "operation": args.command, "error": "Daemon closed connection without response.", "state": {}}, ensure_ascii=False))
        else:
            print("错误: 服务未返回任何响应。", file=sys.stderr)
        sys.exit(3)

    ok = response.get("ok", False)
    error_msg = response.get("error", "")
    state = response.get("state", {})

    if is_json:
        print(json.dumps(response, indent=2, ensure_ascii=False))
        if not ok:
            sys.exit(get_exit_code(error_msg))
        sys.exit(0)

    if not ok:
        print(f"错误: {error_msg}", file=sys.stderr)
        sys.exit(get_exit_code(error_msg))

    # Human readable output
    if args.command == "start":
        print("专注周期已成功启动。")
        print_human_status(state)
    elif args.command == "status":
        print_human_status(state)
    elif args.command == "pause":
        print("专注周期已暂停。")
        print_human_status(state)
    elif args.command == "resume":
        print("专注周期已恢复运行。")
        print_human_status(state)
    elif args.command == "stop":
        print("专注周期已停止。")
        print_human_status(state)
    elif args.command == "repeat":
        print("已重复启动上一周期。")
        print_human_status(state)
    elif args.command == "review":
        print("周期评价已保存。")
        print_human_status(state)
    elif args.command == "history":
        history = response.get("history", [])
        if not history:
            print("暂无专注历史记录。")
        else:
            print("专注历史记录 (从新到旧):")
            for session in history:
                started_dt = datetime.datetime.fromtimestamp(session["started_at"]).strftime('%Y-%m-%d %H:%M:%S')
                duration_mins = session["planned_work_seconds"] // 60
                preset = session["preset"]
                status = session["terminal_status"] or "进行中"
                outcome = session["review_outcome"] or "未评价"
                text = f" | 评价: {outcome}"
                if session["review_text"]:
                    text += f" ({session['review_text']})"
                print(f"- [{started_dt}] 预设: {preset} ({duration_mins}分钟) | 意图: {session['intention_text']} | 状态: {status}{text}")
    elif args.command == "notify-test":
        print("通知测试发送成功。请在系统右上角确认是否收到通知。")

    sys.exit(0)

if __name__ == "__main__":
    main()
