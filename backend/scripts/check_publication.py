"""Check explicit source inputs or the actual Git index before public disclosure.

This is a technical boundary check, not an authorship or legal clearance. Diagnostics
name files and issue categories, never matched credential values or file contents.
"""

from __future__ import annotations

import argparse
from collections.abc import Callable, Iterable
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess

ROOT_FILES = frozenset(
    {
        ".python-version",
        "README.md",
        "LICENSE.md",
        "THIRD_PARTY_NOTICES.txt",
        "pyproject.toml",
        "requirements-public.txt",
        "requirements-public-win-py313.lock",
        "requirements-dev.txt",
        "requirements-dev-win-py313.lock",
        "run_read_only.py",
        "run_local.py",
        "local_workers.py",
        "runtime_workers.py",
        "ecosystem.config.cjs",
    }
)
SOURCE_DIRS = frozenset({"api", "live", "shared", "tests", "scripts", "docs"})
REQUIRED = frozenset(
    {
        "LICENSE.md",
        "THIRD_PARTY_NOTICES.txt",
        "requirements-public.txt",
        "requirements-public-win-py313.lock",
        "requirements-dev.txt",
        "requirements-dev-win-py313.lock",
        "pyproject.toml",
        "run_read_only.py",
        "tests/fixtures/result_contracts_v1.json",
        "scripts/check_publication.py",
        "scripts/check_quality.py",
        "scripts/check_notices.py",
        "tests/tooling/test_publication.py",
        "tests/tooling/test_ci.py",
    }
)
MAX_FILE_BYTES = 2_000_000
CREDENTIAL_PATTERNS = tuple(
    re.compile(pattern, re.IGNORECASE)
    for pattern in (
        r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----",
        r"\bgh[pousr]_[a-zA-Z0-9]{30,}\b",
        r"\bgithub_pat_[a-zA-Z0-9_]{40,}\b",
        r"\bAKIA[A-Z0-9]{16}\b",
        r"\bAIza[a-zA-Z0-9_-]{30,}\b",
        r"https?://[^/\s\"']+:[^/\s\"']+@",
        r"\b(?:password|passwd|api[_-]?key|auth[_-]?token|authtoken)\s*[:=]\s*[\"'][^\"'\s]{12,}[\"']",
    )
)


def public_path(name: str) -> bool:
    """Allow only deliberately selected authored file kinds at canonical relative paths."""
    parts = name.split("/")
    if (
        not name
        or "\\" in name
        or ":" in name
        or any(ord(char) < 32 or ord(char) == 127 for char in name)
        or any(part in {"", ".", ".."} for part in parts)
    ):
        return False
    if name in ROOT_FILES:
        return True
    if name == "shared/period_levels.py":
        return False
    path = PurePosixPath(name)
    if any(part.startswith(".") or part == "__pycache__" for part in parts[1:]):
        return False
    if parts[0] in {"api", "live", "shared", "scripts", "tests"} and path.suffix == ".py":
        return True
    if name == "tests/fixtures/result_contracts_v1.json":
        return True
    if parts[0] == "docs" and path.suffix == ".md" and path.name.casefold() != "setup.md":
        return True
    return False


def regular_path(root: Path, name: str) -> Path:
    """Reject links, junctions and special files before opening any candidate bytes."""
    path = root
    for part in name.split("/"):
        path = path / part
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode) or path.is_junction():
            raise ValueError(f"Linked publication path: {name}")
    if not stat.S_ISREG(path.lstat().st_mode):
        raise ValueError(f"Non-regular publication file: {name}")
    return path


def check_text(text: str, name: str) -> None:
    """Reject likely credentials without echoing the match; scan every admitted text file."""
    if "\x00" in text or any(pattern.search(text) for pattern in CREDENTIAL_PATTERNS):
        raise ValueError(f"Possible credential or binary content: {name}; inspect privately")


def check_paths(root: Path, names: Iterable[str], *, require_complete: bool = True) -> int:
    """Validate a publication file set, preserving case-sensitive names on Windows too."""
    selected = list(names)
    folded: set[str] = set()
    for name in selected:
        if not public_path(name) or name.casefold() in folded:
            raise ValueError(f"Excluded or duplicate publication path: {name!r}")
        folded.add(name.casefold())
        path = regular_path(root, name)
        if path.stat().st_size > MAX_FILE_BYTES:
            raise ValueError(f"Oversized publication input: {name}")
        check_text(path.read_text(encoding="utf-8"), name)
    if require_complete and not REQUIRED.issubset(selected):
        raise ValueError("Required public source or verification input is missing")
    return len(selected)


