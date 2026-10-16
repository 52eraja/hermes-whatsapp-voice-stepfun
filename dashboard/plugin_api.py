"""Dashboard backend for the WhatsApp Voice tab, mounted at /api/plugins/hermes-whatsapp-voice/.

Runs inside the Hermes dashboard process, behind its auth. Settings are written with Hermes's own
plugin-settings writer, so the dashboard, the Desktop app and `hermes config set` stay in sync.
"""

from __future__ import annotations

import importlib.util
import os
import platform
import shutil
import subprocess
from pathlib import Path

import yaml
from fastapi import APIRouter, HTTPException

PLUGIN_DIR = Path(__file__).resolve().parent.parent
PLUGIN_ID = "hermes-whatsapp-voice"
SERVICE = "hermes-whatsapp-voice"


def _load_sidecar_client():
    # The dashboard loads this file on its own, outside the plugin package; reuse the plugin's module.
    spec = importlib.util.spec_from_file_location("hwv_sidecar_client", PLUGIN_DIR / "sidecar_client.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


sc = _load_sidecar_client()
router = APIRouter()
_pair_proc: subprocess.Popen | None = None


def _schema() -> dict:
    return yaml.safe_load((PLUGIN_DIR / "plugin.yaml").read_text())["config_schema"]


class _SettingsCtx:
    """The one ctx method sidecar_client needs, read from config.yaml like PluginContext does."""

    def get_config(self, key, default=None):
        from hermes_cli.config import load_config_readonly

        entry = ((load_config_readonly() or {}).get("plugins", {}).get("entries", {}) or {}).get(PLUGIN_ID) or {}
        return (entry.get("settings") or {}).get(key, default)


def _client():
    return sc.Client.from_ctx(_SettingsCtx())


@router.get("/status")
def status():
    settings = sc.settings(_SettingsCtx())
    out = {
        "owner_number": str(settings["owner_number"] or ""),
        "gemini_key": bool(sc.gemini_key()),
        "hermes_api_key": bool(_secret("API_SERVER_KEY")),
        "installed": sc.binary_path().exists(),
        "sidecar": None,
        "sidecar_error": None,
        "pairing": _pair_state(),
    }
    try:
        out["sidecar"] = _client().health()
    except sc.SidecarError as e:
        out["sidecar_error"] = str(e)
    return out


def _secret(name: str) -> str:
    from agent.secret_scope import get_secret

    return get_secret(name) or ""


@router.get("/settings")
def get_settings():
    return {"schema": _schema(), "values": sc.settings(_SettingsCtx())}


@router.post("/settings")
def save_settings(body: dict):
    from hermes_cli.plugins_state import _plugin_relative_segments, save_plugin_setting

    schema = _schema()
    types = {"str": str, "int": int, "bool": bool, "dict": dict}
    for key, value in body.items():
        spec = schema.get(key)
        if spec is None:
            raise HTTPException(400, f"unknown setting {key!r}")
        expected = types.get(spec.get("type", "str"), str)
        if expected is int and isinstance(value, bool) or not isinstance(value, expected):
            raise HTTPException(400, f"{key} must be {spec.get('type', 'str')}")
    for key, value in body.items():
        try:
            save_plugin_setting(PLUGIN_ID, _plugin_relative_segments(key), value)
        except PermissionError as e:
            raise HTTPException(403, str(e)) from e
    return {"saved": sorted(body), "restart_needed": True}


@router.post("/restart")
def restart():
    """Restart the sidecar service so new settings apply."""
    if platform.system() == "Linux" and shutil.which("systemctl"):
        cmd = ["systemctl", "--user", "restart", SERVICE]
    elif platform.system() == "Darwin":
        cmd = ["launchctl", "kickstart", "-k", f"gui/{os.getuid()}/com.hermes.whatsapp-voice"]
    else:
        raise HTTPException(501, "No service manager found; restart `hermes whatsapp-voice serve` yourself.")
    done = subprocess.run(cmd, capture_output=True, text=True, timeout=30, check=False)
    if done.returncode != 0:
        raise HTTPException(500, f"restart failed: {done.stderr.strip() or done.stdout.strip()}")
    return {"restarted": True}


def _pair_state() -> str:
    log = sc.data_dir() / "pair.log"
    text = log.read_text(errors="replace") if log.exists() else ""
    if "Linked." in text:
        return "linked"
    if _pair_proc is not None and _pair_proc.poll() is None:
        return "waiting"
    return "failed" if text else "idle"


@router.post("/pair/start")
def pair_start():
    global _pair_proc
    if _pair_proc is not None and _pair_proc.poll() is None:
        return {"pairing": "waiting"}
    try:
        health = _client().health()
    except sc.SidecarError:
        health = None
    if health and health.get("logged_in"):
        raise HTTPException(409, "Already linked. To re-link, unlink the device on the bot's phone first.")
    exe = sc.binary_path()
    if not exe.exists():
        raise HTTPException(409, "Sidecar not installed yet. Run: hermes whatsapp-voice install")
    data = sc.data_dir()
    (data / "pair-qr.svg").unlink(missing_ok=True)
    log = open(data / "pair.log", "w")  # noqa: SIM115 - handed to the child process
    _pair_proc = subprocess.Popen(
        [str(exe), "pair"],
        env={**os.environ, "HWV_DATA_DIR": str(data)},
        stdout=log,
        stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL,
        start_new_session=True,
    )
    return {"pairing": "waiting"}


@router.post("/pair/stop")
def pair_stop():
    if _pair_proc is not None and _pair_proc.poll() is None:
        _pair_proc.terminate()
    return {"pairing": _pair_state()}


@router.get("/pair/qr")
def pair_qr():
    # JSON, not an image URL: dashboard auth is a header that <img src> cannot send.
    qr = sc.data_dir() / "pair-qr.svg"
    return {"pairing": _pair_state(), "svg": qr.read_text() if qr.exists() else None}


@router.post("/call")
def test_call(body: dict):
    reason = str(body.get("reason") or "").strip() or "This is a test call from Hermes."
    try:
        return _client().start_call(reason)
    except sc.SidecarError as e:
        raise HTTPException(502, str(e)) from e


@router.get("/calls")
def calls(limit: int = 10):
    try:
        return {"calls": _client().recent_calls(min(limit, 50))}
    except sc.SidecarError as e:
        raise HTTPException(502, str(e)) from e
