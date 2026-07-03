#!/usr/bin/env python3
"""
Test client for the LLM-to-API Bridge.

Usage:
    python3 test_client.py                              # default test
    python3 test_client.py "What is 2+2?"               # custom message
    python3 test_client.py "Hello" --domain claude.ai   # custom domain
"""

from __future__ import annotations

import argparse
import sys
import time

import requests


BASE_URL = "http://localhost:8000"


def health_check() -> dict:
    """Check if the server is running and an extension is connected."""
    resp = requests.get(f"{BASE_URL}/", timeout=5)
    resp.raise_for_status()
    return resp.json()


def send_chat(message: str, domain: str = None) -> dict:
    """Send a chat message through the bridge and return the response."""
    payload = {"message": message}
    if domain:
        payload["domain"] = domain
        
    resp = requests.post(
        f"{BASE_URL}/chat",
        json=payload,
        timeout=180,
    )
    resp.raise_for_status()
    return resp.json()


def main():
    parser = argparse.ArgumentParser(description="LLM-to-API Bridge Test Client")
    parser.add_argument("message", nargs="?", default="What is 2+2?", help="Message to send")
    parser.add_argument("--domain", default=None, help="Target domain (optional, uses linked tab if omitted)")
    parser.add_argument("--health-only", action="store_true", help="Only run health check")
    args = parser.parse_args()

    # Health check
    print("━" * 60)
    print("🏥  Health check...")
    try:
        health = health_check()
        status = "✅ Connected" if health.get("connected") else "⚠️  No extension"
        print(f"   Server: ✅ Running")
        print(f"   Extension: {status}")
    except requests.ConnectionError:
        print("   Server: ❌ Not running (start with: cd server && python3 main.py)")
        sys.exit(1)

    if args.health_only:
        sys.exit(0)

    if not health.get("connected"):
        print("\n⚠️  No Chrome extension connected. Load the extension first.")
        print("   1. Open chrome://extensions")
        print("   2. Enable Developer mode")
        print("   3. Load unpacked → select the extension/ directory")
        sys.exit(1)

    # Send chat
    print("━" * 60)
    print(f"💬  Sending message:" + (f" (domain: {args.domain})" if args.domain else " (using linked tab)"))
    print(f"   \"{args.message}\"")
    print("   Waiting for response...")

    start = time.time()
    try:
        result = send_chat(args.message, args.domain)
        elapsed = time.time() - start
        print("━" * 60)
        print(f"✅  Response received in {elapsed:.1f}s (server reported: {result.get('duration', '?')}s)")
        print(f"   Request ID: {result.get('request_id', 'N/A')}")
        print("━" * 60)
        print(result.get("response", "(empty response)"))
        print("━" * 60)
    except requests.HTTPError as e:
        print(f"❌  HTTP error: {e.response.status_code} — {e.response.text}")
        sys.exit(1)
    except requests.Timeout:
        print("❌  Request timed out (120s)")
        sys.exit(1)


if __name__ == "__main__":
    main()
