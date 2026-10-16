"""`hermes whatsapp-voice ...` subcommands: install, pair, serve, service, status, call."""

from __future__ import annotations

import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

from .sidecar_client import BINARY_NAME, Client, SidecarError, binary_path, data_dir, settings, sidecar_env

REPO = "ashwanthbalakrishnan5/hermes-whatsapp-voice"
PLUGIN_DIR = Path(__file__).resolve().parent


def _version() -> str:
    for line in (PLUGIN_DIR / "plugin.yaml").read_text().splitlines():
        if line.startswith("version:"):
            return line.split(":", 1)[1].strip()
    raise RuntimeError("version missing from plugin.yaml")


def _release_asset() -> str:
    goos = {"Linux": "linux", "Darwin": "darwin"}.get(platform.system())
    goarch = {"x86_64": "amd64", "amd64": "amd64", "arm64": "arm64", "aarch64": "arm64"}.get(platform.machine().lower())
    if not goos or not goarch:
        raise SystemExit(f"No prebuilt sidecar for {platform.system()}/{platform.machine()}; use --from-source.")
    return f"{BINARY_NAME}_{goos}_{goarch}"


def _build_from_source(dest: Path) -> None:
    cargo = shutil.which("cargo")
    if not cargo:
        raise SystemExit(
            "Rust is not installed (https://rustup.rs; cmake and a C compiler are also needed). "
            "Or drop --from-source to download a release build."
        )
    src = PLUGIN_DIR / "sidecar"
    print(f"Building the sidecar from {src} (takes a few minutes) ...")
    subprocess.run([cargo, "build", "--release", "--locked"], cwd=src, check=True)
    shutil.copy2(src / "target" / "release" / BINARY_NAME, dest)


def _download_release(dest: Path) -> None:
    tag = f"v{_version()}"
    asset = _release_asset()
    base = f"https://github.com/{REPO}/releases/download/{tag}"
    print(f"Downloading {asset} from the {tag} release of {REPO} ...")
    with urllib.request.urlopen(f"{base}/SHA256SUMS", timeout=30) as resp:
        sums = dict(reversed(line.split()) for line in resp.read().decode().splitlines() if line.strip())
    with urllib.request.urlopen(f"{base}/{asset}", timeout=120) as resp:
        blob = resp.read()
    digest = hashlib.sha256(blob).hexdigest()
    if sums.get(asset) != digest:
        raise SystemExit(f"Checksum mismatch for {asset}; refusing to install.")
    tmp = dest.with_suffix(".download")
    tmp.write_bytes(blob)
    tmp.chmod(0o755)
    if shutil.which("gh"):
        # Ties the binary to this repo's release workflow (GitHub build attestation).
        check = subprocess.run(
            ["gh", "attestation", "verify", str(tmp), "--repo", REPO], capture_output=True, text=True, check=False
        )
        if check.returncode != 0:
            tmp.unlink()
            raise SystemExit(f"Build attestation check failed:\n{check.stderr}")
        print("Build attestation verified.")
    else:
        print(
            f"Checksum verified. Install the GitHub CLI to also verify the build attestation (gh attestation verify --repo {REPO})."
        )
    tmp.replace(dest)


def _install(args) -> None:
    dest = binary_path()
    dest.parent.mkdir(parents=True, exist_ok=True)
    if args.from_source:
        _build_from_source(dest)
    else:
        _download_release(dest)
    print(f"Installed {dest}")
    print("Next: hermes whatsapp-voice pair")


def _require_ready(ctx) -> Path:
    exe = binary_path()
    if not exe.exists():
        raise SystemExit("Sidecar not installed. Run: hermes whatsapp-voice install")
    if not settings(ctx)["owner_number"]:
        raise SystemExit(
            "Set your number first: hermes config set plugins.entries.hermes-whatsapp-voice.settings.owner_number +15551234567"
        )
    return exe


def _pair(ctx, phone: str | None) -> None:
    exe = _require_ready(ctx)
    env = {**os.environ, **sidecar_env(ctx)}
    argv = [str(exe), "pair"] + (["--phone", phone] if phone else [])
    raise SystemExit(subprocess.run(argv, env=env, check=False).returncode)


def _serve(ctx) -> None:
    exe = _require_ready(ctx)
    env = {**os.environ, **sidecar_env(ctx)}
    os.execve(str(exe), [str(exe), "serve"], env)


def _service() -> None:
    hermes = shutil.which("hermes") or "hermes"
    log = data_dir() / "sidecar.log"
    if platform.system() == "Darwin":
        print(f"""<!-- Save as ~/Library/LaunchAgents/com.hermes.whatsapp-voice.plist, then:
     launchctl load -w ~/Library/LaunchAgents/com.hermes.whatsapp-voice.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.hermes.whatsapp-voice</string>
  <key>ProgramArguments</key>
  <array><string>{hermes}</string><string>whatsapp-voice</string><string>serve</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>{log}</string>
  <key>StandardErrorPath</key><string>{log}</string>
</dict>
</plist>""")
    else:
        print(f"""# Save as ~/.config/systemd/user/hermes-whatsapp-voice.service, then:
#   systemctl --user daemon-reload && systemctl --user enable --now hermes-whatsapp-voice
#   loginctl enable-linger $USER   # keep it running while logged out
[Unit]
Description=Hermes WhatsApp voice sidecar
After=network-online.target

[Service]
ExecStart={hermes} whatsapp-voice serve
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target""")


def _status(ctx) -> None:
    try:
        print(json.dumps(Client.from_ctx(ctx).health(), indent=2))
    except SidecarError as e:
        raise SystemExit(str(e)) from e


def _call(ctx, reason: str) -> None:
    try:
        print(json.dumps(Client.from_ctx(ctx).start_call(reason), indent=2))
    except SidecarError as e:
        raise SystemExit(str(e)) from e


def setup_parser(subparser) -> None:
    subs = subparser.add_subparsers(dest="wv_command")
    install = subs.add_parser("install", help="Install the sidecar binary (release download, or build with Rust)")
    install.add_argument("--from-source", action="store_true", help="Build with the local Rust toolchain")
    pair = subs.add_parser("pair", help="Link the sidecar to your bot's WhatsApp number (shows a QR code)")
    pair.add_argument("--phone", help="Bot's phone number, to link with a pair code instead of a QR code")
    subs.add_parser("serve", help="Run the sidecar in the foreground")
    subs.add_parser("service", help="Print a systemd/launchd unit that keeps the sidecar running")
    subs.add_parser("status", help="Show sidecar health")
    call = subs.add_parser("call", help="Place a test call to the owner")
    call.add_argument("reason", nargs="?", default="This is a test call from Hermes.")


def make_handler(ctx):
    def handle(args) -> None:
        cmd = getattr(args, "wv_command", None)
        if cmd == "install":
            _install(args)
        elif cmd == "pair":
            _pair(ctx, args.phone)
        elif cmd == "serve":
            _serve(ctx)
        elif cmd == "service":
            _service()
        elif cmd == "status":
            _status(ctx)
        elif cmd == "call":
            _call(ctx, args.reason)
        else:
            print("Usage: hermes whatsapp-voice {install,pair,serve,service,status,call}", file=sys.stderr)

    return handle
