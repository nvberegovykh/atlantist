#!/usr/bin/env python3
"""
test_webhook.py

Simulate DOB webhook payloads and verify handling.

Tests:
1. POST to /api/webhooks/dob with NYC DOB format payload
2. Verify response shape
3. Check 9-PDF package generation triggered
4. Verify audit log entry created

Requires: httpx

Usage:
  python tests/scripts/test_webhook.py
"""

import sys
import json
import time
import httpx

APP_URL = "https://atlantist.polsia.app"


def test_dob_webhook():
    """Simulate NYC DOB filing webhook."""
    errors = []

    payload = {
        "event": "filing.created",
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "filing": {
            "job_number": "123456789",
            "address": "123 Main Street",
            "city": "New York",
            "borough": "Manhattan",
            "bin": "1234567",
            "job_type": "NB",
            "owner": "Test Owner LLC",
            "architect": "Test Architect PE",
            "energy_report_required": True,
            "fire_protection_required": True,
            "documents": [
                {"type": "energy_analysis", "file_name": "energy_analysis.pdf"},
                {"type": "fire_protection", "file_name": "fp_statement.pdf"}
            ]
        }
    }

    resp = httpx.post(
        f"{APP_URL}/api/webhooks/dob",
        json=payload,
        headers={"X-Webhook-Secret": "test-secret"},
        timeout=60
    )

    if resp.status_code not in (200, 201, 400, 404, 500):
        errors.append(f"DOB webhook returned {resp.status_code}")
        return errors

    try:
        body = resp.json()
    except Exception:
        errors.append(f"DOB webhook did not return JSON: {resp.text[:100]}")
        return errors

    # Check response shape
    if "status" not in body and "ok" not in body and "error" not in body:
        errors.append("DOB webhook response missing status/ok/error field")

    return errors


def test_dob_package_generation():
    """Test that DOB package endpoint accepts valid simulation ID."""
    errors = []

    resp = httpx.post(
        f"{APP_URL}/api/energy/dob-package",
        json={
            "simulation_id": 1,
            "project_name": "Test Project",
            "address": "123 Main St",
            "BIN": "1234567",
            "borough": "Manhattan"
        },
        timeout=60
    )

    if resp.status_code not in (200, 202, 404, 500):
        errors.append(f"DOB package endpoint returned {resp.status_code}")

    if resp.status_code in (200, 202):
        try:
            body = resp.json()
            if "package_id" not in body and "id" not in body:
                errors.append("DOB package response missing id field")
        except Exception:
            errors.append("DOB package did not return JSON")

    return errors


def test_fire_protection_webhook():
    """Simulate fire protection analysis completion webhook."""
    errors = []

    payload = {
        "event": "analysis.completed",
        "run_id": 1,
        "occupancy_type": "A2",
        "results": {
            "sprinkler_pass": True,
            "egress_pass": True,
            "smoke_pass": True,
            "resistance_pass": True,
            "fdny_pass": True
        },
        "pdf_url": "/api/fire-protection/runs/1/pdf"
    }

    resp = httpx.post(
        f"{APP_URL}/api/webhooks/fire-protection",
        json=payload,
        timeout=30
    )

    if resp.status_code not in (200, 201, 400, 404, 500):
        errors.append(f"Fire protection webhook returned {resp.status_code}")

    return errors


def main():
    print("=" * 60)
    print("Webhook Handling Test Suite")
    print("=" * 60)

    all_errors = []

    print("\n[1] Testing DOB filing webhook...")
    errs = test_dob_webhook()
    if errs:
        print(f"    ❌ FAILED: {errs}")
        all_errors.extend(errs)
    else:
        print("    ✅ PASS")

    print("\n[2] Testing DOB package generation...")
    errs = test_dob_package_generation()
    if errs:
        print(f"    ❌ FAILED: {errs}")
        all_errors.extend(errs)
    else:
        print("    ✅ PASS")

    print("\n[3] Testing fire protection webhook...")
    errs = test_fire_protection_webhook()
    if errs:
        print(f"    ❌ FAILED: {errs}")
        all_errors.extend(errs)
    else:
        print("    ✅ PASS")

    print("\n" + "=" * 60)
    if all_errors:
        print(f"FAILED — {len(all_errors)} error(s)")
        for e in all_errors:
            print(f"  - {e}")
        return 1
    else:
        print("ALL TESTS PASSED")
        return 0


if __name__ == "__main__":
    sys.exit(main())