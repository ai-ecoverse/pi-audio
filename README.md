# pi-audio

Voice bindings for [pi](https://github.com/earendil-works/pi): speech-to-text, text-to-speech and realtime speech, for pi-coding-agent plugins and [slicc-agent](https://github.com/ai-ecoverse/slicc-agent).

```sh
npm install @ai-ecoverse/pi-audio
```

The package is a TypeScript ES module library for Node 24 and newer. It peers `@earendil-works/pi-ai`.

Transcription, speech, and realtime models are added to pi-ai's `ModelTypeMap` by declaration merging. They are not chat models: `Models.getAllModels()` does not list them. Register them with `registerVoiceModel` and look them up with `getVoiceModel` / `listVoiceModels`. Operations dispatch on `model.api` through `registerTranscriptionApiProvider`, `registerSpeechApiProvider`, and `registerRealtimeApiProvider`. A stored chat credential is reused with `resolveVoiceAuth(models, voiceModel)`, which calls `Models.getAuth` for that provider. Provider adapters ship as their own subpath exports (`@ai-ecoverse/pi-audio/openai`, and the rest) so a host loads only the ones it uses. `@ai-ecoverse/pi-audio/faux` registers scripted transcription, speech, and realtime adapters for tests.

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
