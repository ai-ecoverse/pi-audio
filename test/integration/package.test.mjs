import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { satisfies } from 'semver';

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

test('the pi-ai version the suite runs against satisfies the published peer range', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../../package.json', import.meta.url), 'utf8')
  );
  const installed = JSON.parse(
    await readFile(
      new URL('../../node_modules/@earendil-works/pi-ai/package.json', import.meta.url),
      'utf8'
    )
  );
  const range = manifest.peerDependencies['@earendil-works/pi-ai'];
  assert.ok(satisfies(installed.version, range), `${installed.version} outside ${range}`);
  assert.ok(satisfies(manifest.devDependencies['@earendil-works/pi-ai'], range));
});
