#!/usr/bin/env python3
"""
Verifier loop for the current goal:

Goal: database-backed multi-tenant onboarding works and is verified.

This script runs the local verification checks and captures exact terminal
output on failure. If VERIFIER_FIX_COMMAND is set, the script runs that command
after a failure before retrying. By default, it does not call paid APIs or make
code changes on its own.
"""

from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parent
LOG_FILE = ROOT / "verifier_last_failure.log"
CHECKS = [
    ["npm.cmd", "run", "check"],
    ["npm.cmd", "run", "smoke"],
    ["npm.cmd", "run", "smoke:db"],
]


def run_command(command: list[str]) -> tuple[int, str]:
    process = subprocess.run(
        command,
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        shell=False,
    )
    return process.returncode, process.stdout


def run_checks() -> tuple[bool, str]:
    full_output: list[str] = []
    for command in CHECKS:
        label = " ".join(command)
        print(f"\n=== Running: {label} ===", flush=True)
        code, output = run_command(command)
        full_output.append(f"\n=== {label} ===\n{output}")
        print(output, end="", flush=True)
        if code != 0:
            full_output.append(f"\nCommand failed with exit code {code}: {label}\n")
            return False, "".join(full_output)
    return True, "".join(full_output)


def maybe_run_fix_command(failure_output: str) -> bool:
    fix_command = os.environ.get("VERIFIER_FIX_COMMAND", "").strip()
    if not fix_command:
        LOG_FILE.write_text(failure_output, encoding="utf-8")
        print(f"\nVerification failed. Exact output was saved to {LOG_FILE}")
        print("No VERIFIER_FIX_COMMAND is set, so the loop is stopping for a code fix.")
        return False

    LOG_FILE.write_text(failure_output, encoding="utf-8")
    print(f"\nVerification failed. Running fix command: {fix_command}", flush=True)
    process = subprocess.run(
        fix_command,
        cwd=ROOT,
        text=True,
        shell=True,
    )
    return process.returncode == 0


def main() -> int:
    max_attempts = int(os.environ.get("VERIFIER_MAX_ATTEMPTS", "10"))
    for attempt in range(1, max_attempts + 1):
        print(f"\nVerifier attempt {attempt}/{max_attempts}", flush=True)
        passed, output = run_checks()
        if passed:
            if LOG_FILE.exists():
                LOG_FILE.unlink()
            print("\nVerification passed 100%. Goal is complete.")
            return 0

        if not maybe_run_fix_command(output):
            return 1

        time.sleep(1)

    print(f"\nVerification did not pass after {max_attempts} attempts.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
