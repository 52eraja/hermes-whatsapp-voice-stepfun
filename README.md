# hermes-whatsapp-voice

Live voice calls with [Hermes](https://github.com/NousResearch/hermes-agent) over WhatsApp.

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
                                                 │  16 kHz PCM both ways
                                                 ▼
                                            Gemini Live (speech-to-speech)
                                                 │  ask_hermes(...) tool calls
                                                 ▼
                                            Hermes API server (/v1/runs)
```

- **`hermes-wa-voice`** is a small sidecar built on
  [whatsapp-rust](https://github.com/oxidezap/whatsapp-rust). It links to the bot's WhatsApp number
  as one more linked device (WhatsApp allows four), answers calls from your number only, and places
  calls to your number only.
- Call audio is bridged to **Gemini Live** (`gemini-3.8-live` by default) for natural, interruptible
  speech-to-speech.
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
- A Gemini API key (`GEMINI_API_KEY`). The live models have a free tier, but Google may use free-tier
  data. Paid use is roughly $0.005/min of audio in and $0.018/min out.
- Optional, but needed for the voice agent to reach Hermes: the Hermes
  [API server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server) enabled.
  It must have an `API_SERVER_KEY`.

## Install

```bash
hermes plugins install ashwanthbalakrishnan5/hermes-whatsapp-voice --enable
```

### 1. Set your number

This is the only number that will ever be called, and the only caller that will be answered.

```bash
hermes config set plugins.entries.hermes-whatsapp-voice.settings.owner_number +15551234567
```

### 2. Link the sidecar to the bot's WhatsApp number (once)

```bash
hermes whatsapp-voice pair --phone +15550001111   # the BOT's number; prints a pair code
hermes whatsapp-voice pair                        # or show a QR code instead
```

On the **bot's** phone, open WhatsApp > Linked devices > Link a device > Link with phone number
instead, and type the code.

The first run also fetches the sidecar binary for your platform from this repo's GitHub release.
You don't need Rust or any other toolchain. The download is checked against checksums pinned in
this repo (`sidecar/release-checksums.txt`). If the GitHub CLI is installed, its GitHub build attestation is checked too, which
proves it was built from this repository by its release workflow. Prebuilt binaries cover linux
amd64/arm64 and macOS arm64. To build it yourself instead (Rust 1.94+, cmake, a C compiler), run
`hermes whatsapp-voice install --from-source`.

> **Why a separate link when Hermes is already logged in to WhatsApp?** WhatsApp lets each linked
> device keep only one live connection. Sharing Hermes's WhatsApp session would make the two
> connections knock each other offline, and Hermes's messaging would break. Only the bot's phone
> can approve a new device, so the link happens once. It uses one of WhatsApp's four linked-device
> slots.

### 3. Enable the Hermes API server (recommended)

```bash
# in ~/.hermes/.env
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

## Settings

Set these with `hermes config set plugins.entries.hermes-whatsapp-voice.settings.<key> <value>`:

| key | default | |
|---|---|---|
| `owner_number` | (required) | Your number, international format |
| `voice_model` | `gemini-3.8-live` | Gemini Live model |
| `voice` | `Kore` | Gemini prebuilt voice |
| `assistant_name` | `Hermes` | Name the voice agent uses |
| `ring_timeout_seconds` | `45` | How long an outbound call rings |
| `max_call_minutes` | `15` | Hard cap per call |
| `answer_inbound` | `true` | Answer calls from `owner_number` |
| `send_summary` | `true` | Message a summary after each call |
| `listen` | `127.0.0.1:8796` | Sidecar API address (loopback) |
| `hermes_api_url` | `http://127.0.0.1:8642` | Hermes API server |

Restart the sidecar after changing settings.

## What this plugin does that you should know about

- **Long-running process.** The sidecar runs as a separate process that you start (`serve`, or the
  systemd/launchd unit). The plugin itself only talks to it over loopback HTTP, authenticated with a
  random token stored in the plugin's data directory.
- **Stored credentials.** The sidecar's WhatsApp linked-device session is stored at
  `~/.hermes/plugin-data/hermes-whatsapp-voice/whatsapp.db`. Anyone with that file can act as that
  linked device. Unlink it any time from the bot's phone (Linked devices).
- **Network calls.**
  - WhatsApp servers (signaling and call media relays).
  - `generativelanguage.googleapis.com`, which receives call audio during calls, using
    `GEMINI_API_KEY`.
  - Your local Hermes API server, for `ask_hermes`, the post-call summary, and a short persona
    briefing (Hermes's name, personality and what it knows about you) fetched at startup and after
    each call so the voice matches your Hermes. Uses `API_SERVER_KEY`.
  - `github.com`, only when `install` downloads a release.

  Nothing else, and no telemetry.
- **Who it talks to.** It only answers calls from `owner_number` and only calls `owner_number`.
  Neither tool takes a destination parameter, so a prompt injection cannot make it call anyone else.
  Calls from other numbers are left alone, so the bot's other devices can still take them.
- **Secrets** are read through Hermes (`get_secret`) and passed to the sidecar in its environment.
  The plugin never reads `.env` itself.

## Caveats

- WhatsApp calling here uses an **unofficial**, reverse-engineered protocol (via whatsapp-rust).
  WhatsApp updates can break it, and automated use may violate WhatsApp's Terms of Service. Use a
  number you can afford to lose.
- One call at a time. Group calls and video are not supported.
- A Gemini Live connection lasts about 10 minutes. The sidecar resumes the session transparently, but
  a resume can fail and end a long call.

## Development

```bash
python -m pip install -r requirements-dev.txt
ruff check . && python -m pytest tests/ -q
cd sidecar && cargo test
GEMINI_API_KEY=... cargo test -- --ignored   # live round trip against Gemini
```

Layout: the repo root is the Hermes plugin (`plugin.yaml`, `__init__.py`, `tools.py`, `cli.py`,
`sidecar_client.py`), and `sidecar/` is the Rust sidecar. Tagging `vX.Y.Z` builds attested release
binaries (`.github/workflows/release.yml`). Then commit the release's `SHA256SUMS` as
`sidecar/release-checksums.txt`. Keep `version` in `plugin.yaml` and `sidecar/Cargo.toml` in step
with the tag.

## Credits

- [whatsapp-rust](https://github.com/oxidezap/whatsapp-rust) (MIT) does the WhatsApp protocol and the
  call media work.
- Gemini Live provides the voice.

## License

MIT