def source_paths(root: Path) -> list[str]:
    """Enumerate selected roots without entering local installations or private state."""
    selected = [name for name in sorted(ROOT_FILES) if (root / name).exists()]
    for directory in sorted(SOURCE_DIRS):
        base = root / directory
        if not base.exists():
            continue
        pending = [base]
        while pending:
            path = pending.pop()
            if path.is_symlink() or path.is_junction():
                raise ValueError(f"Linked publication path: {path.relative_to(root).as_posix()}")
            if path.is_dir():
                pending.extend(child for child in path.iterdir() if child.name != "__pycache__")
            else:
                selected.append(path.relative_to(root).as_posix())
    return sorted(selected)


def tracked_paths(
    root: Path,
    *,
    admission: Callable[[str], bool] = public_path,
    byte_check: Callable[[bytes, str], None] | None = None,
) -> list[str]:
    """Check staged names, modes and blobs, including ignored files; never initialize Git."""
    if not (root / ".git").exists():
        raise ValueError("Tracked verification requires this source root's Git repository")
    result = subprocess.run(
        ["git", "-C", str(root), "ls-files", "--cached", "--stage", "-z"],
        check=True,
        capture_output=True,
    )
    names = []
    for record in result.stdout.decode("utf-8").split("\0"):
        if not record:
            continue
        metadata, name = record.split("\t", 1)
        mode, object_id, stage = metadata.split()
        if stage != "0":
            raise ValueError("Unmerged publication index")
        check_index_blob(root, name, mode, object_id, admission=admission, byte_check=byte_check)
        names.append(name)
    return names


def check_index_blob(
    root: Path,
    name: str,
    mode: str,
    object_id: str,
    *,
    admission: Callable[[str], bool] = public_path,
    byte_check: Callable[[bytes, str], None] | None = None,
) -> None:
    """Scan bounded staged bytes and require the tested source to match, allowing CRLF only."""
    if not admission(name) or mode not in {"100644", "100755"}:
        raise ValueError(f"Excluded path or non-regular indexed mode: {name!r}")
    if re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", object_id) is None:
        raise ValueError("Invalid indexed object identity")
    path = regular_path(root, name)
    command = ["git", "-C", str(root), "cat-file"]
    size = subprocess.run([*command, "-s", object_id], check=True, capture_output=True)
    if not 0 <= int(size.stdout) <= MAX_FILE_BYTES:
        raise ValueError(f"Oversized indexed publication input: {name}")
    blob = subprocess.run([*command, "blob", object_id], check=True, capture_output=True).stdout
    if byte_check is None:
        check_text(blob.decode("utf-8"), name)
    else:
        byte_check(blob, name)
    working = path.read_bytes()
    if byte_check is None:
        working = working.replace(b"\r\n", b"\n")
    elif b"\x00" not in blob and name != "assets/favicon.png":
        working = working.replace(b"\r\n", b"\n")
    if path.stat().st_size > MAX_FILE_BYTES or working != blob:
        raise ValueError(f"Indexed content differs from verified working source: {name}")


def component_tracked_paths(root: Path) -> list[str]:
    """Read this component from the monorepo index without admitting any sibling paths."""
    repository = root.parent
    if root.name != "backend" or not (repository / ".git").exists():
        return tracked_paths(root)
    result = subprocess.run(
        ["git", "-C", str(repository), "ls-files", "--cached", "--stage", "-z", "--", "backend/"],
        check=True,
        capture_output=True,
    )
    names = []
    for record in result.stdout.decode("utf-8").split("\0"):
        if not record:
            continue
        metadata, name = record.split("\t", 1)
        mode, object_id, stage = metadata.split()
        if stage != "0" or not name.startswith("backend/"):
            raise ValueError("Invalid backend publication index")
        relative = name.removeprefix("backend/")
        check_index_blob(
            repository,
            name,
            mode,
            object_id,
            admission=lambda value: (
                value.startswith("backend/") and public_path(value.removeprefix("backend/"))
            ),
        )
        names.append(relative)
    return names


def check_ignored(root: Path, names: list[str]) -> None:
    """Reject ignore rules that would omit required inputs from a clean checkout."""
    result = subprocess.run(
        ["git", "-C", str(root), "check-ignore", "--no-index", "--stdin", "-z"],
        input="\0".join(names).encode("utf-8") + b"\0",
        capture_output=True,
    )
    if result.returncode not in {0, 1}:
        raise ValueError("Cannot validate publication ignore rules")
    if result.stdout:
        raise ValueError("Publication input is ignored; inspect ignore rules privately")


def main() -> None:
    """Run explicit pre-Git preparation or mandatory tracked-file CI verification."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", action="store_true", help="Pre-Git preparation only")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    names = source_paths(root) if args.source else component_tracked_paths(root)
    count = check_paths(root, names)
    if not args.source:
        check_ignored(root, names)
    print(
        f"Checked {count} {'source' if args.source else 'tracked'} inputs; rights review is separate."
    )


if __name__ == "__main__":
    main()
