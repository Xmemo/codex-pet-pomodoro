import re
import shlex
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SKILL_PATH = REPO_ROOT / "packaging" / "skill" / "SKILL.md"

class TestSkillContract(unittest.TestCase):
    def setUp(self) -> None:
        self.assertTrue(SKILL_PATH.exists(), f"Skill file not found at {SKILL_PATH}")
        self.content = SKILL_PATH.read_text(encoding="utf-8")

    def test_skill_file_exists_and_has_valid_frontmatter(self) -> None:
        self.assertIn("name: ultradian-rhythm", self.content)
        self.assertIn("description:", self.content)

    def test_all_mapped_start_commands_include_goal(self) -> None:
        # Find all inline code blocks `...` in the markdown
        code_snippets = re.findall(r"`([^`]+)`", self.content)
        start_commands = [c.strip() for c in code_snippets if "| ultradian start" in c]

        self.assertGreater(len(start_commands), 0, "No mapped ultradian start commands found in SKILL.md")

        for cmd in start_commands:
            with self.subTest(cmd=cmd):
                self.assertIn(
                    "--goal-stdin",
                    cmd,
                    f"Mapped start command '{cmd}' does not read the goal from stdin."
                )
                self.assertNotRegex(cmd, r"--goal(?:\s|=)")

    def test_all_presets_covered_in_start_mappings(self) -> None:
        code_snippets = re.findall(r"`([^`]+)`", self.content)
        start_commands = [c.strip() for c in code_snippets if "| ultradian start" in c]

        for preset in ["start", "flow", "deep"]:
            matching = [cmd for cmd in start_commands if f"ultradian start {preset}" in cmd]
            self.assertTrue(
                len(matching) > 0,
                f"Preset '{preset}' must have at least one mapped start command with --goal-stdin."
            )

    def test_no_unquoted_or_bare_start_executions_in_table(self) -> None:
        # Check table lines specifically
        for line in self.content.splitlines():
            if "|" in line and "ultradian start" in line:
                snippets = re.findall(r"`(printf[^`]+\| ultradian start[^`]+)`", line)
                for snippet in snippets:
                    self.assertIn(
                        "--goal-stdin",
                        snippet,
                        f"Found bare or missing --goal-stdin in table mapping: {snippet}"
                    )

    def test_goal_behavioral_rules_documented(self) -> None:
        # Verify instructions require inferring goal or asking before running, not fabricating
        self.assertIn("--goal", self.content)
        self.assertTrue(
            "凭空" in self.content or "捏造" in self.content or "编造" in self.content,
            "Skill instructions must prohibit inventing a generic goal."
        )
        self.assertTrue(
            "提问" in self.content or "询问" in self.content,
            "Skill instructions must mandate asking the user if goal is unknown."
        )
        self.assertIn("POSIX", self.content)
        self.assertIn("'it'\\''s'", self.content)
        self.assertIn("eval", self.content)

    def test_mapped_start_commands_parse_with_cli_parser(self) -> None:
        import argparse
        parser = argparse.ArgumentParser()
        subparsers = parser.add_subparsers(dest="command", required=True)
        parser_start = subparsers.add_parser("start")
        parser_start.add_argument("preset", nargs="?", choices=["start", "flow", "deep"], default="flow")
        goal_group = parser_start.add_mutually_exclusive_group(required=True)
        goal_group.add_argument("--goal")
        goal_group.add_argument("--goal-stdin", action="store_true")
        parser_start.add_argument("--replace", action="store_true")
        parser_start.add_argument("--json", action="store_true")

        code_snippets = re.findall(r"`([^`]+)`", self.content)
        start_commands = [c.strip().split("|", 1)[1].strip() for c in code_snippets if "| ultradian start" in c]

        for cmd in start_commands:
            # The CLI reads goal content through stdin; test only its argv contract.
            concrete_cmd = cmd.replace("<preset>", "flow")
            tokens = shlex.split(concrete_cmd)
            self.assertEqual(tokens[0], "ultradian")
            args = parser.parse_args(tokens[1:])
            self.assertEqual(args.command, "start")
            self.assertTrue(args.goal_stdin)
