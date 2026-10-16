import type { ProviderRequestOptions, Usage } from '@earendil-works/pi-ai';
import type { TextSpan } from './audio.ts';
import { blankUsage } from './blank-usage.ts';
import { VoiceRequestError } from './errors.ts';
import type { SpeechModel } from './models.ts';
import { sentencesOf } from './sentences.ts';
import {
  type SpeechApiProvider,
  type SpeechEvent,
  SpeechEventStream,
  type SpeechInput,
} from './speech.ts';
import { addAudioCounters } from './usage.ts';

function shiftSpan(span: TextSpan, offset: number): TextSpan {
  if ('entryId' in span) {
    return {
      entryId: span.entryId,
      contentIndex: span.contentIndex,
      start: span.start + offset,
      end: span.end + offset,
    };
  }
  return { itemId: span.itemId, start: span.start + offset, end: span.end + offset };
}

function mergeUsage(usages: Usage[]): Usage {
  const total = blankUsage();
  for (const usage of usages) {
    total.input += usage.input;
    total.output += usage.output;
    total.cacheRead += usage.cacheRead;
    total.cacheWrite += usage.cacheWrite;
    total.totalTokens += usage.totalTokens;
    total.cost.input += usage.cost.input;
    total.cost.output += usage.cost.output;
    total.cost.cacheRead += usage.cost.cacheRead;
    total.cost.cacheWrite += usage.cost.cacheWrite;
    total.cost.total += usage.cost.total;
    if (usage.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
    if (usage.cacheWrite1h !== undefined) {
      total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;
    }
    addAudioCounters(total, usage);
  }
  return total;
}

function failure(error: unknown): SpeechEvent {
  if (error instanceof VoiceRequestError) {
    return { type: 'error', reason: error.reason, error: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { type: 'error', reason: 'error', error: message };
}

async function playSentence(
  speak: SpeechApiProvider['speak'],
  model: SpeechModel<string>,
  input: SpeechInput,
  sentence: string,
  offset: number,
  options: ProviderRequestOptions | undefined,
  stream: SpeechEventStream,
  usages: Usage[],
  state: { started: boolean }
): Promise<boolean> {
  let inner: SpeechEventStream;
  try {
    inner = speak(model, { ...input, text: sentence }, options);
  } catch (error) {
    stream.push(failure(error));
    return false;
  }
  let terminal = false;
  for await (const event of inner) {
    if (options?.signal?.aborted && event.type !== 'error' && event.type !== 'done') {
      stream.push({ type: 'error', reason: 'aborted', error: 'aborted' });
      return false;
    }
    if (event.type === 'start') {
      if (!state.started) stream.push(event);
      state.started = true;
      continue;
    }
    if (event.type === 'audio') {
      stream.push({ ...event, span: shiftSpan(event.span, offset) });
      continue;
    }
    if (event.type === 'done') {
      usages.push(event.usage);
      terminal = true;
      continue;
    }
    stream.push(event);
    return false;
  }
  if (terminal) return true;
  try {
    usages.push(await inner.result());
    return true;
  } catch (error) {
    stream.push(failure(error));
    return false;
  }
}

export function speakInSentences(
  speak: SpeechApiProvider['speak'],
  model: SpeechModel<string>,
  input: SpeechInput,
  options?: ProviderRequestOptions
): SpeechEventStream {
  const stream = new SpeechEventStream();
  void pump(speak, model, input, options, stream);
  return stream;
}

async function pump(
  speak: SpeechApiProvider['speak'],
  model: SpeechModel<string>,
  input: SpeechInput,
  options: ProviderRequestOptions | undefined,
  stream: SpeechEventStream
) {
  if (options?.signal?.aborted) {
    stream.push({ type: 'error', reason: 'aborted', error: 'aborted' });
    return;
  }
  const usages: Usage[] = [];
  const state = { started: false };
  let offset = 0;
  let played = false;
  try {
    for await (const sentence of sentencesOf(input.text)) {
      if (options?.signal?.aborted) {
        stream.push({ type: 'error', reason: 'aborted', error: 'aborted' });
        return;
      }
      played = true;
      const ok = await playSentence(
        speak,
        model,
        input,
        sentence,
        offset,
        options,
        stream,
        usages,
        state
      );
      if (!ok) return;
      offset += sentence.length;
    }
    if (!played) {
      const text = typeof input.text === 'string' ? input.text : '';
      const ok = await playSentence(speak, model, input, text, 0, options, stream, usages, state);
      if (!ok) return;
    }
    stream.push({ type: 'done', usage: mergeUsage(usages) });
  } catch (error) {
    stream.push(failure(error));
  }
}
