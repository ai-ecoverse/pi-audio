# pi-audio

Voice bindings for [pi](https://github.com/earendil-works/pi): speech-to-text, text-to-speech and realtime speech, for pi-coding-agent plugins and [slicc-agent](https://github.com/ai-ecoverse/slicc-agent).

```sh
npm install @ai-ecoverse/pi-audio
```

The package is a TypeScript ES module library for Node 24 and newer. It peers `@earendil-works/pi-ai`.

Transcription, speech, and realtime models are added to pi-ai's `ModelTypeMap` by declaration merging. They are not chat models: `Models.getAllModels()` does not list them. Register them with `registerVoiceModel` and look them up with `getVoiceModel` / `listVoiceModels`. Operations dispatch on `model.api` through `registerTranscriptionApiProvider`, `registerSpeechApiProvider`, and `registerRealtimeApiProvider`. A stored chat credential is reused with `resolveVoiceAuth(models, voiceModel)`, which calls `Models.getAuth` for that provider. Provider adapters ship as their own subpath exports (`@ai-ecoverse/pi-audio/openai`, and the rest) so a host loads only the ones it uses. `@ai-ecoverse/pi-audio/faux` registers scripted transcription, speech, and realtime adapters for tests.

A voice call reports pi-ai `Usage` with an optional `audio` field: `inputSeconds`, `outputSeconds`, `characters`, and `textMessages`. `AudioUsage` is that `Usage`. Token counters stay at 0. Dollars go in `cost.input`, `cost.output`, and `cost.total`, priced from the model's `audioCost` (`perInputMinute`, `perOutputMinute`, `perThousandChars`, `perTextMessage`) by `priceAudio`. Input seconds and text messages land in `cost.input`. Output seconds and characters land in `cost.output`.

pi-durable's `addUsage` (in `packages/durable/src/harness/usage.ts`, not exported from the package) sums a fixed list of token and cost fields and drops `audio`. A host that folds voice usage through pi-durable patches `addUsage` to call `addAudioCounters(total, usage)` beside the reasoning line:

```ts
if (usage.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
addAudioCounters(total, usage);
```

pi-audio does not apply that patch. Hosts such as slicc-agent record monkeypatches in `patches/patches.json`.

`@ai-ecoverse/pi-audio/durable` appends a `voice.truncate` entry for a `VoiceCut`. The entry has no model messages. Its `edits` replace the target assistant message with the text heard so far and keep tool calls. The stored entry stays intact, and pi-durable derives the shorter message for the next model request. `@earendil-works/pi-durable` is an optional peer (`^1.1.0`); the root package does not import it. `VoiceCut.entryId` is the decimal string of pi-durable's numeric entry id.

`@ai-ecoverse/pi-audio/mistral` registers Mistral speech adapters when `registerMistral()` is called. `voxtral-mini-latest` posts multipart audio to `/audio/transcriptions` ($0.003 per minute, diarization on). `voxtral-mini-transcribe-realtime-2602` streams base64 PCM on `wss://…/audio/transcriptions/realtime` after `session.created` ($0.006 per minute). Realtime has no server endpointing, so `turnDetection` is `none` and the registry VAD wrapper applies. `voxtral-mini-tts-2603` posts JSON to `/audio/speech` and reads SSE `speech.audio.delta` float32 PCM at 24 kHz ($0.016 per thousand characters). Hosted voice ids such as `en_paul_neutral` differ from the open-weight presets. `textStreaming` is false.

`@ai-ecoverse/pi-audio/elevenlabs` registers ElevenLabs speech adapters when `registerElevenLabs()` is called. `scribe_v2` posts multipart audio to `/speech-to-text`. `scribe_v2_realtime` streams base64 audio on `wss://…/speech-to-text/realtime` and commits turns with `turn_prediction` (`turnDetection: 'semantic'`). `eleven_flash_v2_5` and `eleven_multilingual_v2` post JSON to `/text-to-speech/{voice}/with-timestamps` for a string and stream text on `stream-input` for an async iterable, with character alignment. `eleven_v3` and `eleven_v4` stay on the HTTP path (`textStreaming: false`). Scribe prices are $0.22 per hour for batch and $0.39 per hour for realtime.

`followBed(bed, soundscape)` cues a `BedChannel` from `VoicePhase`. A loop waits `graceMs` before it starts, so a short gap stays silent. `keep` leaves the current loop running across chained tools. Speech ducks the bed to `duckUnderSpeech`; listening ducks it to `duckUnderUser`. `voiceTurns` does this when `options.soundscape` is set and `out` is an `AudioOut` (`speech`, `bed`, `reference`, `playback`). A plain `AudioSink` still receives only the spoken audio.

`voiceTurns` captions include `agent_spoken`. `upTo` follows `AudioSink` playback: per character when the chunk has alignment, and evenly across the sentence when it does not. `captionsFromHistory(entries)` rebuilds user captions from entries whose `data.source` is `voice`, and agent captions from the assistant text. A `voice.truncate` entry adds `agent_spoken` and `agent_cut` at `heardUpTo`, so the rest of the original text stays available as unheard.
`@ai-ecoverse/pi-audio/xai` registers xAI speech adapters when `registerXAI()` is called. `grok-voice-transcribe-2.0` posts multipart audio to `/stt` (fields before `file`) and streams raw binary frames on `wss://…/stt` after `transcript.created`, with Smart Turn (`turnDetection: 'semantic'`). The catalog id is shared, so `audioCost` uses the streaming rate of $0.20 per hour. `grok-voice-tts-1.0` posts JSON to `/tts` for a string and streams `text.delta` / `audio.delta` on `wss://…/tts` for an async iterable (`textStreaming: true`). Voices are eve, ara, rex, sal, and leo. Codecs are mp3, pcm, wav, mulaw, and alaw.

`@ai-ecoverse/pi-audio/openai` registers OpenAI and OpenRouter speech adapters when `registerOpenAI()` is called. Batch transcription posts multipart audio to `/audio/transcriptions`. OpenRouter (`provider` `openrouter`, or a base URL on `openrouter.ai`) posts JSON `input_audio` instead. Speech posts JSON to `/audio/speech` and reads the raw audio response. OpenAI can return pcm, mp3, wav, opus, or flac. OpenRouter returns pcm or mp3. Realtime transcription uses a WebSocket at `/realtime?intent=transcription` for `gpt-realtime-whisper` and `gpt-live-transcribe`. The catalog key is type, provider, and id, so the batch model keeps the id `gpt-4o-transcribe`.

`convertAudio` and `convertAudioSource` convert between `AudioFormat`s: PCM16, float32, G.711 μ-law and A-law, mono and stereo, sample rate, and PCM16 WAV. Opus, MP3 and FLAC pass through only when the format does not change. `encodeAudioBase64` and `decodeAudioBase64` are the wire helpers for JSON protocols. `AudioChunk.data` stays binary. The same converter runs in an AudioWorklet from `@ai-ecoverse/pi-audio/worklet` (`AUDIO_CONVERT_PROCESSOR`, `registerAudioConvertWorklet`). Adapters declare `inputFormats` and `outputFormats` and do not resample on their own.

`connectRealtime` rejects a transport the model does not list, and a `resumeHandle` when `resumable` is false, with `VoiceRequestError`. `realtimeSocket(url, options, protocols)` keeps that url and copies `protocols`. When `options.gateway` is set it uses `gateway.url` and puts the subprotocol `cf-aig-authorization.<token>` first, which is how a browser sends a Cloudflare AI Gateway credential on the same realtime protocol.

`planDelivery` reads `RealtimeModel.delivery`. An `unsupported` mode throws `VoiceRequestError`. `when_idle` with `approximate` support waits while the model is producing output and runs on `response_done`, `interrupt`, or `close`. Native `when_idle` is sent immediately so the server can schedule it. `planTruncation` adds `{ itemId, audioEndMs }` only when `truncation` is `client` and `interrupt` was given what the listener heard.

`@ai-ecoverse/pi-audio/openai-realtime` registers `gpt-realtime-2` and `gpt-realtime-2.1`. `@ai-ecoverse/pi-audio/xai` registers `grok-voice-latest`, an OpenAI Realtime dialect: input transcripts arrive as cumulative `updated` snapshots, `inject` speaks with `force_message` (no `response.create`), and `session.update` opts into `resumption` and an optional `replace` map. Reconnect with `resumeHandle`. Output audio is tagged with the transcript range spoken since the previous delta. Both adapters take a recorded `wire` in tests and never call a provider. WebRTC uses that same event protocol on a caller-supplied data-channel wire.

`RealtimeLedger` meters one session. Input seconds come from `appendAudio`. Output seconds come from each `output_audio` event: PCM, mulaw, and alaw from the byte length, and a compressed encoding from character alignment. `sendText` and each delivered `inject` add one text message. Tool results do not. `close()` prices those meters with `priceAudio`. Sum that usage once. `response_done.usage` is the adapter's per-response figure, not a second copy of the session total.

`@ai-ecoverse/pi-audio/gemini-live` registers `gemini-3.8-live`, `gemini-live-2.5-flash-native-audio`, and `gemini-3.1-flash-live-preview`. Setup enables sliding-window compression and session resumption. `gemini-3.8-live` leaves function behavior at the model default and accepts `vocabulary` as `customVocabulary`. The 2.5 model declares `NON_BLOCKING`. The 3.1 preview declares `BLOCKING`. `respond` maps `Delivery` onto `scheduling` (`INTERRUPT`, `WHEN_IDLE`, `SILENT`) and returns `status`, `retryable`, and `message`. A `goAway` reconnects with the latest resumable handle. There is no truncate call. The adapter takes a recorded `wire` and never calls Google.

`mintRealtimeToken(model, constraints, options)` returns `{ value, expiresAt, model }` and calls `options.fetch` (or `globalThis.fetch`). OpenAI `POST /v1/realtime/client_secrets` sends a realtime session with instructions, voice, and tools. xAI `POST /v1/realtime/client_secrets` sends only `expires_after.seconds` of 300. Gemini `POST /v1beta/auth_tokens` locks `models/<id>`, instructions, voice, and tools in `liveConnectConstraints` and returns `name`, which the live adapter sends as `access_token`. ElevenLabs `GET /v1/convai/conversation/get-signed-url` takes `agent_id` (or `GET /conversation/token` when the only transport is WebRTC) and expires in 15 minutes. Fish `POST /v1/agent/sessions` sends `agent_id` plus `overrides.system_prompt` and `overrides.voice_id`. `value` is the LiveKit participant token. `expiresAt` is milliseconds. A numeric `expires_at` below `1e12` is unix seconds.

`@ai-ecoverse/pi-audio/elevenlabs-agents` registers `elevenlabs-agent`, a hosted cascade (`provisioning: "agent"`, `truncation: "server"`, `liveToolUpdate: false`). `provisionAgent` creates or updates the agent and reuses it when the spec hash matches. pi tools become client tools. A string `llm` is a vendor model name. A `CustomLlm` sets `llm` to `custom-llm` and sends `custom_llm.url`, `model_id`, `api_type`, and `request_headers` (ElevenLabs `api_key` is a workspace secret reference, not a raw token). `connectRealtime` uses a `RealtimeToken` from `mintRealtimeToken` (`get-signed-url`) when one is passed. Otherwise an API key provisions the agent and mints the signed URL. Silent `inject` sends `contextual_update` with `context_id` `pi-audio`. `close()` prices `audio.inputSeconds` from the wall-clock session at $0.08 per minute.

`talkerTools` is `ask_agent` and `read`. pi-audio defines `askAgent` (a pi `Tool` whose parameters are `request` and optional `context`) and the `Thinker` interface. The host implements `Thinker` and supplies `read`. `bindThinker` runs direct tools with `directTimeoutMs` and truncates their text to `directMaxChars`. On a blocking `ask_agent` it answers with `ack` immediately and injects the result later. On an async call it `respond`s with the result and `options.result`. Progress is injected with `options.progress`. `tool_call_cancelled` aborts the thinker. The binding also yields `thinker_progress` / `thinker_result` captions and `thinking` / `tool` / `idle` phases.

## Development

```sh
npm ci
npm run lint
npm test
```

- `npm run lint` runs [slicc-lint](https://github.com/ai-ecoverse/slicc-shared-web): Biome, the type check, the no-comments rule, no unit tests in git, and the AGENTS.md limit. lefthook runs the same checks before each commit.
- `npm test` builds `dist/` and runs the integration tests in `test/integration/`.
- Unit tests live in the gitignored `test/unit/` and run with `npm run test:unit`.

## Releases

Every push to `main` runs semantic-release, which reads the conventional commit messages, tags the version and writes the GitHub release. A second job then publishes the tag to npm through trusted publishing (OIDC), with provenance, from GitHub-hosted runners. Nothing is published from a branch or from a laptop.

## License

Apache-2.0
