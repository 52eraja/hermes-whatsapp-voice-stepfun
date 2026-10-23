---
name: whatsapp-voice-stepfun
description: Use when setting up, pairing, testing or troubleshooting WhatsApp voice calls through the whatsapp-voice-stepfun plugin (StepFun StepAudio 3 Realtime). Also use when the owner asks to place or inspect a voice call.
user-invocable: false
---

# WhatsApp voice calls with OpenClaw

The `whatsapp-voice-stepfun` plugin places real WhatsApp voice calls to the owner. A small Rust
sidecar holds the WhatsApp linked-device session and talks to StepFun StepAudio 3 Realtime for
speech; the plugin serves a small loopback bridge so the voice on the call can hand real work to
the OpenClaw agent.

Work through the steps in order, run each command on the machine that runs the OpenClaw Gateway,
and stop to ask the owner only where a step says **Ask**. Never ask the owner to paste an API key
into the chat: the StepFun key is read from `STEPFUN_API_KEY` in the Gateway's environment.

## 0. Prerequisites

```bash
openclaw --version                    # expect 2026.5.17 or newer
printenv STEPFUN_API_KEY >/dev/null && echo "stepfun key present"
```

If the key is missing: **Ask** the owner to add `STEPFUN_API_KEY=...` to the Gateway's environment
(`~/.openclaw/.env` on a local install) and to create one at https://platform.stepfun.com/. Then
restart the Gateway.

## 1. Install the plugin and its sidecar

```bash
openclaw plugins install npm:openclaw-whatsapp-voice-stepfun
openclaw whatsapp-voice install
```

`install` downloads the pinned release binary for this platform and verifies its SHA-256 against the
checksum shipped with the plugin. With a logged-in GitHub CLI it also verifies the build
attestation. If no prebuilt binary matches the platform, use `openclaw whatsapp-voice install
--from-source` (needs Rust 1.94+, cmake and a C compiler).

## 2. Set the owner's number

**Ask** for the owner's own WhatsApp number in international format (for example `+15551234567`).
This is the only number the plugin will ever call, and the only caller it answers.

```bash
openclaw config set plugins.entries.whatsapp-voice-stepfun.config.ownerNumber +15551234567
```

## 3. Link the sidecar to the bot's WhatsApp number (needs the owner)

The sidecar becomes one more linked device of the **bot's** number. It cannot reuse an existing
WhatsApp login, because WhatsApp allows only one live connection per linked device. **Ask** the
owner to have the bot's phone in hand, then use one of:

- **Terminal QR:** run `openclaw whatsapp-voice pair` in a terminal the owner can see, and they
  scan it (WhatsApp > Linked devices > Link a device).
- **Pair code (works over SSH):** run `openclaw whatsapp-voice pair --phone <bot number>`, and tell
  the owner the 8-character code to enter under Linked devices > Link a device > Link with phone
  number instead. They must confirm on the phone promptly; if it fails with `hmac-mismatch`, use a
  QR instead.

Linking is done when the output says `Linked.`

## 4. Keep the sidecar running

```bash
openclaw whatsapp-voice service
```

This prints a systemd user unit (Linux), a launchd plist (macOS) or a PowerShell scheduled task
(Windows). Save it where the comment says and enable it. On Linux:

```bash
mkdir -p ~/.config/systemd/user
openclaw whatsapp-voice service | grep -v '^#' > ~/.config/systemd/user/openclaw-whatsapp-voice.service
systemctl --user daemon-reload && systemctl --user enable --now openclaw-whatsapp-voice
loginctl enable-linger "$USER"     # keeps it running while logged out
```

Check it: `openclaw whatsapp-voice status` shows `"logged_in": true`.

On Windows, run `openclaw whatsapp-voice serve` in a background terminal, or paste the printed
PowerShell snippet into PowerShell to register a logon task that restarts the sidecar. The plugin
also starts the sidecar on demand when `autoStart` is on (the default).

## 5. Test it with the owner

1. **Ask** the owner to call the bot's number from their phone. The voice should answer within a
   second or two and greet them.
2. Run `openclaw whatsapp-voice call "Quick test of the voice line"`. Their phone should ring.

After each call the owner gets a short WhatsApp summary. The agent can also call on its own with the
`whatsapp_call_owner` tool, and read the result with `whatsapp_call_status`.

## 6. Offer customization

Tell the owner what they can change under `plugins.entries.whatsapp-voice-stepfun.config` (the
Settings UI, or `openclaw config set plugins.entries.whatsapp-voice-stepfun.config.<key> <value>`):

- `voiceInstructions`: tone, call length, how to pronounce names (for example "keep calls very
  short").
- `languages`: language codes the voice may speak and listen for, for example `en-US, ta-IN`.
- `voice`, `voiceModel`, `assistantName`, `ringTimeoutSeconds`, `maxCallMinutes`,
  `silenceHangupSeconds`, `answerInbound`, `sendSummary`.
- `realtimeConfig`: any StepFun Realtime session field
  (https://platform.stepfun.com/docs/zh/api-reference/realtime/chat), e.g. VAD timing or a
  different voice.
- `agentId`: which OpenClaw agent the voice consults during a call. Empty: the default agent.

After a config change, restart the sidecar (systemd/launchd) so it picks the new settings up.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `No StepFun API key found` | Step 0: add `STEPFUN_API_KEY` to the Gateway's environment. |
| `StepFun rejected the session` | The key is invalid, has no Realtime access, or `voice`/`voiceModel` is wrong. Check the key and `realtimeConfig`. |
| `sidecar not reachable` | The service isn't running: `systemctl --user status openclaw-whatsapp-voice` (Linux) or `launchctl list \| grep whatsapp-voice` (macOS). |
| Service exits with `not linked to WhatsApp yet` | Step 3, then start the service again. |
| The voice can't do things during a call | The plugin's bridge is not running: restart the Gateway so the plugin loads and starts the bridge. |
| The owner's calls aren't answered | `ownerNumber` must match the calling phone exactly (country code included). |
| Logs | `~/.openclaw/plugins/whatsapp-voice-stepfun/sidecar.log` |
