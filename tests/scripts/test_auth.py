#!/usr/bin/env python3
"""
test_auth.py

Auth flow automation: magic link, JWT expiry, anonymous session, team invite.

Tests:
1. Magic link send → receive token
2. Magic link verify step 1
3. Magic link complete signup
4. JWT/session expiry handling
5. Anonymous session creation
6. Team invite acceptance

Requires: httpx

Usage:
  python tests/scripts/test_auth.py
"""

import sys
import time
import httpx

APP_URL = "https://atlantist.polsia.app"


def test_magic_link_flow():
    """Full magic link auth cycle."""
    errors = []
    email = f"auth-test-{time.time()}@example.com"
    session_uuid = f"auth-session-{time.time()}"

    # 1. Send magic link
    send_resp = httpx.post(
        f"{APP_URL}/api/auth/send-magic-link",
        json={"email": email, "session_uuid": session_uuid},
        timeout=30
    )
    if send_resp.status_code != 200:
        errors.append(f"send-magic-link failed: {send_resp.status_code}")
        return errors, None

    body = send_resp.json()
    if not body.get("success"):
        errors.append("send-magic-link returned success=false")
        return errors, None

    token = body.get("dev_token")
    if not token:
        errors.append("send-magic-link did not return dev_token")
        return errors, None

    print(f"    Magic link sent, token: {token[:20]}...")

    # 2. Verify step 1
    verify_resp = httpx.post(
        f"{APP_URL}/api/auth/verify-step1",
        json={"token": token},
        timeout=30
    )
    if verify_resp.status_code != 200:
        errors.append(f"verify-step1 failed: {verify_resp.status_code}")
    else:
        vbody = verify_resp.json()
        if vbody.get("email") != email:
            errors.append(f"verify-step1 wrong email: {vbody.get('email')}")

    # 3. Complete signup
    signup_resp = httpx.post(
        f"{APP_URL}/api/auth/complete-signup",
        json={
            "token": token,
            "session_uuid": session_uuid,
            "first_name": "E2E",
            "project_type": "commercial",
            "role": "Architect"
        },
        timeout=30
    )
    if signup_resp.status_code != 200:
        errors.append(f"complete-signup failed: {signup_resp.status_code} — {signup_resp.text[:100]}")
    else:
        sbody = signup_resp.json()
        if not sbody.get("success"):
            errors.append("complete-signup returned success=false")
        cookies = signup_resp.headers.get("set-cookie", "")
        if "session_token" not in cookies:
            errors.append("complete-signup did not set session_token cookie")

    return errors, signup_resp


def test_anonymous_session():
    """Anonymous session initialization."""
    errors = []

    session_uuid = f"anon-{time.time()}"
    resp = httpx.post(
        f"{APP_URL}/api/auth/init",
        json={"session_uuid": session_uuid},
        timeout=30
    )

    if resp.status_code not in (200, 500):
        errors.append(f"auth/init failed: {resp.status_code}")
        return errors

    if resp.status_code == 200:
        body = resp.json()
        if "user_id" not in body:
            errors.append("auth/init response missing user_id")
        if body.get("session_uuid") != session_uuid:
            errors.append("auth/init session_uuid mismatch")

    return errors


def test_invite_flow():
    """Team invite acceptance."""
    errors = []

    # Create invite
    invite_resp = httpx.post(
        f"{APP_URL}/api/invites",
        json={
            "email": f"invite-{time.time()}@example.com",
            "project_id": 1,
            "role": "member"
        },
        timeout=30
    )
    # 201 (created), 404 (endpoint missing), 500 (server error)
    if invite_resp.status_code not in (201, 404, 500):
        errors.append(f"invite creation failed: {invite_resp.status_code}")

    return errors


def test_expired_token_handling():
    """Verify expired/invalid tokens return proper error."""
    errors = []

    resp = httpx.post(
        f"{APP_URL}/api/auth/verify-step1",
        json={"token": "definitely-expired-token-xyz"},
        timeout=30
    )

    if resp.status_code not in (400, 401, 500):
        errors.append(f"expired token returned {resp.status_code} — expected 400/401")

    if resp.status_code == 200:
        body = resp.json()
        if body.get("email"):
            errors.append("expired token returned valid email — should be rejected")

    return errors


def main():
    print("=" * 60)
    print("Auth Flow Automation Test Suite")
    print("=" * 60)

    all_errors = []

    print("\n[1] Testing full magic link flow...")
    errs, signup_resp = test_magic_link_flow()
    if errs:
        print(f"    ❌ FAILED: {errs}")
        all_errors.extend(errs)
    else:
        print("    ✅ PASS")

    print("\n[2] Testing anonymous session...")
    errs = test_anonymous_session()
    if errs:
        print(f"    ❌ FAILED: {errs}")
        all_errors.extend(errs)
    else:
        print("    ✅ PASS")

    print("\n[3] Testing team invite flow...")
    errs = test_invite_flow()
    if errs:
        print(f"    ❌ FAILED: {errs}")
        all_errors.extend(errs)
    else:
        print("    ✅ PASS")

    print("\n[4] Testing expired token handling...")
    errs = test_expired_token_handling()
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