#!/usr/bin/env python3
"""
Datto RMM report link fetcher.

Follows a Datto RMM "Please download the report(s) from here" link (the one
that arrives wrapped through Microsoft SafeLinks and Inky Link Protection)
using a plain HTTP client, saves the resulting ZIP, extracts it, and copies
every PDF inside into a destination folder.

This exists to answer one specific question: does an ordinary script, with
ordinary internet access, succeed where Claude's own sandboxed tools were
blocked? If this works, the link itself was never the problem.

Requirements:
    pip install requests

Usage:
    python fetch_datto_report.py "<the full link from the email>" --dest "C:\\path\\to\\destination"

If --dest is omitted, files land in .\\datto_reports\\<timestamp>\\ next to
this script.
"""

import argparse
import shutil
import sys
import zipfile
from datetime import datetime
from pathlib import Path

import requests

BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
    ),
    "Accept": "*/*",
}


def normalize_link(raw: str) -> str:
    # If the link was copied out of raw HTML (view-source, or a saved .eml/.html
    # export) rather than copied as a real hyperlink, entities like &amp; won't
    # have been decoded. Fix the common ones defensively.
    return raw.strip().replace("&amp;", "&")


def fetch(url: str, dest_dir: Path) -> Path:
    dest_dir.mkdir(parents=True, exist_ok=True)
    session = requests.Session()
    session.headers.update(BROWSER_HEADERS)

    print(f"Requesting: {url[:120]}...")
    resp = session.get(url, allow_redirects=True, timeout=60)

    print(f"Final URL:     {resp.url}")
    print(f"Status:        {resp.status_code}")
    content_type = resp.headers.get("Content-Type", "")
    print(f"Content-Type:  {content_type}")
    print(f"Bytes received: {len(resp.content):,}")

    if resp.status_code != 200:
        raise SystemExit(
            f"\nRequest failed with status {resp.status_code}.\n"
            f"--- First 500 chars of response ---\n{resp.text[:500]}"
        )

    looks_like_zip = "zip" in content_type.lower() or resp.content[:4] == b"PK\x03\x04"
    if not looks_like_zip:
        is_text = "text" in content_type or "html" in content_type
        snippet = resp.text[:1000] if is_text else f"<{len(resp.content)} bytes of binary, not a ZIP signature>"
        raise SystemExit(
            "\nThe response doesn't look like a ZIP file. This usually means "
            "the link expired, was already redeemed, or a protection page is "
            "showing an interstitial instead of serving the file directly.\n"
            f"--- First 1000 chars of response ---\n{snippet}\n\n"
            "Send this output back so it can be diagnosed rather than guessed at."
        )

    zip_path = dest_dir / f"datto_report_{datetime.now():%Y%m%d_%H%M%S}.zip"
    zip_path.write_bytes(resp.content)
    print(f"\nSaved ZIP: {zip_path}  ({zip_path.stat().st_size:,} bytes)")
    return zip_path


def extract_and_copy(zip_path: Path, dest_dir: Path):
    extract_dir = zip_path.with_suffix("")
    extract_dir.mkdir(parents=True, exist_ok=True)

    with zipfile.ZipFile(zip_path) as zf:
        zf.extractall(extract_dir)

    copied = []
    for pdf in extract_dir.rglob("*.pdf"):
        target = dest_dir / pdf.name
        shutil.copy2(pdf, target)
        copied.append(target)
        print(f"Copied: {pdf.name}")

    print(f"\n{len(copied)} PDF(s) copied to {dest_dir}")
    return copied


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("link", help="The full 'download the report(s) from here' URL from the email")
    parser.add_argument(
        "--dest",
        default=None,
        help=r"Destination folder for the extracted PDFs (default: .\datto_reports\<timestamp>)",
    )
    args = parser.parse_args()

    link = normalize_link(args.link)
    dest_dir = Path(args.dest) if args.dest else Path.cwd() / "datto_reports" / f"{datetime.now():%Y%m%d_%H%M%S}"

    try:
        zip_path = fetch(link, dest_dir)
        extract_and_copy(zip_path, dest_dir)
    except requests.exceptions.RequestException as exc:
        print(f"\nNetwork error: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
