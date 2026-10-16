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

`@ai-ecoverse/pi-audio/openai` registers OpenAI and OpenRouter speech adapters when `registerOpenAI()` is called. Batch transcription posts multipart audio to `/audio/transcriptions`. OpenRouter (`provider` `openrouter`, or a base URL on `openrouter.ai`) posts JSON `input_audio` instead. Speech posts JSON to `/audio/speech` and reads the raw audio response. OpenAI can return pcm, mp3, wav, opus, or flac. OpenRouter returns pcm or mp3. Realtime transcription uses a WebSocket at `/realtime?intent=transcription` for `gpt-realtime-whisper` and `gpt-live-transcribe`. The catalog key is type, provider, and id, so the batch model keeps the id `gpt-4o-transcribe`.

`convertAudio` and `convertAudioSource` convert between `AudioFormat`s: PCM16, float32, G.711 μ-law and A-law, mono and stereo, sample rate, and PCM16 WAV. Opus, MP3 and FLAC pass through only when the format does not change. `encodeAudioBase64` and `decodeAudioBase64` are the wire helpers for JSON protocols. `AudioChunk.data` stays binary. The same converter runs in an AudioWorklet from `@ai-ecoverse/pi-audio/worklet` (`AUDIO_CONVERT_PROCESSOR`, `registerAudioConvertWorklet`). Adapters declare `inputFormats` and `outputFormats` and do not resample on their own.

`connectRealtime` rejects a transport the model does not list, and a `resumeHandle` when `resumable` is false, with `VoiceRequestError`. `realtimeSocket(url, options, protocols)` keeps that url and copies `protocols`. When `options.gateway` is set it uses `gateway.url` and puts the subprotocol `cf-aig-authorization.<token>` first, which is how a browser sends a Cloudflare AI Gateway credential on the same realtime protocol.

`planDelivery` reads `RealtimeModel.delivery`. An `unsupported` mode throws `VoiceRequestError`. `when_idle` with `approximate` support waits while the model is producing output and runs on `response_done`, `interrupt`, or `close`. Native `when_idle` is sent immediately so the server can schedule it. `planTruncation` adds `{ itemId, audioEndMs }` only when `truncation` is `client` and `interrupt` was given what the listener heard.

`RealtimeLedger` meters one session. Input seconds come from `appendAudio`. Output seconds come from each `output_audio` event: PCM, mulaw, and alaw from the byte length, and a compressed encoding from character alignment. `sendText` and each delivered `inject` add one text message. Tool results do not. `close()` prices those meters with `priceAudio`. Sum that usage once. `response_done.usage` is the adapter's per-response figure, not a second copy of the session total.

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
