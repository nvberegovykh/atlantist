#!/usr/bin/env python3
"""
test_regression.py

Master regression runner — executes all Python automation scripts
after every deployment and fails if any script returns non-zero.

Usage:
  python tests/scripts/test_regression.py
  # or in CI/CD:
  python tests/scripts/test_regression.py --fail-fast
"""

import sys
import subprocess
import time
from pathlib import Path

SCRIPTS_DIR = Path(__file__).parent

SCRIPTS = [
    ("Auth flows", "test_auth.py"),
    ("IFC export/import", "test_ifc_export.py"),
    ("Energy simulation", "test_energy_sim.py"),
    ("Webhook handling", "test_webhook.py"),
    ("Stripe billing", "test_stripe.py"),
    ("Admin panel", "test_admin.py"),
]


def run_script(name: str, script_path: Path) -> tuple[bool, str]:
    """Run a single script, return (success, output)."""
    print(f"\n{'=' * 60}")
    print(f"Running: {name}")
    print(f"Script: {script_path}")
    print("-" * 60)

    start = time.time()
    try:
        result = subprocess.run(
            [sys.executable, str(script_path)],
            capture_output=True,
            text=True,
            timeout=120
        )
        elapsed = time.time() - start

        output = result.stdout + result.stderr
        print(output)

        print(f"\nElapsed: {elapsed:.1f}s | Exit: {result.returncode}")
        return result.returncode == 0, output

    except subprocess.TimeoutExpired:
        print("❌ TIMEOUT — script exceeded 120s")
        return False, "TIMEOUT"
    except Exception as e:
        print(f"❌ ERROR: {e}")
        return False, str(e)


def main():
    print("=" * 60)
    print("Atlantist Regression Suite")
    print(f"Total scripts: {len(SCRIPTS)}")
    print(f"Target: https://atlantist.polsia.app")
    print("=" * 60)

    fail_fast = "--fail-fast" in sys.argv
    results = []
    total_failed = 0

    for name, script_name in SCRIPTS:
        success, output = run_script(name, SCRIPTS_DIR / script_name)
        results.append((name, success, output))

        if not success:
            total_failed += 1
            print(f"\n❌ {name} FAILED")
            if fail_fast:
                print("Failing fast — stopping.")
                break
        else:
            print(f"\n✅ {name} passed")

    # Summary
    print("\n" + "=" * 60)
    print("REGRESSION SUMMARY")
    print("=" * 60)
    passed = len(results) - total_failed
    print(f"Total: {len(results)}")
    print(f"Passed: {passed}")
    print(f"Failed: {total_failed}")

    if total_failed > 0:
        print("\nFailed scripts:")
        for name, success, _ in results:
            if not success:
                print(f"  ❌ {name}")
        print("\n⚠️  DEPLOYMENT BLOCKED — fix failures before next deploy")
        return 1
    else:
        print("\n✅ ALL TESTS PASSED — safe to deploy")
        return 0


if __name__ == "__main__":
    sys.exit(main())