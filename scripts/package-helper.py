#!/usr/bin/env python3
"""Build the private Mac helper from a source allowlist, never runtime data."""
import hashlib
import json
from pathlib import Path
import shutil
import stat
import zipfile

ROOT = Path(__file__).resolve().parent.parent
HELPER = ROOT / "helper"
ALLOWED_ROOT = {"README.md", "package.json", "package-lock.json", "tsconfig.json"}
ALLOWED_DIRS = {"src", "shared", "scripts", "tests"}
ALLOWED_SUFFIXES = {".ts", ".mjs", ".cjs", ".js"}
EXPECTED_COMMANDS = {"setup.command", "start.command", "diagnose.command",
                     "install-service.command", "stop-service.command",
                     "status-service.command", "resume.command"}

files = []
candidates = list(HELPER.iterdir())
for directory in sorted(ALLOWED_DIRS):
    candidates.extend((HELPER / directory).rglob("*"))
for path in sorted(candidates):
    if not path.is_file() or path.is_symlink():
        continue
    relative = path.relative_to(HELPER)
    if len(relative.parts) == 1:
        allowed = relative.name in ALLOWED_ROOT or relative.name in EXPECTED_COMMANDS
    else:
        allowed = relative.parts[0] in ALLOWED_DIRS and path.suffix in ALLOWED_SUFFIXES
        allowed = allowed and not any(part.startswith(".") or part == "node_modules" for part in relative.parts)
    if allowed:
        files.append((path, relative))

package = json.loads((HELPER / "package.json").read_text())
lock = json.loads((HELPER / "package-lock.json").read_text())
version = package["version"]
assert lock["version"] == lock["packages"][""]["version"] == version
assert {relative.name for _, relative in files if len(relative.parts) == 1 and relative.suffix == ".command"} == EXPECTED_COMMANDS
assert any(relative.parts[0] == "shared" for _, relative in files)

archive = ROOT / "public" / "downloads" / "rail-helper.zip"
delivery = ROOT / "outputs" / f"12306-Mac助手-{version}.zip"
archive.parent.mkdir(parents=True, exist_ok=True)
delivery.parent.mkdir(parents=True, exist_ok=True)
temporary = archive.with_name(".rail-helper.zip.tmp")
with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as output:
    for path, relative in files:
        # Fixed archive dates make a repeated build with the same sources identical.
        entry = zipfile.ZipInfo(f"rail-helper/{relative.as_posix()}", date_time=(2026, 10, 6, 0, 0, 0))
        entry.create_system = 3
        mode = 0o755 if relative.suffix == ".command" else 0o644
        entry.external_attr = (stat.S_IFREG | mode) << 16
        entry.compress_type = zipfile.ZIP_DEFLATED
        output.writestr(entry, path.read_bytes(), compresslevel=9)
with zipfile.ZipFile(temporary) as output:
    assert output.testzip() is None
    assert len(output.infolist()) == len(files)
    for path, relative in files:
        entry = output.getinfo(f"rail-helper/{relative.as_posix()}")
        assert output.read(entry) == path.read_bytes(), f"Source changed while packaging: {relative}"
        if relative.suffix == ".command":
            assert ((entry.external_attr >> 16) & 0o777) == 0o755
temporary.replace(archive)
shutil.copyfile(archive, delivery)
assert archive.read_bytes() == delivery.read_bytes()
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
print(json.dumps({"version": version, "fileCount": len(files), "bytes": archive.stat().st_size,
                  "sha256": digest, "archive": str(archive), "delivery": str(delivery),
                  "commands": sorted(EXPECTED_COMMANDS)}, ensure_ascii=False, indent=2))
