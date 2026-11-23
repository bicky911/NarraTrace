#!/usr/bin/env python3
"""Validate and build a clean NarraTrace MV3 release archive using only stdlib."""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import posixpath
import re
import sys
import zipfile
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parent
IMPORT_RE = re.compile(
    r"""(?:\bimport\s*(?:[^'";]*?\sfrom\s*)?|\bexport\s+[^'";]*?\sfrom\s*)["']([^"']+)["']"""
)
HTML_REF_RE = re.compile(r"""(?:src|href)=["']([^"']+)["']""", re.IGNORECASE)
CSS_URL_RE = re.compile(r"""url\(\s*["']?([^"')]+)["']?\s*\)""", re.IGNORECASE)



class PackageError(Exception):
    """Raised when the extension cannot be packaged safely."""


def local_reference(value: str) -> bool:
    value = html.unescape(value.strip())
    if not value or value.startswith(("#", "data:", "blob:", "javascript:")):
        return False
    parsed = urlsplit(value)
    return not parsed.scheme and not parsed.netloc


def resolve_reference(reference: str, source_path: str) -> str | None:
    reference = html.unescape(reference.strip())
    if not local_reference(reference):
        return None
    path_only = unquote(urlsplit(reference).path)
    if not path_only:
        return None

    base = posixpath.dirname(source_path)
    resolved = posixpath.normpath(posixpath.join(base, path_only))
    if resolved in ("", ".") or resolved == ".." or resolved.startswith("../") or resolved.startswith("/"):
        raise PackageError(f"Unsafe local resource path {reference!r} referenced from {source_path}")
    return resolved


def manifest_references(manifest: dict) -> set[str]:
    references = {"manifest.json", "test.html"}
    # The repository owner has not selected a distribution license yet.
    # Include one automatically if a LICENSE file is added later.
    if (ROOT.joinpath("LICENSE").is_file()):
        references.add("LICENSE")
    background = manifest.get("background") or {}
    if background.get("service_worker"):
        references.add(background["service_worker"])

    for item in manifest.get("content_scripts", []):
        references.update(item.get("js", []))
        references.update(item.get("css", []))

    action = manifest.get("action") or {}
    if action.get("default_popup"):
        references.add(action["default_popup"])
    for icon in (action.get("default_icon") or {}).values():
        references.add(icon)
    for icon in (manifest.get("icons") or {}).values():
        references.add(icon)

    for key in ("options_page", "devtools_page"):
        if manifest.get(key):
            references.add(manifest[key])
    for key in ("options_ui", "side_panel"):
        page = (manifest.get(key) or {}).get("page") or (manifest.get(key) or {}).get("default_path")
        if page:
            references.add(page)
    for value in (manifest.get("chrome_url_overrides") or {}).values():
        references.add(value)
    for group in manifest.get("web_accessible_resources", []):
        references.update(group.get("resources", []))

    return references


def discover_runtime_files(manifest: dict) -> list[str]:
    queued = list(sorted(manifest_references(manifest)))
    discovered: set[str] = set()

    while queued:
        relative = queued.pop()
        if relative in discovered:
            continue
        if not isinstance(relative, str):
            raise PackageError(f"Manifest resource path must be a string: {relative!r}")

        normalized = posixpath.normpath(relative)
        if normalized.startswith("../") or normalized in ("", ".", "..") or normalized.startswith("/"):
            raise PackageError(f"Unsafe manifest resource path: {relative!r}")

        path = ROOT.joinpath(*normalized.split("/"))
        if not path.is_file():
            raise PackageError(f"Required runtime file is missing: {normalized}")

        discovered.add(normalized)
        suffix = path.suffix.lower()

        if suffix in (".js", ".mjs"):
            source = path.read_text(encoding="utf-8")
            for match in IMPORT_RE.finditer(source):
                resolved = resolve_reference(match.group(1), normalized)
                if resolved:
                    queued.append(resolved)
        elif suffix in (".html", ".htm"):
            source = path.read_text(encoding="utf-8")
            for match in HTML_REF_RE.finditer(source):
                resolved = resolve_reference(match.group(1), normalized)
                if resolved:
                    queued.append(resolved)
        elif suffix == ".css":
            source = path.read_text(encoding="utf-8")
            for match in CSS_URL_RE.finditer(source):
                resolved = resolve_reference(match.group(1), normalized)
                if resolved:
                    queued.append(resolved)

    return sorted(discovered)


def validate_archive_contents(files: list[str]) -> None:
    forbidden_roots = (".git/", "docs/", "tests/", "node_modules/", "dist/", ".github/")
    for relative in files:
        if relative.startswith(forbidden_roots):
            raise PackageError(f"Development-only path must not enter the release archive: {relative}")
        if relative.endswith((".map", ".pyc")) or relative == "package.json":
            raise PackageError(f"Development artifact must not enter the release archive: {relative}")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def build_archive(files: list[str], version: str, output: Path) -> tuple[Path, str]:
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        output.unlink()

    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for relative in files:
            info = zipfile.ZipInfo(relative, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, ROOT.joinpath(*relative.split("/")).read_bytes())

    digest = sha256_file(output)
    output.with_suffix(output.suffix + ".sha256").write_text(
        f"{digest}  {output.name}\\n", encoding="utf-8"
    )
    return output, digest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build", action="store_true", help="build dist/NarraTrace-vVERSION.zip after validation")
    parser.add_argument("--output", type=Path, help="custom output archive path (implies --build)")
    args = parser.parse_args()

    try:
        manifest_path = ROOT / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if manifest.get("manifest_version") != 3:
            raise PackageError("manifest.json must declare Manifest V3")
        if not re.fullmatch(r"\d+\.\d+\.\d+", str(manifest.get("version", ""))):
            raise PackageError("manifest.json must declare a semantic version (MAJOR.MINOR.PATCH)")
        if not manifest.get("name") or not manifest.get("background", {}).get("service_worker"):
            raise PackageError("manifest.json is missing the extension name or service worker")

        changelog = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
        version_heading = f"## {manifest['version']} —"
        if version_heading not in changelog:
            raise PackageError(f"CHANGELOG.md has no release heading for version {manifest['version']}")

        files = discover_runtime_files(manifest)
        validate_archive_contents(files)
        print(f"[PASS] Manifest V3 metadata and changelog version {manifest['version']}")
        print(f"[PASS] {len(files)} required runtime files exist and local imports resolve")
        print("[PASS] Development tests, docs, node_modules, and build outputs are excluded")

        if args.build or args.output:
            output = args.output or (ROOT / "dist" / f"NarraTrace-v{manifest['version']}.zip")
            if not output.is_absolute():
                output = ROOT / output
            archive_path, digest = build_archive(files, manifest["version"], output)
            print(f"[PASS] Release archive: {archive_path.relative_to(ROOT) if archive_path.is_relative_to(ROOT) else archive_path}")
            print(f"[PASS] SHA-256: {digest}")
        else:
            print("[INFO] Validation only. Use --build to create the ZIP archive.")
        return 0
    except (OSError, json.JSONDecodeError, PackageError, KeyError) as error:
        print(f"[FAIL] Release package validation: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
