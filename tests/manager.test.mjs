import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { REPO, check, install, selectPlugins } from '../scripts/manage.mjs';
import { parseCommandPage, unwrapResult, hostCompatibility } from '../scripts/contracts.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'opencli-customizations-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hostPackage = path.join(root, 'host');
  fs.mkdirSync(hostPackage);
  fs.writeFileSync(path.join(hostPackage, 'package.json'), JSON.stringify({ name: '@jackwener/opencli', version: '1.8.6' }));
  return { root, runtime: path.join(root, 'runtime'), backupRoot: path.join(root, 'backups'), hostPackage, ids: ['audiolibrary'] };
}
function tree(p) {
  if (!fs.existsSync(p)) return null;
  return Object.fromEntries(fs.readdirSync(p).sort().map(name => {
    const full = path.join(p, name);
    const st = fs.lstatSync(full);
    return [name, st.isSymbolicLink() ? { link: fs.readlinkSync(full) } : st.isDirectory() ? tree(full) : fs.readFileSync(full, 'hex')];
  }));
}
function target(o, id = 'audiolibrary') { return path.join(o.runtime, 'plugins', id); }

test('check和安装预览没有创建目录；默认检查全部，安装必须显式选择', t => {
  const o = fixture(t);
  const before = tree(o.root);
  assert.equal(check(o).plugins[0].status, 'missing');
  assert.equal(install(o).mode, 'preview');
  assert.deepEqual(tree(o.root), before);
  assert.equal(check({ ...o, ids: [] }).plugins.length, 4);
  assert.throws(() => install({ ...o, ids: [] }), /显式选择/);
  assert.throws(() => selectPlugins(['../twitter']), /未知插件/);
  assert.throws(() => selectPlugins(['audiolibrary', 'audiolibrary']), /重复/);
});

test('定向安装幂等；只链接宿主，不安装依赖或触碰clis/原生lock', t => {
  const o = fixture(t);
  fs.mkdirSync(path.join(o.runtime, 'clis'), { recursive: true });
  fs.writeFileSync(path.join(o.runtime, 'clis', 'keep'), 'original');
  fs.writeFileSync(path.join(o.runtime, 'plugins.lock.json'), '{"unrelated":{"source":{"kind":"local"}}}');
  const result = install({ ...o, apply: true });
  assert.deepEqual(result.changed, ['audiolibrary']);
  assert.equal(check(o).plugins[0].status, 'matching');
  assert.deepEqual(fs.readdirSync(path.join(o.runtime, 'plugins')), ['audiolibrary']);
  assert.equal(fs.readFileSync(path.join(o.runtime, 'clis', 'keep'), 'utf8'), 'original');
  assert.equal(fs.readFileSync(path.join(o.runtime, 'plugins.lock.json'), 'utf8'), '{"unrelated":{"source":{"kind":"local"}}}');
  assert.equal(fs.realpathSync(path.join(target(o), 'node_modules/@jackwener/opencli')), o.hostPackage);
  const before = tree(o.root);
  assert.deepEqual(install({ ...o, apply: true }).changed, []);
  assert.deepEqual(tree(o.root), before);
});

test('未知文件/编辑/额外目录/软链接/坏收据拒绝覆盖，整批无部分写入', async t => {
  const cases = {
    edit: p => fs.appendFileSync(path.join(p, 'search.js'), '// local edit'),
    extra: p => fs.writeFileSync(path.join(p, 'unknown.txt'), 'local'),
    directory: p => fs.mkdirSync(path.join(p, 'empty-unknown')),
    link: p => fs.symlinkSync('/tmp', path.join(p, 'unknown-link')),
    receipt: p => fs.writeFileSync(path.join(p, '.customization-state.json'), '{broken'),
    module: p => fs.writeFileSync(path.join(p, 'node_modules/unknown'), 'local'),
  };
  for (const [name, mutate] of Object.entries(cases)) await t.test(name, t => {
    const o = fixture(t);
    install({ ...o, apply: true });
    mutate(target(o));
    const before = tree(o.root);
    assert.equal(check(o).plugins[0].status, 'conflict');
    assert.throws(() => install({ ...o, ids: ['github-releases', 'audiolibrary'], apply: true }), /冲突/);
    assert.deepEqual(tree(o.root), before);
  });
});

test('原生软链接安装、无收据目录和软链接祖先受保护', t => {
  const o = fixture(t);
  fs.mkdirSync(path.join(o.runtime, 'plugins'), { recursive: true });
  fs.symlinkSync(o.hostPackage, target(o), 'dir');
  assert.equal(check(o).plugins[0].status, 'conflict');
  assert.throws(() => install({ ...o, apply: true }), /冲突/);
  fs.unlinkSync(target(o));
  fs.mkdirSync(target(o));
  assert.equal(check(o).plugins[0].status, 'conflict');
  const alias = path.join(o.root, 'alias');
  fs.symlinkSync(o.runtime, alias);
  assert.throws(() => check({ ...o, runtime: alias }), /软链接/);
});

