#!/usr/bin/env python3
"""Stormgrid — radar frame archive integrity manifest (C7a).

Builds or verifies a SHA256 manifest of radar frame files.
New frames: warning only (exit 0).
Changed existing frames: warning + exit 1.

This is frame-level integrity only. It does not replace the
event-processing manifest (event windows, coverage, gauge/calibration status).

Usage:
  py build_archive_manifest.py [--archive-dir PATH] [--manifest PATH]
"""
import argparse
import datetime
import hashlib
import json
import os
import sys
from pathlib import Path


# Inferred from build_static_rainfall.py
DEFAULT_FRAME_EXTENSIONS = {'.tif', '.TIF', '.json', '.JSON'}
EXCLUDED_PATTERNS = {
    'manifest',
    'manifest.json',
    'manifest.tmp',
    '.manifest.tmp',
    'index',
    'index.json',
    'readme',
    'README',
    'log',
    'logs',
    '.tmp',
    '.part',
    '.lock',
}


def infer_eligible_extensions(archive_dir):
    """Infer eligible frame extensions from archive contents and defaults."""
    extensions = set(DEFAULT_FRAME_EXTENSIONS)
    archive_path = Path(archive_dir)

    if archive_path.exists():
        for item in archive_path.rglob('*'):
            if item.is_file():
                suffix = item.suffix.lower()
                # Add extensions we find, excluding known non-frame types
                if suffix and not any(exc in item.name.lower() for exc in EXCLUDED_PATTERNS):
                    extensions.add(suffix)

    return extensions


def is_excluded_file(filename):
    """Check if filename should be excluded from manifest."""
    name_lower = filename.lower()
    for pattern in EXCLUDED_PATTERNS:
        if pattern in name_lower or name_lower.endswith(pattern) or filename.endswith(f'.{pattern}'):
            return True
    return False


def compute_sha256(filepath, chunk_size=8192):
    """Compute SHA256 hash of file by reading in chunks."""
    sha256_hash = hashlib.sha256()
    try:
        with open(filepath, 'rb') as f:
            for chunk in iter(lambda: f.read(chunk_size), b''):
                sha256_hash.update(chunk)
        return sha256_hash.hexdigest()
    except (IOError, OSError) as e:
        return None


def walk_archive(archive_dir, eligible_extensions):
    """Walk archive directory for eligible frame files. Returns sorted list of (rel_path, abs_path, mtime)."""
    frames = []
    archive_path = Path(archive_dir)

    if not archive_path.exists():
        return frames

    for item in sorted(archive_path.rglob('*')):
        if not item.is_file():
            continue

        # Check extension
        if item.suffix.lower() not in eligible_extensions:
            continue

        # Check exclusions
        if is_excluded_file(item.name):
            continue

        # Use forward slashes in relative path
        rel_path = item.relative_to(archive_path).as_posix()
        mtime = item.stat().st_mtime
        frames.append((rel_path, str(item), mtime))

    return sorted(frames)  # Sort by rel_path


