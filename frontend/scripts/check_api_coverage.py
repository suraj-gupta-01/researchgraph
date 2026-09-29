#!/usr/bin/env python3
"""Fail if any backend operation has no frontend surface (or vice versa).

Usage:
  python check_api_coverage.py --openapi http://localhost:8000/openapi.json \
      --registry frontend/src/api/coverage.ts
  python check_api_coverage.py --openapi /tmp/openapi.json --registry coverage.ts

Exit codes: 0 all covered, 1 problems found.
Entries carrying `gap: "Gx"` are reported as pending backend work, not errors,
as long as the endpoint is still absent from the OpenAPI document. Once the
endpoint exists, the `gap` marker must be removed.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.request

# Entry body may contain quoted strings that themselves hold braces ("/topics/{id}").
ENTRY = re.compile(r'"(GET|POST|PUT|PATCH|DELETE) (/[^"]*)"\s*:\s*\{((?:[^{}"]|"(?:[^"\\]|\\.)*")*)\}')
FIELD_STR = re.compile(r'(\w+)\s*:\s*"((?:[^"\\]|\\.)*)"')
FIELD_NUM = re.compile(r'(\w+)\s*:\s*(\d+)')
FIELD_NULL = re.compile(r'(\w+)\s*:\s*null')


def load_openapi(src: str) -> dict:
    if src.startswith(("http://", "https://")):
        with urllib.request.urlopen(src, timeout=10) as r:
            return json.load(r)
    with open(src, encoding="utf-8") as f:
        return json.load(f)


def parse_registry(path: str) -> dict[str, dict]:
    text = open(path, encoding="utf-8").read()
    text = re.sub(r"(?m)^\s*//[^\n]*", "", text)   # strip whole-line comments
    out: dict[str, dict] = {}
    for method, route, body in ENTRY.findall(text):
        fields: dict = {k: v for k, v in FIELD_STR.findall(body)}
        fields.update({k: int(v) for k, v in FIELD_NUM.findall(body)})
        fields.update({k: None for k in FIELD_NULL.findall(body)})
        out[f"{method} {route}"] = fields
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--openapi", required=True)
    ap.add_argument("--registry", required=True)
    args = ap.parse_args()

    spec = load_openapi(args.openapi)
    verbs = {"get", "post", "put", "patch", "delete"}
    api = {f"{m.upper()} {p}" for p, ops in spec["paths"].items() for m in ops if m.lower() in verbs}
    reg = parse_registry(args.registry)

    errors: list[str] = []
    pending: list[str] = []

    for key in sorted(api - reg.keys()):
        errors.append(f"UNCOVERED  {key}: exists in the API but has no entry in the registry")
    for key, e in sorted(reg.items()):
        if "gap" in e:
            if key in api:
                errors.append(f"STALE GAP  {key}: backend now ships it; remove the gap marker ({e['gap']})")
            else:
                pending.append(f"{key} ({e['gap']}, phase {e.get('phase', '?')})")
            continue
        if key not in api:
            errors.append(f"UNKNOWN    {key}: in the registry but not in the API (renamed? add gap: if planned)")
        if e.get("surface") is None and not e.get("reason"):
            errors.append(f"NO SURFACE {key}: surface is null and no reason is given")
        phase = e.get("phase")
        if not isinstance(phase, int) or not 0 <= phase <= 9:
            errors.append(f"BAD PHASE  {key}: phase must be an integer 0-9")

    covered = len(api & reg.keys())
    print(f"API operations: {len(api)}  registry entries: {len(reg)}  covered: {covered}")
    if pending:
        print("\nPending backend gaps:")
        for p in pending:
            print("  -", p)
    if errors:
        print("\nProblems:")
        for e in errors:
            print("  -", e)
        return 1
    print("\nOK: every backend operation has a frontend surface or a documented reason.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
