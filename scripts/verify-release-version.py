#!/usr/bin/env python3
"""Validate the version used by a Chengying release."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VERSION_PATTERN = re.compile(
    r"^(?P<major>0|[1-9][0-9]*)\."
    r"(?P<minor>0|[1-9][0-9]*)\."
    r"(?P<patch>0|[1-9][0-9]*)"
    r"(?:-rev\.(?P<revision>[1-9][0-9]*))?$"
)


def normalize(value: str) -> str:
    return value.strip().removeprefix("v").strip()


def parse_version(value: str) -> tuple[int, int, int, int, int] | None:
    match = VERSION_PATTERN.fullmatch(normalize(value))
    if not match:
        return None
    revision = match.group("revision")
    # A transitional -rev.N is ordered before the corresponding stable version.
    return (
        int(match.group("major")),
        int(match.group("minor")),
        int(match.group("patch")),
        0 if revision else 1,
        int(revision or 0),
    )


def fail(message: str) -> "NoReturn":
    print(message, file=sys.stderr)
    raise SystemExit(1)


def git_output(*args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True).strip()


def verify_latest_tag(expected: str) -> None:
    try:
        tags = git_output("tag", "--list", "v*").splitlines()
    except (OSError, subprocess.CalledProcessError):
        return

    versions = []
    for tag in tags:
        parsed = parse_version(tag)
        if parsed and normalize(tag) != expected:
            versions.append((parsed, normalize(tag)))
    if not versions:
        return

    latest = max(versions)
    if parse_version(expected) <= latest[0]:
        fail(
            f"project version must be greater than latest tag v{latest[1]}; "
            f"got {expected}"
        )


def verify_tag(expected: str, tag: str | None) -> None:
    if not tag:
        return
    normalized_tag = normalize(tag)
    if normalized_tag != expected:
        fail(f"release tag v{normalized_tag} does not match VERSION {expected}")
    try:
        exact = git_output("describe", "--tags", "--exact-match", "HEAD")
    except (OSError, subprocess.CalledProcessError):
        fail(f"HEAD is not checked out at release tag v{expected}")
    if exact != f"v{expected}":
        fail(f"release workflow must check out v{expected}; exact tag at HEAD is {exact}")


def verify_package_manifest(expected: str) -> None:
    """The npm/DSH manifest must carry the same version.

    `pnpm pack` names the installable bundle after `package.json`, and the
    build inlines it into `__CHENGYING_VERSION__`; when the manifest drifts
    from `VERSION` a release ships assets named after the previous version.
    """
    manifest_path = ROOT / "package.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"cannot read package.json: {error}")
    manifest_version = normalize(str(manifest.get("version", "")))
    if manifest_version != expected:
        fail(
            f"package.json version {manifest_version or '(missing)'} does not match "
            f"VERSION {expected}; bump both before tagging"
        )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", required=True)
    parser.add_argument("--tag")
    args = parser.parse_args()

    raw_version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    actual = normalize(raw_version)
    expected = normalize(args.version)
    if parse_version(actual) is None:
        fail(f"VERSION contains an invalid SemVer: {raw_version}")
    if parse_version(expected) is None:
        fail(f"release version is invalid: {args.version}")
    if actual != expected:
        fail(f"VERSION {actual} does not match expected {expected}")

    verify_package_manifest(expected)
    verify_latest_tag(expected)
    verify_tag(expected, args.tag)
    print(f"Release version verified: {expected}")


if __name__ == "__main__":
    main()
