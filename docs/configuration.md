# Configuration

There are three places to change settings, and all of them write the same values:
- the **WhatsApp Voice** tab in the Hermes web dashboard;
- the plugin's settings page in the Hermes Desktop app (Settings > Plugins);
- the command line: `hermes config set plugins.entries.hermes-whatsapp-voice.settings.<key> <value>`.

Restart the sidecar after a change: the dashboard's **Restart sidecar** button, or
`systemctl --user restart hermes-whatsapp-voice` (Linux), or
`launchctl kickstart -k gui/$(id -u)/com.hermes.whatsapp-voice` (macOS).

## Settings

| key | default | |
|---|---|---|
| `owner_number` | (required) | Your number, international format |
| `voice_model` | `stepaudio-3-realtime-preview` | StepFun Realtime model |
| `voice` | `jingdiannvsheng` | StepFun voice ID |
| `assistant_name` | `Hermes` | Fallback name when Hermes gives no persona briefing |
| `languages` | (empty) | Language codes the voice should speak, e.g. `en-US, ta-IN`; empty allows any |
| `voice_instructions` | (empty) | Your own extra rules for the voice: language, tone, call length |
| `realtime_config` | `{}` | Advanced: any Realtime session field, merged over the defaults (see below) |
| `ring_timeout_seconds` | `45` | How long an outbound call rings |
| `max_call_minutes` | `15` | Hard cap per call (StepFun sessions are capped at 30 minutes) |
| `silence_hangup_seconds` | `180` | End a call when nobody has spoken for this long (e.g. left on hold) |
| `answer_inbound` | `true` | Answer calls from `owner_number` |
| `send_summary` | `true` | Message a summary after each call |
| `listen` | `127.0.0.1:8796` | Sidecar API address (loopback) |
| `hermes_api_url` | `http://127.0.0.1:8642` | Hermes API server |

`languages` has no direct StepFun equivalent: the sidecar adds it to the session instructions and
StepFun's ASR detects the caller's language automatically.

**Every StepFun Realtime option.** `realtime_config` takes any field of the Realtime session
(`session.update`) message and merges it over the plugin's defaults. Objects merge key by key.
`tools` is appended to the plugin's own tools rather than replacing them. For example, to make the
server VAD wait longer before deciding the caller finished, and to pick another voice:

```yaml
# ~/.hermes/config.yaml
plugins:
  entries:
    hermes-whatsapp-voice:
      settings:
        realtime_config:
          turn_detection:
            silence_duration_ms: 900
            energy_awakeness_threshold: 1800
          voice: wenrounansheng
```

The defaults are:
- `modalities`: `["text", "audio"]` (fixed by StepFun);
- `voice`: the `voice` setting;
- `input_audio_format` / `output_audio_format`: `pcm16` (the sidecar resamples to/from 24 kHz);
- `turn_detection`: `server_vad` with `prefix_padding_ms: 300`, `silence_duration_ms: 600`;
- `tools`: `ask_hermes` and `end_call`.

The voice cannot be changed after a session's first audio response; the sidecar sets it once at
session creation, so the configured value always applies. A session lasts at most 30 minutes.

What each field does, and the full event list:
[Realtime API reference](https://platform.stepfun.com/docs/zh/api-reference/realtime/chat),
[realtime guide](https://platform.stepfun.com/docs/zh/guides/developer/realtime),
[StepAudio 3 Realtime model page](https://platform.stepfun.com/docs/zh/guides/models/stepaudio-3-realtime),
and the [official voice list](https://platform.stepfun.com/docs/zh/guides/developer/tts). There is no
speaking-rate parameter. Ask for pace and tone in `voice_instructions` instead.

**Personality.** The voice doesn't use a built-in persona. At startup and after each call, the
sidecar asks your Hermes for a short briefing: its name, its personality, and what it knows about
you. The voice then sounds like your Hermes, and changes to Hermes's memory carry over. Use
`voice_instructions` for anything else, for example:

```bash
hermes config set plugins.entries.hermes-whatsapp-voice.settings.voice_instructions \
  "Keep calls very short and direct. Never ask if there is anything else."
```

## Credentials

The plugin never asks for its own StepFun settings. It reads what Hermes already has:
- **StepFun:** `STEPFUN_API_KEY` from Hermes's `.env` (`~/.hermes/.env` by default) or the Keys
  page. Create one at https://platform.stepfun.com/.
- **Hermes API server:** `API_SERVER_KEY` from Hermes's `.env`. Without it, calls still work but
  the voice can't hand tasks to Hermes, and summaries are raw transcripts.

## Troubleshooting

See the table at the end of the [setup runbook](../skills/setup/SKILL.md#troubleshooting).
