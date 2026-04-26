"""
Task 32: Version consistency tests.
All manifests must agree on "5.0.0".
"""
import json
import tomllib
from pathlib import Path

ROOT = Path(__file__).parent.parent
EXPECTED_VERSION = "5.0.0"


def _pyproject_version() -> str:
    """Parse [project].version from pyproject.toml using tomllib (stdlib >=3.11)."""
    with open(ROOT / "pyproject.toml", "rb") as f:
        return tomllib.load(f)["project"]["version"]


def _plugin_json_version() -> str:
    path = ROOT / ".claude-plugin" / "plugin.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    return data["version"]


def _package_json_version() -> str:
    path = ROOT / "package.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    return data["version"]


# ---------------------------------------------------------------------------
# Acceptance criteria 1 — each file individually carries 5.0.0
# ---------------------------------------------------------------------------

def test_pyproject_toml_version():
    """AC1: pyproject.toml version = "5.0.0"."""
    assert _pyproject_version() == EXPECTED_VERSION


def test_plugin_json_version():
    """AC1: .claude-plugin/plugin.json "version": "5.0.0"."""
    assert _plugin_json_version() == EXPECTED_VERSION


def test_package_json_version():
    """AC1: package.json "version": "5.0.0" (retained for ordering safety)."""
    assert _package_json_version() == EXPECTED_VERSION


# ---------------------------------------------------------------------------
# Acceptance criteria 2 — all three agree
# ---------------------------------------------------------------------------

def test_all_manifests_version_consistent():
    """AC2: All three manifests have identical "5.0.0" string."""
    versions = {
        "pyproject.toml": _pyproject_version(),
        "plugin.json": _plugin_json_version(),
        "package.json": _package_json_version(),
    }
    unique = set(versions.values())
    assert unique == {EXPECTED_VERSION}, (
        f"Manifest versions not consistent: {versions}"
    )
