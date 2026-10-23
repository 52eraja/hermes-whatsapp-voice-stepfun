# hermes-whatsapp-voice-stepfun

Live voice calls with [Hermes](https://github.com/NousResearch/hermes-agent) over WhatsApp.

This fork replaces Gemini Live with **StepFun StepAudio 3 Realtime**; the WhatsApp, Hermes and call
behavior is unchanged.

The same sidecar also ships as an **OpenClaw plugin** — see [openclaw/](openclaw) and
[Using it with OpenClaw](#using-it-with-openclaw) below.

- **Call your bot.** Call your Hermes bot's WhatsApp number and talk to it. The voice agent can hand
  real work to Hermes mid-call ("move my 3pm to tomorrow", "what did Sam say about the invoice?").
- **Let Hermes call you.** For things that matter, Hermes can ring you instead of sending a message:
  a top-priority reminder, an urgent alert, a cron job that needs a decision. If you don't pick up,
  the tool says so and Hermes falls back to another channel.
- **Summary afterwards.** When a call ends, Hermes digests the transcript and sends you a short
  summary in WhatsApp.

It works with the personal-number setup most Hermes users already have (WhatsApp linked as a
device). No WhatsApp Business / Cloud API account is needed.

## How it works

```
 your phone ──WhatsApp call──▶ bot number ──▶ hermes-wa-voice (linked device, Rust)
                                                 │  call audio (16 kHz, resampled to/from 24 kHz)
                                                 ▼
                                     StepFun StepAudio 3 Realtime (speech-to-speech)
                                                 │  ask_hermes(...) tool calls
                                                 ▼
                                            Hermes API server (/v1/runs)
```

- **`hermes-wa-voice`** is a small sidecar built on
  [whatsapp-rust](https://github.com/oxidezap/whatsapp-rust). It links to the bot's WhatsApp number
  as one more linked device (WhatsApp allows four), answers calls from your number only, and places
  calls to your number only.
- Call audio is bridged to **StepFun Realtime** (`stepaudio-3-realtime-preview` by default) for
  natural, interruptible speech-to-speech.
- The voice model gets two tools:
  - `ask_hermes`, which runs a Hermes turn through the API server and speaks the result when it
    arrives;
  - `end_call`, which hangs up after a goodbye.
- The **Hermes plugin** adds two agent tools: `whatsapp_call_owner(reason, details?)` and
  `whatsapp_call_status(call_id?)`. It also adds a `hermes whatsapp-voice` command for setup.

## Requirements

- Hermes `>= 0.21.5` on Linux or macOS.
- A separate WhatsApp number for the bot: Hermes's WhatsApp `bot` mode, or any spare number. In
  `self-chat` mode the bot is your own number, and you can't call yourself.
- A StepFun API key in Hermes (`STEPFUN_API_KEY` in `~/.hermes/.env` or the Keys page), created at
  https://platform.stepfun.com/. `stepaudio-3-realtime-preview` is free for a limited preview
  period; StepFun sessions are capped at 30 minutes.
- Optional, but needed for the voice agent to reach Hermes: the Hermes
  [API server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server) enabled.
  It must have an `API_SERVER_KEY`.

## Install

**Let your agent do it.** Tell Hermes (or any coding agent on that machine) to follow
[skills/setup/SKILL.md](skills/setup/SKILL.md). It's a step-by-step runbook written for agents,
and it stops to ask you only for your number and to scan a QR code. After installing, Hermes can
also load it as `hermes-whatsapp-voice:setup`.

**Or by hand:**

```bash
hermes plugins install 52eraja/hermes-whatsapp-voice-stepfun --enable
```

### 1. Set your number

This is the only number that will ever be called, and the only caller that will be answered.

```bash
hermes config set plugins.entries.hermes-whatsapp-voice.settings.owner_number +15551234567
```

### 2. Link the sidecar to the bot's WhatsApp number (once)

Easiest: open the Hermes dashboard, go to the **WhatsApp Voice** tab, click **Pair with
WhatsApp**, and scan the QR from the **bot's** phone (WhatsApp > Linked devices > Link a device).
From a terminal instead:

```bash
hermes whatsapp-voice pair                        # shows a QR code
hermes whatsapp-voice pair --phone +15550001111   # the BOT's number; prints a pair code
```

Prebuilt binaries are published with every release tag. The first `pair`/`serve`/`install` downloads
one automatically, checksum-verified against `sidecar/release-checksums.txt` (and attested with the
GitHub CLI when available). They cover linux amd64/arm64, macOS amd64/arm64 and Windows amd64/arm64.
To build one from source instead:

```bash
hermes whatsapp-voice install --from-source   # needs Rust 1.94+, cmake and a C compiler
```

> **Why a separate link when Hermes is already logged in to WhatsApp?** WhatsApp lets each linked
> device keep only one live connection. Sharing Hermes's WhatsApp session would make the two
> connections knock each other offline, and Hermes's messaging would break. Only the bot's phone
> can approve a new device, so the link happens once. It uses one of WhatsApp's four linked-device
> slots.

### 3. Enable the Hermes API server (recommended)

```bash
# in Hermes's .env (~/.hermes/.env by default)
API_SERVER_ENABLED=true
API_SERVER_KEY=<a long random string>
```

Restart the gateway after this.

### 4. Run the sidecar

```bash
hermes whatsapp-voice serve      # foreground, to try it out
hermes whatsapp-voice service    # prints a systemd user unit (Linux) or launchd plist (macOS)
```

To keep it running, save the printed unit and enable it as the comments in it describe. Check it
with:

```bash
hermes whatsapp-voice status
hermes whatsapp-voice call "Testing the new voice line"
```

## Using it

Call your bot's number from your phone. Or ask Hermes to call you:

> Call me at 7:30 tomorrow about the flight check-in, and if I don't answer, set an urgent reminder.

`whatsapp_call_owner` works from cron runs too, so a scheduled job can escalate to a phone call:

```bash
hermes cron create "0 9 * * 1-5" \
  "If anything on my calendar today is marked urgent, call me about it with whatsapp_call_owner."
```

The tool waits until the call is answered, declined or unanswered, and returns that status. On
`no_answer`/`rejected`/`failed` it tells the agent to use another channel.

## Configure

Everything is configurable from the **WhatsApp Voice** tab in the Hermes dashboard, the Desktop
app's plugin settings, or `hermes config set`. That covers the voice, the model, your own
instructions (language, tone, call length), and any StepFun Realtime session option via
`realtime_config`. The voice takes its name and personality from your own Hermes. Full reference:
[docs/configuration.md](docs/configuration.md).

## What this plugin does that you should know about

- **Long-running process.** The sidecar runs as a separate process that you start (`serve`, or the
  systemd/launchd unit). The plugin itself only talks to it over loopback HTTP, authenticated with a
  random token stored in the plugin's data directory.
- **Stored credentials.** The sidecar's WhatsApp linked-device session is stored at
  `<hermes home>/plugin-data/hermes-whatsapp-voice/whatsapp.db` (the folder is private, mode 700).
  Anyone with that file can act as that linked device. Unlink it any time from the bot's phone
  (Linked devices).
- **Network calls.**
  - WhatsApp servers (signaling and call media relays).
  - `api.stepfun.com` (StepFun Realtime), using `STEPFUN_API_KEY`. It receives call audio during
    calls, plus, as text: the persona briefing (Hermes's name, personality and what it knows about
    you), the reason and details of an outgoing call, and the results of `ask_hermes` requests.
  - Your local Hermes API server, using `API_SERVER_KEY`, for `ask_hermes` (which runs a full
    Hermes turn with your tools), the persona briefing (fetched at startup and after each call),
    and the post-call summary. That summary run asks Hermes to note anything worth remembering, so
    it can write to Hermes's memory.
  - `github.com`, to download the sidecar binary on first `pair`/`serve`/`install` (or from the
    dashboard's Pair button).

  Nothing else, and no telemetry.
- **Who it talks to.** It only answers calls from `owner_number` and only calls `owner_number`.
  Neither tool takes a destination parameter, so a prompt injection cannot make it call anyone else.
  Calls from other numbers are left alone, so the bot's other devices can still take them.
- **Commands it runs.**
  - The dashboard tab's backend (inside the Hermes dashboard, behind its login): `hermes config
    set` for this plugin's settings (only keys declared in `plugin.yaml`); the sidecar's `pair`;
    and `systemctl --user restart` or `launchctl kickstart` for the sidecar service.
  - The CLI: `gh attestation verify` when the GitHub CLI is logged in, and `cargo build` for
    `install --from-source`.
  - The setup skill (only when an agent follows it) appends `API_SERVER_ENABLED` and a generated
    `API_SERVER_KEY` to Hermes's `.env` if they're missing.
- **Secrets** are read through Hermes (`get_secret`) and passed to the sidecar in its environment.
  The plugin never reads `.env` itself. The sidecar's local API only binds to a loopback address.

## Caveats

- WhatsApp calling here uses an **unofficial**, reverse-engineered protocol (via whatsapp-rust).
  WhatsApp updates can break it, and automated use may violate WhatsApp's Terms of Service. Use a
  number you can afford to lose.
- One call at a time. Group calls and video are not supported.
- A StepFun Realtime session lasts at most 30 minutes and cannot be resumed. Keep
  `max_call_minutes` below 30; the sidecar hangs up cleanly before the session expires.

## Using it with OpenClaw

The repo root is the Hermes plugin. [`openclaw/`](openclaw) is the same sidecar packaged as an
OpenClaw plugin: a TypeScript extension that installs the sidecar, pairs it with WhatsApp, and adds
two agent tools (`whatsapp_call_owner`, `whatsapp_call_status`).

The Rust sidecar is shared and unchanged, so the OpenClaw port talks to StepFun exactly like the
Hermes one. Only the "consult the agent during a call" half differs: instead of the Hermes API
server, the plugin serves the sidecar's `/v1/runs` contract on a loopback bridge backed by
OpenClaw's own embedded agent runtime.

```bash
cd openclaw
npm install && npm run build
openclaw plugins install npm:openclaw-whatsapp-voice-stepfun   # or: npm pack && openclaw plugins install <tarball>
openclaw whatsapp-voice install     # downloads the pinned, checksum-verified sidecar binary
openclaw whatsapp-voice pair        # link the bot's WhatsApp number (QR code, or --phone for a pair code)
openclaw whatsapp-voice serve       # run the sidecar in the foreground
```

Set the owner's number and the agent the voice should consult:

```bash
openclaw config set plugins.entries.whatsapp-voice-stepfun.config.ownerNumber +15551234567
openclaw config set plugins.entries.whatsapp-voice-stepfun.config.agentId main
```

`STEPFUN_API_KEY` is read from the Gateway's environment, never from the config file. Full
reference: [openclaw/README.md](openclaw/README.md) and
[openclaw/skills/whatsapp-voice-stepfun/SKILL.md](openclaw/skills/whatsapp-voice-stepfun/SKILL.md),
the runbook an agent follows to set the whole thing up.

## Development

```bash
python -m pip install -r requirements-dev.txt
ruff check . && python -m pytest tests/ -q
cd sidecar && cargo test
STEPFUN_API_KEY=... cargo test -- --ignored   # live round trip against StepFun
cd openclaw && npm install && npm run check    # tsc, vitest, openclaw plugins validate
```

Layout: the repo root is the Hermes plugin (`plugin.yaml`, `__init__.py`, `tools.py`, `cli.py`,
`sidecar_client.py`), `sidecar/` is the Rust sidecar, and `openclaw/` is the OpenClaw plugin that
ships the same sidecar. Tagging `vX.Y.Z` builds attested release
binaries (`.github/workflows/release.yml`). Then commit the release's `SHA256SUMS` as
`sidecar/release-checksums.txt` and mirror it into `openclaw/sidecar-release.json`; a unit test
keeps the two in step. Keep `version` in `plugin.yaml`, `sidecar/Cargo.toml` and
`openclaw/package.json` in step with the tag.

## Credits

- [whatsapp-rust](https://github.com/oxidezap/whatsapp-rust) (MIT) does the WhatsApp protocol and the
  call media work.
- [StepFun StepAudio 3 Realtime](https://platform.stepfun.com/docs/zh/guides/models/stepaudio-3-realtime)
  provides the voice.

## License

MIT
