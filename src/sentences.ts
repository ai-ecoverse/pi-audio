const abbreviations = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'sr',
  'jr',
  'st',
  'vs',
  'etc',
  'eg',
  'ie',
  'fig',
  'no',
]);

function wordBefore(text: string, index: number): string {
  let start = index;
  while (start > 0 && /[A-Za-z]/.test(text[start - 1] ?? '')) start -= 1;
  return text.slice(start, index).toLowerCase();
}

function boundary(text: string, index: number): boolean {
  const ch = text[index];
  if (ch === '\n') return true;
  if (ch !== '.' && ch !== '!' && ch !== '?' && ch !== '…') return false;
  const previous = text[index - 1];
  const next = text[index + 1];
  if (
    (ch === '.' || ch === '…') &&
    previous !== undefined &&
    next !== undefined &&
    previous >= '0' &&
    previous <= '9' &&
    next >= '0' &&
    next <= '9'
  ) {
    return false;
  }
  if (ch === '.' && next === '.') return false;
  if (ch === '.') {
    const word = wordBefore(text, index);
    if (abbreviations.has(word) || /^[A-Za-z]$/.test(word)) return false;
  }
  return true;
}

export function splitSentences(
  buffer: string,
  flush: boolean
): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let start = 0;
  let index = 0;
  while (index < buffer.length) {
    if (!boundary(buffer, index)) {
      index += 1;
      continue;
    }
    const ch = buffer[index];
    const next = index + 1;
    if (ch !== '\n' && next >= buffer.length && !flush) break;
    if (ch !== '\n' && next < buffer.length && !/\s/.test(buffer[next] ?? '')) {
      index += 1;
      continue;
    }
    let end = next;
    while (end < buffer.length && /\s/.test(buffer[end] ?? '')) end += 1;
    const sentence = buffer.slice(start, end);
    if (sentence.trim().length === 0) {
      index = Math.max(end, index + 1);
      continue;
    }
    sentences.push(sentence);
    start = end;
    index = end;
  }
  const rest = buffer.slice(start);
  if (!flush) return { sentences, rest };
  if (rest.length > 0) sentences.push(rest);
  return { sentences, rest: '' };
}

export async function* sentencesOf(text: string | AsyncIterable<string>): AsyncGenerator<string> {
  if (typeof text === 'string') {
    for (const sentence of splitSentences(text, true).sentences) yield sentence;
    return;
  }
  let buffer = '';
  for await (const part of text) {
    buffer += part;
    const split = splitSentences(buffer, false);
    buffer = split.rest;
    for (const sentence of split.sentences) yield sentence;
  }
  for (const sentence of splitSentences(buffer, true).sentences) yield sentence;
}
