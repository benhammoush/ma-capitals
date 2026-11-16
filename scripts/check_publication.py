"""Inspect every monorepo indexed byte while retaining strict backend source admission."""

from __future__ import annotations

import argparse
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend.scripts import check_publication as backend  # noqa: E402

ROOT_FILES = frozenset(
    {
        ".gitattributes",
        ".gitignore",
        ".nvmrc",
        ".prettierrc.json",
        "LICENSE.md",
        "README.md",
        "package.json",
        "package-lock.json",
        "tsconfig.json",
        "vite-env.d.ts",
        "index.html",
        "eslint.config.mjs",
        "playwright.config.mjs",
        "postcss.config.mjs",
        "public-assets.mjs",
        "public-hosting.mjs",
        "vite.config.mjs",
        "cloudflare.config.ts",
        ".github/ci-cd.json",
    }
)
WORKFLOWS = frozenset(
    {
        "verify-pr.yml",
        "verify-and-deploy-dev.yml",
        "verify-and-deploy-prod.yml",
        "weekly-vuln-audit.yml",
        "verify.yml",
        "deliver.yml",
    }
)


def admitted(name: str) -> bool:
    """Allow authored frontend/tooling paths and only strictly admitted backend material."""
    parts = name.split("/")
    if (
        not name
        or "\\" in name
        or ":" in name
        or any(
            not part or part in {".", ".."} or any(ord(c) < 32 or ord(c) == 127 for c in part)
            for part in parts
        )
    ):
        return False
    if name.startswith("backend/"):
        return backend.public_path(name.removeprefix("backend/"))
    if name in ROOT_FILES:
        return True
    if any(part.startswith(".") or part in {"node_modules", "__pycache__"} for part in parts):
        return name.startswith(".github/workflows/") and parts[-1] in WORKFLOWS and len(parts) == 3
    path = Path(name)
    if parts[0] == "src":
        return path.suffix in {".ts", ".tsx", ".css", ".md"}
    if parts[0] == "scripts":
        return path.suffix in {".mjs", ".py"} or name == "scripts/incorporated-notices.txt"
    if parts[0] == "tests":
        return path.suffix == ".mjs"
    if parts[0] == "hosting":
        return name == "hosting/worker.mjs"
    if parts[0] == "docs":
        return path.suffix == ".md" and path.name.casefold() not in {"setup.md", "dev.md"}
    return name in {
        "assets/favicon.png",
        "assets/notices.html",
        "assets/third-party-notices.txt",
    }


def check_bytes(data: bytes, name: str) -> None:
    """Scan text without printing secrets; admit only the reviewed fixed PNG binary path."""
    if name == "assets/favicon.png":
        if not data.startswith(b"\x89PNG\r\n\x1a\n"):
            raise ValueError("Invalid fixed favicon asset")
        return
    text = data.decode("utf-8")
    if not name.startswith("backend/"):
        text = text.replace(
            "https://user:pass@visitor.example.test", "https://visitor.example.test"
        )
    backend.check_text(text, name)


def check(root: Path, *, source: bool = False) -> int:
    """Require whole-index checks in CI; source walking is explicitly pre-Git only."""
    if source:
        names = []
        excluded = {
            ".git",
            "node_modules",
            ".venv",
            "venv",
            "__pycache__",
            "dist",
            "test-results",
            "playwright-report",
            ".cloudflare",
        }
        pending = [root]
        while pending:
            directory = pending.pop()
            for path in directory.iterdir():
                if path.name in excluded:
                    continue
                if path.is_symlink() or path.is_junction():
                    raise ValueError("Linked source input")
                if path.is_dir():
                    pending.append(path)
                else:
                    name = path.relative_to(root).as_posix()
                    if not admitted(name):
                        raise ValueError(f"Excluded publication path: {name}")
                    data = path.read_bytes()
                    if len(data) > backend.MAX_FILE_BYTES:
                        raise ValueError(f"Oversized publication input: {name}")
                    check_bytes(data, name)
                    names.append(name)
    else:
        names = backend.tracked_paths(root, admission=admitted, byte_check=check_bytes)
        backend.check_ignored(root, names)
    folded = [name.casefold() for name in names]
    if len(set(folded)) != len(folded):
        raise ValueError("Case-colliding publication paths")
    required = {
        "package.json",
        "package-lock.json",
        "README.md",
        "LICENSE.md",
        "index.html",
        "vite.config.mjs",
        "scripts/check_publication.py",
        "hosting/worker.mjs",
        ".github/ci-cd.json",
        "tests/tooling/publication.test.mjs",
        *("backend/" + name for name in backend.REQUIRED),
        *(".github/workflows/" + name for name in WORKFLOWS),
    }
    if not required.issubset(names):
        raise ValueError("Required monorepo publication input missing")
    return len(names)


def main() -> None:
    """Run the root publication guard without initializing, staging or changing Git."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source", action="store_true", help="Pre-Git preparation, not indexed clearance"
    )
    args = parser.parse_args()
    print(
        f"Checked {check(ROOT, source=args.source)} monorepo inputs; rights review remains separate."
    )


if __name__ == "__main__":
    main()