def build_manifest(archive_dir, manifest_path):
    """Build or verify manifest. Returns (exit_code, manifest_data)."""
    archive_path = Path(archive_dir)
    manifest_path = Path(manifest_path)

    if not archive_path.exists():
        print(f'[manifest] archive not found: {archive_dir}', file=sys.stderr)
        return 2, None

    # Infer eligible extensions
    eligible_exts = infer_eligible_extensions(archive_dir)

    # Walk archive
    frames = walk_archive(archive_dir, eligible_exts)

    if not frames:
        print(f'[manifest] no eligible frames found in {archive_dir}', file=sys.stderr)
        return 2, None

    # Compute hashes for all frames
    frame_hashes = {}
    for rel_path, abs_path, mtime in frames:
        sha256 = compute_sha256(abs_path)
        if sha256 is None:
            print(f'[manifest] failed to hash {rel_path}', file=sys.stderr)
            return 2, None

        frame_hashes[rel_path] = {
            'sha256': sha256,
            'modified_utc': datetime.datetime.utcfromtimestamp(mtime).isoformat() + 'Z',
        }

    # Build manifest
    manifest_data = {
        'generated_at': datetime.datetime.utcnow().isoformat() + 'Z',
        'archive_dir': str(archive_path),
        'frame_count': len(frame_hashes),
        'frames': frame_hashes,
    }

    # Check for existing manifest
    if manifest_path.exists():
        try:
            with open(manifest_path, 'r') as f:
                old_manifest = json.load(f)
            old_frames = old_manifest.get('frames', {})

            # Check for changes
            exit_code = 0
            for rel_path, new_data in frame_hashes.items():
                if rel_path not in old_frames:
                    print(f'[manifest] new frame: {rel_path}', file=sys.stderr)
                    exit_code = 0  # New frames don't fail
                elif old_frames[rel_path]['sha256'] != new_data['sha256']:
                    print(f'[manifest] frame modified: {rel_path} (old hash: {old_frames[rel_path]["sha256"][:16]}... -> new: {new_data["sha256"][:16]}...)', file=sys.stderr)
                    exit_code = 1  # Changed frames fail

            # Check for deleted frames
            for rel_path in old_frames:
                if rel_path not in frame_hashes:
                    print(f'[manifest] frame deleted: {rel_path}', file=sys.stderr)
                    exit_code = 0  # Deletion is not a failure

            return exit_code, manifest_data

        except (IOError, json.JSONDecodeError) as e:
            print(f'[manifest] failed to read existing manifest: {e}', file=sys.stderr)
            return 2, manifest_data

    # Fresh build
    return 0, manifest_data


def write_manifest_atomic(manifest_path, manifest_data):
    """Write manifest atomically using a temp file."""
    manifest_path = Path(manifest_path)
    manifest_path.parent.mkdir(parents=True, exist_ok=True)

    tmp_path = manifest_path.parent / '.manifest.tmp'

    try:
        with open(tmp_path, 'w') as f:
            json.dump(manifest_data, f, indent=2, sort_keys=True)

        os.replace(str(tmp_path), str(manifest_path))
        return True
    except (IOError, OSError) as e:
        print(f'[manifest] failed to write manifest: {e}', file=sys.stderr)
        if tmp_path.exists():
            try:
                tmp_path.unlink()
            except:
                pass
        return False


def main():
    parser = argparse.ArgumentParser(
        description='Build or verify SHA256 manifest of radar frame archive.')
    parser.add_argument('--archive-dir', type=str, default=None,
                        help='Path to archive directory (default: infer from build_static_rainfall.py)')
    parser.add_argument('--manifest', type=str, default=None,
                        help='Path to manifest.json file (default: {archive_dir}/manifest.json)')

    args = parser.parse_args()

    # Determine archive directory
    archive_dir = args.archive_dir
    if not archive_dir:
        # Try to infer from environment or defaults
        archive_dir = os.environ.get('STORMGRID_ARCHIVE_DIR')
        if not archive_dir:
            print('[manifest] no archive path. Pass --archive-dir PATH or set $STORMGRID_ARCHIVE_DIR.',
                  file=sys.stderr)
            sys.exit(2)

    archive_dir = os.path.abspath(archive_dir)

    # Determine manifest path
    manifest_path = args.manifest
    if not manifest_path:
        manifest_path = os.path.join(archive_dir, 'manifest.json')

    manifest_path = os.path.abspath(manifest_path)

    # Build or verify manifest
    exit_code, manifest_data = build_manifest(archive_dir, manifest_path)

    if exit_code == 2:
        sys.exit(2)

    # Write manifest
    if manifest_data:
        if not write_manifest_atomic(manifest_path, manifest_data):
            sys.exit(2)

    sys.exit(exit_code)


if __name__ == '__main__':
    main()
