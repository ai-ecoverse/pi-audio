import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('the package entry point resolves by its published name and loads as an ES module', async () => {
  const entry = import.meta.resolve('@ai-ecoverse/pi-audio');
  assert.match(entry, /\/dist\/index\.js$/);
  const module = await import('@ai-ecoverse/pi-audio');
  assert.equal(typeof module, 'object');
});

test('the package ships type declarations next to its entry point', async () => {
  const types = await readFile(new URL('../../dist/types/index.d.ts', import.meta.url), 'utf8');
  assert.equal(typeof types, 'string');
});
