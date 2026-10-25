#!/usr/bin/env python3
"""Render one Chengying release body from the version-specific notes file."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PLACEHOLDER_PATTERN = re.compile(r"\{\{\s*([a-zA-Z0-9_]+)\s*\}\}")


def normalize(value: str) -> str:
    return value.strip().removeprefix("v").strip()


def render(args: argparse.Namespace) -> str:
    version = normalize(args.version)
    notes_path = ROOT / ".github" / "release-notes" / f"{version}.md"
    if not notes_path.is_file():
        raise ValueError(f"missing release notes: {notes_path.relative_to(ROOT)}")
    notes = notes_path.read_text(encoding="utf-8").strip()
    if not notes:
        raise ValueError(f"release notes are empty: {notes_path.relative_to(ROOT)}")

    template = (ROOT / ".github" / "RELEASE_TEMPLATE.md").read_text(encoding="utf-8")
    values = {
        "version": version,
        "tag": f"v{version}",
        "release_type": args.release_type,
        "repository": args.repository,
        "repository_url": f"https://github.com/{args.repository}",
        "release_notes": notes,
    }

    def replace(match: re.Match[str]) -> str:
        key = match.group(1)
        if key not in values:
            raise ValueError(f"unknown release template placeholder: {match.group(0)}")
        return values[key]

    body = PLACEHOLDER_PATTERN.sub(replace, template).strip() + "\n"
    if PLACEHOLDER_PATTERN.search(body):
        raise ValueError("rendered release body contains an unresolved placeholder")
    return body


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", required=True)
    parser.add_argument("--release-type", choices=("prerelease", "release"), required=True)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--output")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()

    try:
        body = render(args)
    except (OSError, ValueError) as error:
        print(error, file=sys.stderr)
        raise SystemExit(1) from error

    if args.output:
        Path(args.output).write_text(body, encoding="utf-8")
    elif not args.check:
        print(body, end="")
    print(f"Release body verified for v{normalize(args.version)}", file=sys.stderr)


if __name__ == "__main__":
    main()
