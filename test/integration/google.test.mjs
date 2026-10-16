import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getVoiceModel, speak } from '@ai-ecoverse/pi-audio';
import { registerGoogle } from '@ai-ecoverse/pi-audio/google';

test('google speech adapters run on recorded fixtures', async () => {
  assert.equal(getVoiceModel('speech', 'google', 'gemini-3.8-flash-tts'), undefined);
  const release = registerGoogle();
  try {
    const spoken = [];
    for await (const event of speak(
      getVoiceModel('speech', 'google', 'gemini-3.8-flash-tts'),
      { text: 'hi', voice: 'Kore' },
      {
        apiKey: 'google',
        fetch: async (url, init) => {
          assert.equal(
            String(url),
            'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-tts:generateContent'
          );
          assert.equal(init.headers['x-goog-api-key'], 'google');
          const payload = JSON.parse(init.body);
          assert.deepEqual(payload.generationConfig.responseModalities, ['AUDIO']);
          assert.equal(
            payload.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName,
            'Kore'
          );
          assert.equal(payload.generationConfig.responseFormat.audio.mimeType, 'AUDIO_WAV');
          return Response.json({
            candidates: [
              {
                content: {
                  parts: [{ inlineData: { mimeType: 'audio/wav', data: 'AQ==' } }],
                },
              },
            ],
          });
        },
      }
    ))
      spoken.push(event.type);
    assert.deepEqual(spoken, ['start', 'audio', 'done']);
  } finally {
    release();
  }
});
