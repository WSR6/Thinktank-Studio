import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gitEnv, trustGitDir } from '../server/agents/codex.js';

test('trustGitDir adds one safe.directory entry with forward slashes', () => {
  const env: NodeJS.ProcessEnv = {};
  trustGitDir('D:\\work\\.thinktank\\app-helper-1', env);
  assert.equal(env.GIT_CONFIG_PARAMETERS, `'safe.directory'='D:/work/.thinktank/app-helper-1'`);
});

test('trustGitDir keeps existing settings and does not repeat itself', () => {
  const env: NodeJS.ProcessEnv = { GIT_CONFIG_PARAMETERS: `'core.autocrlf'='false'` };
  trustGitDir('/tmp/wt', env);
  trustGitDir('/tmp/wt', env);
  assert.equal(env.GIT_CONFIG_PARAMETERS, `'core.autocrlf'='false' 'safe.directory'='/tmp/wt'`);
});

test("Codex's own git settings keep the trusted folder", () => {
  const env: NodeJS.ProcessEnv = {};
  trustGitDir('/tmp/wt', env);
  assert.ok(gitEnv('/proj', [], env.GIT_CONFIG_PARAMETERS).startsWith(`'safe.directory'='/tmp/wt' `));
});