test('原生lock即使目录缺失也受保护，格式未知拒绝写入', t => {
  const o = fixture(t);
  fs.mkdirSync(o.runtime);
  const lock = path.join(o.runtime, 'plugins.lock.json');
  fs.writeFileSync(lock, JSON.stringify({ audiolibrary: { source: { kind: 'local' } } }));
  assert.equal(check(o).plugins[0].status, 'conflict');
  assert.throws(() => install({ ...o, apply: true }), /冲突/);
  fs.writeFileSync(lock, 'broken');
  assert.equal(check(o).plugins[0].status, 'conflict');
});

test('受控旧版本可更新；修改内容保存在外置备份，宿主换路径可重链', t => {
  const o = fixture(t);
  install({ ...o, apply: true });
  const receiptPath = path.join(target(o), '.customization-state.json');
  const receipt = JSON.parse(fs.readFileSync(receiptPath));
  receipt.host.version = '1.8.4';
  fs.writeFileSync(receiptPath, JSON.stringify(receipt));
  assert.equal(check(o).plugins[0].status, 'host-relink');
  const before = tree(target(o));
  const result = install({ ...o, apply: true });
  assert.deepEqual(tree(path.join(result.backup, 'audiolibrary')), before);
  assert.equal(check(o).plugins[0].status, 'matching');
  const nextHost = path.join(o.root, 'host-next');
  fs.cpSync(o.hostPackage, nextHost, { recursive: true });
  assert.equal(check({ ...o, hostPackage: nextHost }).plugins[0].status, 'host-relink');
  install({ ...o, hostPackage: nextHost, apply: true });
  assert.equal(fs.realpathSync(path.join(target(o), 'node_modules/@jackwener/opencli')), nextHost);
});

test('更新源有来源校验，安装前所有目标校验；已知旧收据可迁移', t => {
  const o = fixture(t);
  const repo = path.join(o.root, 'repo');
  fs.mkdirSync(repo);
  for (const file of ['plugins', 'opencli-plugin.json', 'sources.json']) fs.cpSync(path.join(REPO, file), path.join(repo, file), { recursive: true });
  install({ ...o, repo, apply: true });
  const src = path.join(repo, 'plugins/audiolibrary/search.js');
  fs.appendFileSync(src, '\n// verified new revision\n');
  assert.throws(() => check({ ...o, repo }), /源码哈希变化/);
  const sources = JSON.parse(fs.readFileSync(path.join(repo, 'sources.json')));
  // 新版本的来源清单由维护者审查更新，不提供跳过哈希保护的force选项。
  return import('node:crypto').then(({ createHash }) => {
    sources.files.find(f => f.file === 'plugins/audiolibrary/search.js').sha256 = createHash('sha256').update(fs.readFileSync(src)).digest('hex');
    fs.writeFileSync(path.join(repo, 'sources.json'), JSON.stringify(sources));
    assert.equal(check({ ...o, repo }).plugins[0].status, 'update-available');
    install({ ...o, repo, apply: true });
    assert.equal(check({ ...o, repo }).plugins[0].status, 'matching');
  });
});

test('批次发布中途失败：恢复旧插件、撤销新插件，备份保留', t => {
  const o = fixture(t);
  install({ ...o, apply: true });
  const receipt = path.join(target(o), '.customization-state.json');
  const state = JSON.parse(fs.readFileSync(receipt)); state.host.version = '1.8.4'; fs.writeFileSync(receipt, JSON.stringify(state));
  const before = tree(path.join(o.runtime, 'plugins'));
  assert.throws(() => install({ ...o, ids: ['audiolibrary', 'github-releases', 'twitter-kol'], apply: true, beforePublish: (_name, index) => { if (index === 2) throw new Error('injected failure'); } }), /已恢复原插件状态/);
  assert.deepEqual(tree(path.join(o.runtime, 'plugins')), before);
  assert.equal(fs.existsSync(path.join(o.runtime, '.customizations-install.lock')), false);
  assert.ok(fs.readdirSync(o.backupRoot).length >= 2);
});

test('宿主不兼容、备份重叠、已有锁都停止，备份不写入安装目录', t => {
  const o = fixture(t);
  assert.throws(() => install({ ...o, backupRoot: path.join(o.runtime, 'backup') }), /备份目录/);
  fs.writeFileSync(path.join(o.hostPackage, 'package.json'), JSON.stringify({ name: '@jackwener/opencli', version: '3.0.0' }));
  assert.throws(() => install({ ...o, apply: true }), /宿主版本/);
  fs.writeFileSync(path.join(o.hostPackage, 'package.json'), JSON.stringify({ name: '@jackwener/opencli', version: '2.0.2' }));
  fs.mkdirSync(o.runtime);
  fs.writeFileSync(path.join(o.runtime, '.customizations-install.lock'), 'existing');
  const before = tree(o.root);
  assert.throws(() => install({ ...o, apply: true }), /EEXIST/);
  assert.deepEqual(tree(o.root), before);
});

