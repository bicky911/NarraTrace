from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import tempfile
import unittest
import uuid
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "build-release.py"
SPEC = importlib.util.spec_from_file_location("narratrace_build_release", SCRIPT)
assert SPEC and SPEC.loader
build_release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(build_release)


class BuildReleaseTests(unittest.TestCase):
    def setUp(self) -> None:
        self.manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))

    def test_discovers_all_manifest_and_diagnostic_runtime_files(self) -> None:
        files = build_release.discover_runtime_files(self.manifest)
        self.assertIn("manifest.json", files)
        self.assertIn("test.html", files)
        self.assertIn("background.js", files)
        self.assertIn("speech-engine.js", files)
        self.assertIn("icons/icon128.png", files)
        self.assertEqual(files, sorted(set(files)))
        build_release.validate_archive_contents(files)

    def test_rejects_parent_traversal_and_encoded_parent_traversal(self) -> None:
        for reference in ("../../outside.js", "%2e%2e/%2e%2e/outside.js"):
            with self.subTest(reference=reference):
                with self.assertRaises(build_release.PackageError):
                    build_release.resolve_reference(reference, "nested/page.html")

    def test_ignores_external_and_fragment_references(self) -> None:
        self.assertIsNone(build_release.resolve_reference("https://example.com/app.js", "popup.html"))
        self.assertIsNone(build_release.resolve_reference("#settings", "popup.html"))
        self.assertIsNone(build_release.resolve_reference("data:text/css,body{}", "popup.html"))

    def test_rejects_symlink_that_escapes_repository_root(self) -> None:
        link_name = f".build-release-escape-{uuid.uuid4().hex}.js"
        link_path = ROOT / link_name
        try:
            with tempfile.TemporaryDirectory() as outside:
                target = Path(outside) / "outside.js"
                target.write_text("/* must not be packaged */", encoding="utf-8")
                try:
                    link_path.symlink_to(target)
                except (OSError, NotImplementedError) as error:
                    self.skipTest(f"symlinks are unavailable in this environment: {error}")

                with self.assertRaises(build_release.PackageError):
                    build_release.discover_runtime_files({
                        "background": {"service_worker": link_name}
                    })
        finally:
            if link_path.is_symlink() or link_path.exists():
                link_path.unlink()

    def test_archive_is_deterministic_valid_and_has_newline_terminated_checksum(self) -> None:
        files = build_release.discover_runtime_files(self.manifest)
        with tempfile.TemporaryDirectory() as temporary:
            output_a = Path(temporary) / "NarraTrace-a.zip"
            output_b = Path(temporary) / "NarraTrace-b.zip"
            archive_a, digest_a = build_release.build_archive(files, self.manifest["version"], output_a)
            archive_b, digest_b = build_release.build_archive(files, self.manifest["version"], output_b)

            self.assertEqual(digest_a, hashlib.sha256(archive_a.read_bytes()).hexdigest())
            self.assertEqual(digest_b, hashlib.sha256(archive_b.read_bytes()).hexdigest())
            self.assertEqual(archive_a.read_bytes(), archive_b.read_bytes())

            sidecar = archive_a.with_suffix(archive_a.suffix + ".sha256")
            self.assertEqual(sidecar.read_text(encoding="utf-8"), f"{digest_a}  {archive_a.name}\n")

            with zipfile.ZipFile(archive_a) as archive:
                names = archive.namelist()
                self.assertEqual(names, sorted(files))
                self.assertIsNone(archive.testzip())
                self.assertFalse(any(name.startswith(("docs/", "tests/", "node_modules/", ".github/")) for name in names))


if __name__ == "__main__":
    unittest.main()
