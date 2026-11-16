/**
 * @file Exercises whole-index admission and staged-byte checks using synthetic Git responses.
 */
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'

test('root and frontend index bytes cannot bypass backend-grade publication guards', () => {
  execFileSync(
    process.env.PYTHON || 'python',
    [
      '-B',
      '-c',
      `
import importlib.util
from pathlib import Path
import subprocess
import tempfile
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('publication', 'scripts/check_publication.py')
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)
for name in ['.env', 'empty-env/.gitkeep', 'review-assets/favicon.png', 'assets/unreviewed.png', 'unreviewed.config.mjs', 'src/private.csv', 'backend/.gitignore', 'backend/.gitattributes', 'backend/.github/workflows/verify-pr.yml', 'backend/api/secret.json', 'backend/shared/period_levels.py', 'other/file.txt', 'docs/SETUP.md', 'backend/.venv/private.py']:
    assert not guard.admitted(name), name
for name in ['README.md', 'vite.config.mjs', 'src/main.tsx', 'backend/api/read_only.py', 'assets/favicon.png', '.github/workflows/verify.yml']:
    assert guard.admitted(name), name
with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    (root / '.git').mkdir()
    for name in ['README.md', 'vite.config.mjs', 'src/main.tsx', 'backend/api/read_only.py']:
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b'Clean working source\\n')
        secret = ('gh' + 'p_' + 'x' * 36).encode()
        record = ('100644 ' + 'a' * 40 + ' 0\\t' + name + '\\0').encode()
        for blob in [secret, b'Different indexed bytes\\n', b'Clean working source\\n']:
            results = [subprocess.CompletedProcess([], 0, record), subprocess.CompletedProcess([], 0, str(len(blob)).encode()), subprocess.CompletedProcess([], 0, blob)]
            with patch.object(guard.backend.subprocess, 'run', side_effect=results):
                try:
                    names = guard.backend.tracked_paths(root, admission=guard.admitted, byte_check=guard.check_bytes)
                except ValueError as error:
                    assert blob != b'Clean working source\\n'
                    assert secret.decode() not in str(error)
                else:
                    assert blob == b'Clean working source\\n'
                    assert names == [name]
    path = root / 'assets/favicon.png'
    path.parent.mkdir(parents=True)
    png = b'\\x89PNG\\r\\n\\x1a\\n' + b'synthetic'
    path.write_bytes(png)
    record = ('100644 ' + 'a' * 40 + ' 0\\tassets/favicon.png\\0').encode()
    results = [subprocess.CompletedProcess([], 0, record), subprocess.CompletedProcess([], 0, str(len(png)).encode()), subprocess.CompletedProcess([], 0, png)]
    with patch.object(guard.backend.subprocess, 'run', side_effect=results):
        assert guard.backend.tracked_paths(root, admission=guard.admitted, byte_check=guard.check_bytes) == ['assets/favicon.png']
`,
    ],
    { stdio: 'pipe' },
  )
})
