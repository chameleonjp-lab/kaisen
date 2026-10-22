import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/deploy-pages.yml', import.meta.url), 'utf8');
// Exercise the actual shell gate executed by Actions, without publishing anything.
const block = workflow.match(/^        run: \|\n((?:          .*\n)+)/m);
assert.ok(block, 'the deployment must verify its event, ref and revision before checkout');
const guard = block[1].split('\n').map(line => line.slice(10)).join('\n');
const sha = 'a'.repeat(40);
function allowed(event: string, ref: string, expected = '') {
  return spawnSync('bash', ['-e', '-c', guard], {
    env: { ...process.env, GITHUB_EVENT_NAME: event, GITHUB_REF: ref, GITHUB_SHA: sha, EXPECTED_SHA: expected },
    encoding: 'utf8',
  }).status === 0;
}

test('Pages accepts a main push without manual inputs and keeps exact-SHA manual deployment', () => {
  assert.equal(allowed('push', 'refs/heads/main'), true);
  assert.equal(allowed('workflow_dispatch', 'refs/heads/main', sha), true);
  for (const expected of ['', 'b'.repeat(40)])
    assert.equal(allowed('workflow_dispatch', 'refs/heads/main', expected), false);
});

test('Pages rejects other refs and event types even when their supplied SHA matches', () => {
  for (const event of ['push', 'workflow_dispatch']) for (const ref of ['refs/heads/feature', 'refs/tags/main', 'refs/pull/26/merge'])
    assert.equal(allowed(event, ref, sha), false);
  for (const event of ['pull_request', 'pull_request_target', 'workflow_run', 'schedule'])
    assert.equal(allowed(event, 'refs/heads/main', sha), false);
});
