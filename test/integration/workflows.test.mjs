import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const pkg = JSON.parse(read('package.json'));
const ci = read('.github/workflows/ci.yml');

test('ci.yml is the only workflow', () => {
  assert.deepEqual(readdirSync(new URL('.github/workflows/', root)), ['ci.yml']);
});

test('ci.yml calls the pipeline at the slicc-shared-web devDependency version', () => {
  const version = pkg.devDependencies['@ai-ecoverse/slicc-shared-web'];
  assert.match(version, /^2\.\d+\.\d+$/);
  const uses = ci.match(
    /uses: ai-ecoverse\/slicc-shared-web\/\.github\/workflows\/pipeline\.yml@v(\S+)/
  );
  assert.equal(uses?.[1], version);
  assert.match(ci, /^ {4}secrets: inherit$/m);
});

test('ci.yml runs on pull requests, the merge queue and pushes to main only', () => {
  assert.match(
    ci,
    /^on:\n {2}pull_request:\n {2}merge_group:\n {2}push:\n {4}branches: \[main\]\n\n/m
  );
  assert.doesNotMatch(ci, /workflow_dispatch|schedule/);
  assert.match(ci, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
});

test('ci.yml grants what the pipeline asks for and picks no runner', () => {
  for (const line of [
    'contents: write',
    'actions: read',
    'issues: write',
    'pull-requests: write',
    'statuses: write',
    'id-token: write',
    'attestations: write',
  ]) {
    assert.match(ci, new RegExp(`^ {2}${line}$`, 'm'));
  }
  assert.doesNotMatch(ci, /runs-on|CERT_RUNNER|CERT_LIGHT_RUNNER|CI_RUNNER/);
  assert.doesNotMatch(ci, /#/);
});

test('the pipeline tests exactly what npm test runs, on one shard', () => {
  const glob = ci.match(/^ {6}test-glob: (\S+)$/m)?.[1];
  assert.ok(glob);
  assert.ok(pkg.scripts.test.includes(`'${glob}'`));
  assert.match(ci, /^ {6}test: npm test$/m);
  assert.match(ci, /^ {6}shards: 1$/m);
  assert.match(pkg.scripts.pretest, /npm run build/);
});

test('semantic-release publishes to npm with provenance, trusted from ci.yml', () => {
  const release = JSON.parse(read('.releaserc.json'));
  assert.ok(release.plugins.includes('@semantic-release/npm'));
  assert.equal(pkg.publishConfig.provenance, true);
  assert.equal(pkg.fledgling.workflow, 'ci.yml');
  assert.equal(pkg.scripts.trust, undefined);
});
