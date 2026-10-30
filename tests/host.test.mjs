import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { findHost } from '../scripts/manage.mjs';
import { hostSmoke } from '../scripts/host-smoke.mjs';

const installed = findHost();
const hosts = process.env.OPENCLI_TEST_HOSTS ? JSON.parse(process.env.OPENCLI_TEST_HOSTS) : [installed.path];
for (const host of hosts) test(`真实宿主模块隔离加载：${host}`, () => {
  const result = hostSmoke(host, path.join(installed.path, 'node_modules'));
  assert.equal(result.commands.length, 6);
  assert.equal(result.isolated, true);
});
