import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';

const sandbox = path.resolve(process.argv[2]);
const host = path.join(sandbox, 'host');
const home = path.join(sandbox, 'home');
const runtime = path.join(home, '.opencli');
// 只在此短生命周期子进程替换os.homedir；不修改HOME环境变量或正式文件。
os.homedir = () => home;
syncBuiltinESMExports();
const load = rel => import(pathToFileURL(path.join(host, rel)).href);
const registry = await load('dist/src/registry.js');
const discovery = await load('dist/src/discovery.js');
assert.equal(discovery.USER_OPENCLI_DIR, runtime, '必须先确认隔离路径，才允许调用宿主发现模块');
await discovery.ensureUserCliCompatShims();
fs.mkdirSync(path.join(runtime, 'clis/twitter'), { recursive: true });
fs.writeFileSync(path.join(runtime, 'clis/twitter/kol-tweets.js'), `import {cli} from '@jackwener/opencli/registry'; cli({site:'twitter',name:'kol-tweets',access:'read',description:'user sentinel',browser:false,func:async()=>[]});`);
registry.cli({ site: 'twitter', name: 'kol-tweets', access: 'read', description: 'official sentinel', browser: false, func: async () => [] });
await discovery.discoverClis(path.join(runtime, 'clis'));
assert.equal(registry.getRegistry().get('twitter/kol-tweets').description, 'user sentinel');
await discovery.discoverPlugins();
const commands = registry.getRegistry();
assert.notEqual(commands.get('twitter/kol-tweets').description, 'user sentinel');
const expected = ['twitter/kol-tweets', 'github/releases', 'audiolibrary/search', 'audiolibrary/categories', 'audiolibrary/track', 'youtube/transcript'];
assert.deepEqual([...commands.keys()].sort(), expected.sort());
for (const name of expected) {
  assert.equal(commands.get(name).access, 'read');
  assert.equal(typeof commands.get(name).func, 'function');
}
assert.equal(commands.get('twitter/kol-tweets').func.length, 2);
assert.equal(commands.get('youtube/transcript').func.length, 2);
assert.equal(commands.get('github/releases').func.length, 1);
assert.equal(commands.get('github/releases').browser, false);
assert.equal(commands.get('audiolibrary/search').browser, false);
assert.equal(commands.get('youtube/transcript').browser, true);

// PUBLIC业务用手写响应桩，不访问真实站点；真实errors类型来自所测宿主。
const originalFetch = globalThis.fetch;
let requests = 0;
try {
  globalThis.fetch = async url => {
    requests++;
    assert.match(String(url), /^https:\/\/api.github.com\/repos\/owner\/repo\/releases\?per_page=2$/);
    return new Response(JSON.stringify([{ tag_name: 'v1', name: '版本一', body: 'release notes', html_url: 'https://github.com/owner/repo/releases/v1' }]), { status: 200 });
  };
  const rows = await commands.get('github/releases').func({ repo: 'owner/repo', limit: 2 });
  assert.equal(rows[0].body, 'release notes');
  assert.equal(rows[0].tag_name, 'v1');
  await assert.rejects(() => commands.get('github/releases').func({ repo: '../oops' }), { code: 'ARGUMENT' });
  assert.equal(requests, 1, '无效repo不能发请求');
  globalThis.fetch = async () => new Response('[]', { status: 200 });
  await assert.rejects(() => commands.get('github/releases').func({ repo: 'owner/repo' }), { code: 'EMPTY_RESULT' });
  globalThis.fetch = async () => new Response('{"message":"limited"}', { status: 429 });
  await assert.rejects(() => commands.get('github/releases').func({ repo: 'owner/repo' }), { code: 'COMMAND_EXEC' });
  globalThis.fetch = async () => new Response('<a class="m-list-item" href="/moods/calm"><h2>Calm</h2></a>', { headers: { 'Content-Type': 'text/html' } });
  const moods = await commands.get('audiolibrary/categories').func({ kind: 'moods' });
  assert.equal(moods.length, 1);
  assert.equal(moods[0].kind, 'moods');
  globalThis.fetch = async () => new Response('<a class="m-list-item" href="/genres/ambient"><h2>Ambient</h2></a>', { headers: { 'Content-Type': 'text/html' } });
  const genres = await commands.get('audiolibrary/categories').func({ kind: 'genres' });
  assert.equal(genres[0].slug, 'ambient');
  globalThis.fetch = async () => new Response('blocked', { status: 403, headers: { 'Content-Type': 'text/html' } });
  await assert.rejects(() => commands.get('audiolibrary/search').func({}), { code: 'COMMAND_EXEC' });
} finally { globalThis.fetch = originalFetch; }

const utils = await import(pathToFileURL(path.join(runtime, 'plugins/youtube-transcript/utils.mjs')).href);
const group = await import(pathToFileURL(path.join(runtime, 'plugins/youtube-transcript/transcript-group.mjs')).href);
assert.equal(utils.parseVideoId('https://youtu.be/abcdefghijk'), 'abcdefghijk');
assert.deepEqual(utils.extractJsonAssignmentFromHtml('var ytInitialData = {"x":{"str":"a}b"}};', 'ytInitialData'), { x: { str: 'a}b' } });
const segments = group.groupTranscriptSegments([{ start: 0, duration: 1, text: '你好。' }, { start: 1, duration: 1, text: '世界。' }]);
assert.ok(segments.length > 0);
assert.match(JSON.stringify(group.formatGroupedTranscript(segments)), /你好/);
const version = JSON.parse(fs.readFileSync(path.join(host, 'package.json'))).version;
console.log(JSON.stringify({ version, isolated: true, commands: expected, checks: ['真实discovery/registry/errors依赖解析', '用户覆盖官方哨兵、插件覆盖用户命令', '6命令接口/读权限', 'GitHub成功/参数/空结果/429桩', 'Audio分类/403桩', '字幕必要辅助函数'], liveSites: false, fullCliMain: false }));
