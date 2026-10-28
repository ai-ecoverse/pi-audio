# pi-audio

Voice bindings for [pi](https://github.com/earendil-works/pi): speech-to-text, text-to-speech and realtime speech, in pi's own style. Built for pi-coding-agent plugins and [slicc-agent](https://github.com/ai-ecoverse/slicc-agent).

```sh
npm install @ai-ecoverse/pi-audio
```

A TypeScript ES module library for Node 24 and newer, and for browsers.

| Peer                                        | Required | Used by                             |
| ------------------------------------------- | -------- | ----------------------------------- |
| `@earendil-works/pi-ai`                     | yes      | everything                          |
| `@earendil-works/pi-durable`                | optional | `./durable`                         |
| `node-web-audio-api` or `web-audio-api`     | optional | Node audio output (`openNodeAudio`) |
| `@ai-ecoverse/wasm-webrtc-audio-processing` | optional | `./webrtc-aec`                      |

## Three ways to talk to an agent

- **Voice turns.** A provider is the ears and the mouth; the pi agent is the brain. Speech becomes a `UserMessage`, the agent runs a normal turn, and only its final answer is spoken. Works with any speech-to-text and TTS adapter. See `voiceTurns`.
- **Realtime.** A speech-to-speech model (OpenAI Realtime, xAI Voice, Gemini Live) holds the conversation as the _talker_. The pi agent is the _thinker_ behind one tool, `ask_agent`. See `connectRealtime` and `bindThinker`.
- **Hosted cascades.** ElevenLabs Agents and Fish Audio agents run speech-to-text, an LLM and TTS on their own servers, and plug into the same realtime session and talker/thinker binding. Their talker LLM can be a vendor model or a `CustomLlm`: any OpenAI-compatible endpoint, described with pi's own model fields (`baseUrl`, `id`, `api`, `headers`).

## Models and adapters

Transcription, speech and realtime models are added to pi-ai's `ModelTypeMap` by declaration merging. They aren't chat models, so pi's `Models.getAllModels()` doesn't list them. pi-audio keeps its own catalog: `registerVoiceModel`, `getVoiceModel(type, provider, id)` and `listVoiceModels`. `resolveVoiceAuth(models, voiceModel)` reuses the credential pi already stores for that provider.

Each adapter is its own subpath and registers nothing until you call its `register*` function, which returns an unregister function.

| Subpath               | Register                             | Provides                                                                                          |
| --------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `./openai`            | `registerOpenAI`                     | OpenAI and OpenRouter transcription (batch and streaming) and speech                              |
| `./xai`               | `registerXAI`, `registerXaiRealtime` | xAI speech-to-text and TTS (batch and streaming); xAI Voice realtime                              |
| `./elevenlabs`        | `registerElevenLabs`                 | Scribe transcription (batch and realtime), TTS with character alignment                           |
| `./mistral`           | `registerMistral`                    | Voxtral transcription (batch and realtime), Voxtral TTS                                           |
| `./fish`              | `registerFish`                       | Fish Audio transcription and TTS                                                                  |
| `./google`            | `registerGoogle`                     | Gemini TTS                                                                                        |
| `./cloudflare`        | `registerCloudflare`                 | Workers AI: Deepgram Flux, Nova-3 and Aura, Whisper, MeloTTS                                      |
| `./wavespeed`         | `registerWaveSpeed`                  | Batch Whisper and MiniMax speech (not for live voice)                                             |
| `./openai-realtime`   | `registerOpenAIRealtime`             | `gpt-realtime-2`, `gpt-realtime-2.1`                                                              |
| `./gemini-live`       | `registerGeminiLive`                 | Gemini Live (`gemini-3.8-live` and others)                                                        |
| `./elevenlabs-agents` | `registerElevenLabsAgents`           | ElevenLabs Agents cascade, `provisionAgent`, `elevenLabsCustomLlm`                                |
| `./fish-agents`       | `registerFishAgents`                 | Fish Audio agents cascade (WebRTC via LiveKit), `provisionAgent`, `fishCustomLlm`                 |
| `./brain`             | —                                    | `chatCompletionsBrain`, an optional fetch handler for putting a pi agent behind a `CustomLlm` URL |
| `./durable`           | —                                    | `appendVoiceTruncate` for pi-durable hosts                                                        |
| `./webrtc-aec`        | —                                    | WebRTC AEC3 echo canceller for `echo.mode: "wasm"`                                                |
| `./worklet`           | `registerAudioConvertWorklet`        | Format conversion in an AudioWorklet                                                              |
| `./faux`              | `registerFaux*`                      | Scripted transcription, speech and realtime adapters for tests                                    |

Model capabilities are fields on the model: `streaming`, `turnDetection` (`none`, `vad` or `semantic`), `textStreaming`, `inputFormats` / `outputFormats` and `voices`, and for realtime models also `toolCalls` (`blocking` or `async`), `delivery`, `truncation` and `transports`. Read these flags instead of checking provider names. Prices are on each model's `audioCost`.

## Speech-to-text and TTS

```ts
import { getVoiceModel, speak, transcribe } from '@ai-ecoverse/pi-audio';
import { registerOpenAI } from '@ai-ecoverse/pi-audio/openai';

registerOpenAI();
const ears = getVoiceModel('transcription', 'openai', 'gpt-4o-transcribe');
const mouth = getVoiceModel('speech', 'openai', 'gpt-4o-mini-tts');

const heard = await transcribe(ears, { data: wavBytes, mimeType: 'audio/wav' }, { apiKey });
for await (const event of speak(mouth, { text: heard.text, voice: 'alloy' }, { apiKey })) {
  if (event.type === 'audio') play(event.chunk);
}
```

- `transcribe` is batch. `listen(model, audio)` streams `speech_start`, `partial`, `final` and `turn_end` events, one `turn_end` per user turn. When a model has no turn detection of its own, `listen` ends turns with local voice-activity detection.
- `speak` takes a string or an `AsyncIterable<string>`, so speech can start on the agent's first sentence. When a model can't take streamed text, `speak` sends one request per sentence.
- Audio is binary `AudioChunk`s (`Uint8Array` plus an `AudioFormat`). `convertAudio` and `convertAudioSource` convert between PCM16, float32, G.711 μ-law and A-law, channel counts, sample rates and PCM16 WAV. Opus, MP3 and FLAC pass through only when no conversion is needed.

## Voice turns

```ts
import { listen, speak, voiceTurns } from '@ai-ecoverse/pi-audio';

const options = { ears, mouth, voice: 'alloy', bargeIn: 'onWords' };
const session = voiceTurns({ listen, speak }, conversation, mic, out, options, signal);
for await (const caption of session.captions) render(caption);
```

The host implements `VoiceConversation`: `prompt(message, meta, signal)` runs a pi turn and yields pi-durable-shaped agent events, and `truncate(cut)` records a barge-in.
- **Spoken text.** Only final-answer text is spoken. Thinking, commentary and tool calls stay silent unless `announce(call)` returns a short line.
- **Barge-in.** Modes are `interrupt`, `onWords` (only after the transcriber returns words), `ignore` and `auto` (follows echo calibration). An interruption aborts the turn and the speech, then truncates the reply to what the user heard. With pi-durable, `appendVoiceTruncate` from `./durable` appends a `voice.truncate` entry whose context edit replaces the assistant message with the heard text and keeps its tool calls. The stored entry is unchanged, so the UI still has the full reply.
- **Captions.** `session.captions` streams `user_partial` / `user_final`, `agent_generated` (ahead of the voice), `agent_spoken` (following actual playback, per character when the TTS returns alignment) and `agent_cut`. `captionsFromHistory(entries)` rebuilds them after a reload.
- **Soundscape.** Pass `soundscape` and an `AudioOut` (speech and bed mixed on one output) to play music, ambience or ticking during thinking and tool pauses. `followBed` waits `graceMs` before starting a loop, keeps it across chained tool calls, and ducks it under speech and while the user talks. `session.phases` exposes the same listening, thinking, tool and speaking states for a UI.

## Realtime

```ts
import {
  askAgent,
  bindThinker,
  connectRealtime,
  getVoiceModel,
  mintRealtimeToken,
} from '@ai-ecoverse/pi-audio';
import { registerOpenAIRealtime } from '@ai-ecoverse/pi-audio/openai-realtime';

registerOpenAIRealtime();
const model = getVoiceModel('realtime', 'openai', 'gpt-realtime-2');
const context = { instructions, tools: [askAgent, readTool], voice: 'marin' };
const token = await mintRealtimeToken(model, context, { apiKey });
const session = await connectRealtime(model, context, { token });
await bindThinker(session, thinker, runDirectTool, {
  progress: 'silent',
  result: 'when_idle',
  ack: 'On it.',
  directTimeoutMs: 3000,
  directMaxChars: 4000,
});
```

- **Talker tools.** The talker gets `ask_agent` and `read` (`talkerTools`). The host implements `Thinker`, which runs behind `ask_agent`, and the direct `read` tool.
- **Delivery.** Text pushed into a live voice uses one vocabulary: `interrupt`, `when_idle` or `silent`. Gemini Live maps it natively to its tool scheduling. On blocking models (OpenAI, xAI, Gemini 3.1 Flash Live), `bindThinker` acknowledges `ask_agent` immediately and injects the result later.
- **Truncation.** On barge-in, `interrupt({ itemId, heardMs })` truncates the provider's context to what was heard: `conversation.item.truncate` on OpenAI and xAI. Gemini has no truncate call.
- **Browser auth.** `mintRealtimeToken` runs where the API key lives and returns a short-lived `{ value, expiresAt, model, url? }`. It covers OpenAI and xAI client secrets, Gemini constrained auth tokens, ElevenLabs signed URLs and Fish LiveKit sessions.
- **Cloudflare AI Gateway.** Pass `gateway` to `connectRealtime` to run the same protocols through the gateway.
- **Sessions.** Gemini Live reconnects on `goAway` with session resumption and uses sliding-window context compression. `RealtimeLedger` meters each session, and `close()` returns its priced usage.

## Echo cancellation

Background beds, and the talker's own voice, leak into the microphone and cause false barge-ins. `EchoControl` decides where cancellation runs:
- `browser`: `getUserMedia({ echoCancellation: true })`, with playback through a local WebRTC loopback so Chrome uses it as its echo reference.
- `wasm`: an injected `EchoCanceller` fed by the mic and `AudioOut.reference`. `./webrtc-aec` provides one built on WebRTC AEC3: `createWebRtcEcho({ wasm, sampleRate })` for a module you compiled (works in an AudioWorklet), and `createNodeWebRtcEcho({ sampleRate })` on Node.
- `none`: for headphones.

`calibrateEcho(out, mic, probe, durationMs, signal, canceller?)` plays a probe, measures the delay and the remaining leak, and recommends `interrupt`, `onWords` or `headphones`. Give it at least 3 seconds: AEC3 removes the leak within a second, but its reported cancellation only settles after about 3 seconds of audio.

## Node

`openNodeAudio({ sink: 'none' })` opens an `AudioContext` on Node with `node-web-audio-api`, or the pure-JS `web-audio-api` as a fallback, and works on machines without an audio device. `openMixer(context)` builds the same speech-and-bed graph on a context you already have. On Node:
- echo mode is `wasm` or `none`, and playback is plain Web Audio (no WebRTC loopback);
- the host supplies the microphone as an `AudioSource`;
- pi-audio's worklets release themselves through `bindWorkletNode`, because returning `false` doesn't stop a processor in `node-web-audio-api`.

## Usage and pricing

A voice call reports pi-ai `Usage` with an optional `audio` field (`inputSeconds`, `outputSeconds`, `characters`, `textMessages`). Token counters stay at 0, and the dollar cost goes into the existing `cost` fields, priced from the model's `audioCost` by `priceAudio`.

pi-durable's `addUsage` sums a fixed list of fields and drops `audio`. A host that sums voice usage through pi-durable patches it to also call `addAudioCounters`:

```ts
if (usage.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
addAudioCounters(total, usage);
```

pi-audio doesn't apply that patch itself. Hosts such as slicc-agent record it in their `patches/patches.json`.

## Testing

`@ai-ecoverse/pi-audio/faux` registers scripted adapters: `registerFauxTranscription`, `registerFauxSpeech` and `registerFauxRealtime`. Each returns `{ model, unregister, calls, … }`, so tests can script events and inspect what was sent. Use a unique `api` per test and call `unregister()`. Importing `./faux` registers nothing, and the root package doesn't import it.

## Development

```sh
npm ci
npm run lint
npm test
```

- `npm run lint` runs [slicc-lint](https://github.com/ai-ecoverse/slicc-shared-web): Biome, the type check, the no-comments rule, no unit tests in git, and the AGENTS.md limit. lefthook runs the same checks before each commit.
- `npm test` builds `dist/` and runs the integration tests in `test/integration/`. Tests never call a real speech or LLM provider; adapters are tested against recorded fixtures.
- Unit tests live in the gitignored `test/unit/` and run with `npm run test:unit`.

## Releases

CI is one workflow, `.github/workflows/ci.yml`, which calls [slicc-shared-web's pipeline](https://github.com/ai-ecoverse/slicc-shared-web#pipeline): lint on every event, the integration tests and a Claude and a Codex review on pull requests, and the integration tests again in the merge queue. Every push to `main` then runs semantic-release, which reads the conventional commit messages, tags the version, publishes it to npm through trusted publishing (OIDC) from `ci.yml`, with provenance, and writes the GitHub release. Nothing is published from a branch or from a laptop.

## License

Apache-2.0
