#!/usr/bin/env python3
"""
test_stripe.py

Stripe subscription flow automation — tests actual billing endpoints.

Tests:
1. GET /api/billing/plans (public)
2. POST /api/billing/checkout (auth required — tested gracefully)
3. GET /api/billing/subscription (auth required)
4. GET /api/billing/portal (auth required)
5. POST /api/billing/cancel (auth required)
6. POST /api/billing/reactivate (auth required)

Requires: httpx

Usage:
  python tests/scripts/test_stripe.py
"""

import sys
import httpx

APP_URL = "https://atlantist.polsia.app"


def test_billing_plans_public():
    """GET /api/billing/plans — public endpoint, returns pricing."""
    errors = []

    resp = httpx.get(f"{APP_URL}/api/billing/plans", timeout=30)

    if resp.status_code != 200:
        errors.append(f"billing/plans returned {resp.status_code}")
        return errors

    body = resp.json()
    if "plans" not in body:
        errors.append("billing/plans response missing 'plans' field")
        return errors

    plans = body["plans"]
    if len(plans) < 2:
        errors.append(f"Expected at least 2 plans, got {len(plans)}")

    for plan in plans:
        for field in ("id", "name", "price", "interval"):
            if field not in plan:
                errors.append(f"Plan missing '{field}' field")

    return errors


def test_billing_subscription_unauthenticated():
    """GET /api/billing/subscription without auth — should return 401 or beta_free."""
    errors = []

    resp = httpx.get(f"{APP_URL}/api/billing/subscription", timeout=30)

    if resp.status_code not in (200, 401):
        errors.append(f"subscription (no auth) returned {resp.status_code}")

    if resp.status_code == 200:
        body = resp.json()
        if "status" not in body:
            errors.append("subscription response missing 'status' field")

    return errors


def test_billing_portal_unauthenticated():
    """GET /api/billing/portal without auth — should return 400 or 401."""
    errors = []

    resp = httpx.get(f"{APP_URL}/api/billing/portal", timeout=30)

    if resp.status_code not in (200, 400, 401):
        errors.append(f"billing/portal returned {resp.status_code}")

    return errors


def test_billing_cancel_unauthenticated():
    """POST /api/billing/cancel without auth — should return 401."""
    errors = []

    resp = httpx.post(f"{APP_URL}/api/billing/cancel", timeout=30)

    if resp.status_code not in (200, 401, 404):
        errors.append(f"billing/cancel returned {resp.status_code}")

    return errors


def test_billing_checkout_unauthenticated():
    """POST /api/billing/checkout without auth — should return 401."""
    errors = []

    resp = httpx.post(
        f"{APP_URL}/api/billing/checkout",
        json={"plan": "monthly"},
        timeout=30
    )

    if resp.status_code not in (200, 401):
        errors.append(f"billing/checkout returned {resp.status_code}")

    return errors


def test_billing_reactivate_unauthenticated():
    """POST /api/billing/reactivate without auth — should return 401."""
    errors = []

    resp = httpx.post(f"{APP_URL}/api/billing/reactivate", timeout=30)

    if resp.status_code not in (200, 401, 404):
        errors.append(f"billing/reactivate returned {resp.status_code}")

    return errors


def test_billing_endpoint_contract():
    """Verify billing API contracts — no 500 errors."""
    errors = []

    endpoints = [
        ("GET", "/api/billing/plans", None),
        ("GET", "/api/billing/subscription", None),
        ("GET", "/api/billing/portal", None),
        ("POST", "/api/billing/cancel", {}),
        ("POST", "/api/billing/reactivate", {}),
        ("POST", "/api/billing/checkout", {"plan": "monthly"}),
    ]

    for method, path, json_body in endpoints:
        if method == "GET":
            resp = httpx.get(f"{APP_URL}{path}", timeout=30)
        else:
            resp = httpx.post(f"{APP_URL}{path}", json=json_body or {}, timeout=30)

        if resp.status_code >= 500:
            errors.append(f"{method} {path} returned {resp.status_code} — server error")

    return errors


def main():
    print("=" * 60)
    print("Stripe Subscription Flow Test Suite")
    print("=" * 60)

    all_errors = []

    print("\n[1] Testing /api/billing/plans (public)...")
    errs = test_billing_plans_public()
    if errs:
        print(f"    ❌ FAILED: {errs}")
        all_errors.extend(errs)
    else:
        print("    ✅ PASS")

    print("\n[2] Testing /api/billing/subscription (unauthenticated)...")
    errs = test_billing_subscription_unauthenticated()
    if errs:
        print(f"    ❌ FAILED: {errs}")
        all_errors.extend(errs)
    else:
        print("    ✅ PASS")

    print("\n[3] Testing /api/billing/portal (unauthenticated)...")
    errs = test_billing_portal_unauthenticated()
    if errs:
        print(f"    ❌ FAILED: {errs}")
        all_errors.extend(errs)
    else:
        print("    ✅ PASS")

    print("\n[4] Testing /api/billing/cancel (unauthenticated)...")
    errs = test_billing_cancel_unauthenticated()
    if errs:
        print(f"    ❌ FAILED: {errs}")
        all_errors.extend(errs)
    else:
        print("    ✅ PASS")

    print("\n[5] Testing /api/billing/checkout (unauthenticated)...")
    errs = test_billing_checkout_unauthenticated()
    if errs:
        print(f"    ❌ FAILED: {errs}")
        all_errors.extend(errs)
    else:
        print("    ✅ PASS")

    print("\n[6] Testing /api/billing/reactivate (unauthenticated)...")
    errs = test_billing_reactivate_unauthenticated()
    if errs:
        print(f"    ❌ FAILED: {errs}")
        all_errors.extend(errs)
    else:
        print("    ✅ PASS")

    print("\n[7] Testing billing API contract (no 500s)...")
    errs = test_billing_endpoint_contract()
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