test('CLI默认只读、错误退出码、预览未匹配为2、apply成功为0', t => {
  const o = fixture(t);
  const run = args => spawnSync(process.execPath, [path.join(REPO, 'scripts/manage.mjs'), ...args, '--runtime', o.runtime, '--host-package', o.hostPackage, '--backup-root', o.backupRoot], { encoding: 'utf8' });
  assert.equal(run(['check']).status, 2);
  assert.equal(fs.existsSync(o.runtime), false);
  assert.equal(run(['install', '--plugin', 'audiolibrary']).status, 2);
  assert.equal(run(['install', '--plugin', 'audiolibrary', '--apply']).status, 0);
  assert.equal(run(['check', '--plugin', 'audiolibrary']).status, 0);
  assert.equal(run(['check', '--apply']).status, 1);
});

test('1.x/2.x输出契约与分页：错误/未知格式不能伪装成功', () => {
  assert.deepEqual(unwrapResult({ ok: true, data: [1] }), [1]);
  assert.throws(() => unwrapResult({ ok: false, error: { code: 'EMPTY' } }), /失败/);
  assert.deepEqual(parseCommandPage([{ site: 'twitter', name: 'kol-tweets' }]), { commands: ['twitter/kol-tweets'], complete: true, nextOffset: undefined });
  assert.deepEqual(parseCommandPage({ ok: true, data: { commands: [{ command: 'youtube transcript' }], total: 30, nextOffset: 25 } }), { commands: ['youtube/transcript'], complete: false, nextOffset: 25 });
  assert.throws(() => parseCommandPage({ ok: true, data: {} }), /无法识别/);
  assert.throws(() => parseCommandPage([{ name: 'broken' }]), /命令字段/);
  assert.throws(() => parseCommandPage({ commands: [], nextOffset: -1 }), /nextOffset/);
  assert.equal(hostCompatibility('1.8.3').supported, false);
  assert.equal(hostCompatibility('2.0.2').supported, true);
  assert.equal(hostCompatibility('2.1.0').supported, false);
  assert.equal(hostCompatibility('2.0.3-rc.1').supported, false);
  assert.deepEqual(parseCommandPage({ ok: true, data: { commands: [{ command: 'list' }, { command: 'browser session list' }] } }).commands, ['list', 'browser/session/list']);
});

test('备份写入失败时未发布任何插件', t => {
  const o = fixture(t);
  fs.mkdirSync(o.backupRoot);
  // 模拟备份根变为文件：在任何插件变更前停止。
  const bad = path.join(o.backupRoot, 'not-directory');
  fs.writeFileSync(bad, 'keep');
  assert.throws(() => install({ ...o, backupRoot: bad, apply: true }), /不是目录/);
  assert.equal(fs.existsSync(o.runtime), false);
});

test('暂存根软链接拒绝写入，锁正常释放', t => {
  const o = fixture(t);
  fs.mkdirSync(o.runtime);
  const outside = path.join(o.root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep'), 'keep');
  fs.symlinkSync(outside, path.join(o.runtime, '.customizations-staging'));
  const before = tree(outside);
  assert.throws(() => install({ ...o, apply: true }), /路径包含软链接/);
  assert.deepEqual(tree(outside), before);
  assert.equal(fs.existsSync(path.join(o.runtime, '.customizations-install.lock')), false);
});

test('回滚本身失败保留锁、暂存和外置备份，不假装恢复成功', t => {
  const o = fixture(t);
  install({ ...o, apply: true });
  const statePath = path.join(target(o), '.customization-state.json');
  const state = JSON.parse(fs.readFileSync(statePath)); state.host.version = '1.8.4'; fs.writeFileSync(statePath, JSON.stringify(state));
  assert.throws(() => install({ ...o, ids: ['audiolibrary', 'github-releases'], apply: true, beforePublish: (_name, index) => {
    if (index !== 1) return;
    const workRoot = path.join(o.runtime, '.customizations-staging');
    const txn = fs.readdirSync(workRoot)[0];
    fs.rmSync(path.join(workRoot, txn, 'old-audiolibrary'), { recursive: true });
    throw new Error('injected rollback damage');
  } }), /回滚失败/);
  assert.equal(fs.existsSync(path.join(o.runtime, '.customizations-install.lock')), true);
  assert.ok(fs.readdirSync(path.join(o.runtime, '.customizations-staging')).length > 0);
  assert.ok(fs.readdirSync(o.backupRoot).length >= 2);
});
