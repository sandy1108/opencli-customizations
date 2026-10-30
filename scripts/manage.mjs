import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { hostCompatibility, parseCommandPage } from './contracts.mjs';

export const REPO = fileURLToPath(new URL('../', import.meta.url));
const RECEIPT = '.customization-state.json';
const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const writeJson = (p, value) => fs.writeFileSync(p, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const sha = p => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const exists = p => Boolean(fs.lstatSync(p, { throwIfNoEntry: false }));
const within = (p, parent) => p === parent || p.startsWith(parent + path.sep);

// 禁止通过软链接祖先把安装、备份或回滚写入未预期的位置。
export function safePath(p) {
  p = path.resolve(p);
  let part = path.parse(p).root;
  for (const name of p.slice(part.length).split(path.sep).filter(Boolean)) {
    part = path.join(part, name);
    const stat = fs.lstatSync(part, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) throw new Error(`路径包含软链接：${part}`);
    if (stat && !stat.isDirectory()) throw new Error(`路径不是目录：${part}`);
  }
  return p;
}

function fileMap(dir, installed = false) {
  const files = {};
  for (const name of fs.readdirSync(dir).sort()) {
    if (installed && [RECEIPT, 'node_modules'].includes(name)) continue;
    const full = path.join(dir, name);
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error(`未知软链接：${full}`);
    if (stat.isDirectory()) throw new Error(`插件不应包含额外目录：${name}`);
    if (!stat.isFile()) throw new Error(`未知文件类型：${full}`);
    files[name] = sha(full);
  }
  return files;
}
const equalMaps = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

export function findHost(explicit) {
  const candidates = explicit ? [path.resolve(explicit)] : (process.env.PATH ?? '').split(path.delimiter).map(p => path.join(p, 'opencli'));
  for (const candidate of candidates) {
    if (!exists(candidate)) continue;
    let dir = fs.realpathSync(candidate);
    if (!fs.statSync(dir).isDirectory()) dir = path.dirname(dir);
    while (true) {
      const pkg = path.join(dir, 'package.json');
      if (fs.existsSync(pkg)) {
        const data = readJson(pkg);
        if (data.name === '@jackwener/opencli') return { path: dir, version: data.version, ...hostCompatibility(data.version) };
      }
      const parent = path.dirname(dir);
      if (parent === dir || explicit) break;
      dir = parent;
    }
  }
  throw new Error('找不到宿主OpenCLI包；请使用--host-package指定其package.json所在目录');
}

export function selectPlugins(ids, repo = REPO) {
  const manifest = readJson(path.join(repo, 'opencli-plugin.json'));
  const names = ids?.length ? ids : Object.keys(manifest.plugins);
  if (new Set(names).size !== names.length) throw new Error('插件选择重复');
  return names.map(name => {
    if (!Object.hasOwn(manifest.plugins, name) || !/^[a-z][a-z0-9-]+$/.test(name)) throw new Error(`未知插件：${name}`);
    const dir = path.resolve(repo, manifest.plugins[name].path);
    if (!within(dir, path.join(repo, 'plugins'))) throw new Error('源码目录越界');
    safePath(dir);
    const files = fileMap(dir);
    const local = readJson(path.join(dir, 'opencli-plugin.json'));
    if (local.name !== name) throw new Error('插件身份不一致');
    const provenance = readJson(path.join(repo, 'sources.json'));
    for (const source of provenance.files.filter(s => s.plugin === name)) {
      if (files[path.basename(source.file)] !== source.sha256) throw new Error(`源码哈希变化，请复核并更新sources.json：${source.file}`);
    }
    return { name, dir, files, version: local.version };
  });
}

// 只接受本工具生成且内容仍与收据一致的普通目录。原生软链接安装必须单独迁移。
function inspect(plugin, runtime, host) {
  const target = path.join(runtime, 'plugins', plugin.name);
  const lockFile = path.join(runtime, 'plugins.lock.json');
  try {
    if (exists(lockFile)) {
      const stat = fs.lstatSync(lockFile);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('原生插件lock不是普通文件');
      const lock = readJson(lockFile);
      if (!lock || typeof lock !== 'object' || Array.isArray(lock)) throw new Error('原生插件lock格式未知');
      if (Object.hasOwn(lock, plugin.name)) throw new Error('原生插件lock已管理此名称，须另行审批迁移');
    }
  } catch (error) { return { plugin: plugin.name, target, status: 'conflict', reason: error.message }; }
  if (!exists(target)) return { plugin: plugin.name, status: 'missing', target };
  try {
    safePath(target);
    const receiptPath = path.join(target, RECEIPT);
    const receiptStat = fs.lstatSync(receiptPath, { throwIfNoEntry: false });
    if (!receiptStat?.isFile() || receiptStat.isSymbolicLink()) throw new Error('没有本工具的普通文件安装收据');
    const receipt = readJson(receiptPath);
    if (receipt.schema !== 1 || receipt.plugin !== plugin.name || !receipt.files) throw new Error('收据身份无效');
    const files = fileMap(target, true);
    if (!equalMaps(files, receipt.files)) throw new Error('安装内容被修改或有额外文件');
    const modules = path.join(target, 'node_modules');
    const scope = path.join(modules, '@jackwener');
    safePath(scope);
    if (JSON.stringify(fs.readdirSync(modules)) !== '["@jackwener"]' || JSON.stringify(fs.readdirSync(scope)) !== '["opencli"]') throw new Error('未知node_modules内容');
    const link = path.join(scope, 'opencli');
    if (!fs.lstatSync(link).isSymbolicLink()) throw new Error('宿主依赖不是软链接');
    const linked = path.resolve(scope, fs.readlinkSync(link));
    if (linked !== receipt.host.path && linked !== host?.path) throw new Error('宿主链接被改为未知路径');
    const matches = equalMaps(files, plugin.files);
    return { plugin: plugin.name, target, status: !matches ? 'update-available' : linked !== host?.path || receipt.host.version !== host?.version ? 'host-relink' : 'matching' };
  } catch (error) {
    return { plugin: plugin.name, target, status: 'conflict', reason: error.message };
  }
}

export function check({ ids, runtime = path.join(os.homedir(), '.opencli'), hostPackage, repo = REPO } = {}) {
  runtime = safePath(runtime);
  safePath(path.join(runtime, 'plugins'));
  let host;
  let hostError;
  try { host = findHost(hostPackage); } catch (error) { hostError = error.message; }
  const plugins = selectPlugins(ids, repo);
  const sources = readJson(path.join(repo, 'sources.json')).files;
  const legacyOverrides = sources.filter(s => s.commands?.length && plugins.some(p => p.name === s.plugin)).map(source => {
    const [site] = source.commands[0].split('/');
    const file = path.join(runtime, 'clis', site, path.basename(source.file));
    try {
      const stat = fs.lstatSync(file, { throwIfNoEntry: false });
      if (!stat) return { plugin: source.plugin, file, status: 'missing' };
      // 不跟随未知clis祖先或文件软链接读取；未知内容只报告，不覆盖。
      safePath(path.dirname(file));
      if (!stat.isFile() || stat.isSymbolicLink()) return { plugin: source.plugin, file, status: 'conflict' };
      const hash = sha(file);
      return { plugin: source.plugin, file, sha256: hash, status: [source.sourceSha256, source.sha256].includes(hash) ? 'known-source' : 'different' };
    } catch (error) { return { plugin: source.plugin, file, status: 'conflict', reason: error.message }; }
  });
  return { mode: 'read-only', runtime, host, hostError, plugins: plugins.map(p => inspect(p, runtime, host)), legacyOverrides, discovery: '未调用宿主；文件存在不等于已加载，需S3真实验收' };
}

// 完整预检后再写入；备份在plugins/clis之外，事务中旧目录保留用于失败恢复。
// beforePublish仅供临时目录测试注入故障，CLI不暴露该入口。
export function install(options = {}) {
  if (!options.ids?.length) throw new Error('安装必须显式选择--plugin；不会隐式全装');
  const report = check(options);
  const { runtime, host } = report;
  if (!host?.supported) throw new Error(report.hostError ?? `宿主版本不在声明范围：${host?.version}`);
  if (report.plugins.some(p => p.status === 'conflict')) throw new Error(`发现冲突，拒绝覆盖：${JSON.stringify(report.plugins)}`);
  const backupRoot = safePath(options.backupRoot ?? path.join(os.homedir(), '.local/share/opencli-customizations/backups'));
  if (within(backupRoot, runtime) || within(runtime, backupRoot) || within(backupRoot, options.repo ?? REPO)) throw new Error('备份目录必须独立于运行目录和源码仓库');
  report.backupRoot = backupRoot;
  report.mode = options.apply ? 'apply' : 'preview';
  if (!options.apply) return report;
  const pending = report.plugins.filter(p => p.status !== 'matching');
  if (!pending.length) return { ...report, changed: [], backup: null };
  fs.mkdirSync(runtime, { recursive: true });
  const lockPath = path.join(runtime, '.customizations-install.lock');
  // 不自动清理现有锁：上次崩溃或另一安装进程须人工核实。
  const lock = fs.openSync(lockPath, 'wx', 0o600);
  const txn = randomUUID();
  const work = path.join(runtime, '.customizations-staging', txn);
  const backup = path.join(backupRoot, txn);
  const published = [];
  const moved = [];
  let rollbackFailed = false;
  let workCreated = false;
  try {
    // 锁内重查，防止另一个合作进程在预览后已经改变目录。
    const fresh = check(options);
    if (JSON.stringify(fresh.plugins) !== JSON.stringify(report.plugins)) throw new Error('安装状态已变化，请重新预览');
    safePath(path.dirname(work));
    fs.mkdirSync(work, { recursive: true });
    workCreated = true;
    fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(runtime, 'plugins'), { recursive: true });
    const plugins = selectPlugins(options.ids, options.repo);
    for (const entry of pending) {
      const plugin = plugins.find(p => p.name === entry.plugin);
      const stage = path.join(work, plugin.name);
      fs.cpSync(plugin.dir, stage, { recursive: true, dereference: false });
      if (!equalMaps(fileMap(stage), plugin.files)) throw new Error('暂存源码校验失败');
      fs.mkdirSync(path.join(stage, 'node_modules/@jackwener'), { recursive: true });
      fs.symlinkSync(host.path, path.join(stage, 'node_modules/@jackwener/opencli'), 'dir');
      writeJson(path.join(stage, RECEIPT), { schema: 1, plugin: plugin.name, version: plugin.version, files: plugin.files, host: { path: host.path, version: host.version }, transaction: txn });
      if (entry.status !== 'missing') {
        const snapshot = path.join(backup, plugin.name);
        fs.cpSync(entry.target, snapshot, { recursive: true, dereference: false, verbatimSymlinks: true });
        if (!equalMaps(fileMap(snapshot, true), fileMap(entry.target, true)) || sha(path.join(snapshot, RECEIPT)) !== sha(path.join(entry.target, RECEIPT))) throw new Error('外置备份校验失败');
      }
    }
    writeJson(path.join(backup, 'transaction.json'), { schema: 1, transaction: txn, runtime, host, entries: pending, state: 'prepared' });
    for (const entry of pending) {
      options.beforePublish?.(entry.plugin, published.length);
      if (entry.status !== 'missing') {
        fs.renameSync(entry.target, path.join(work, 'old-' + entry.plugin));
        moved.push(entry);
      }
      fs.renameSync(path.join(work, entry.plugin), entry.target);
      published.push(entry);
    }
    const pluginsAfter = check(options).plugins;
    if (pluginsAfter.some(p => p.status !== 'matching')) throw new Error('发布后检查未匹配');
    writeJson(path.join(backup, 'completed.json'), { transaction: txn, changed: published.map(e => e.plugin) });
    return { ...report, pluginsAfter, changed: published.map(e => e.plugin), backup };
  } catch (error) {
    try {
      for (const entry of published.reverse()) fs.rmSync(entry.target, { recursive: true, force: true });
      for (const entry of moved.reverse()) fs.renameSync(path.join(work, 'old-' + entry.plugin), entry.target);
    } catch (restoreError) {
      rollbackFailed = true;
      throw new AggregateError([error, restoreError], `回滚失败；保留锁和暂存${work}，备份${backup}，停止操作`);
    }
    throw new Error(`安装失败，已恢复原插件状态；备份（若已创建）${backup}；原因：${error.message}`, { cause: error });
  } finally {
    fs.closeSync(lock);
    if (!rollbackFailed) {
      if (workCreated) fs.rmSync(work, { recursive: true, force: true });
      fs.unlinkSync(lockPath);
    }
  }
}

export function main(argv = process.argv.slice(2)) {
  const action = argv.shift() ?? 'check';
  if (action === '--help' || action === 'help') {
    console.log('node scripts/manage.mjs [check|install] [--plugin NAME ...] [--runtime DIR] [--host-package DIR] [--backup-root DIR] [--apply] [--list-json FILE]\ncheck默认只读；install默认预览；--apply显式执行；定向安装必须--plugin。');
    return;
  }
  if (!['check', 'install'].includes(action)) throw new Error(`未知操作：${action}`);
  const options = { ids: [] };
  let listFile;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--apply') { options.apply = true; continue; }
    if (!['--plugin', '--runtime', '--host-package', '--backup-root', '--list-json'].includes(flag) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`无效参数：${flag}`);
    const value = argv[++i];
    if (flag === '--plugin') options.ids.push(value);
    else if (flag === '--list-json') listFile = value;
    else options[{ '--runtime': 'runtime', '--host-package': 'hostPackage', '--backup-root': 'backupRoot' }[flag]] = value;
  }
  if (action === 'check' && options.apply) throw new Error('check不允许--apply');
  if (action === 'install' && listFile) throw new Error('install不接受--list-json');
  const result = action === 'check' ? check(options) : install(options);
  if (listFile) {
    const page = parseCommandPage(readJson(listFile));
    const sources = readJson(path.join(REPO, 'sources.json'));
    const required = [...new Set(sources.files.filter(s => result.plugins.some(p => p.plugin === s.plugin)).flatMap(s => s.commands ?? []))];
    result.discovery = { ...page, missing: required.filter(c => !page.commands.includes(c)), note: '仅依据提供的list快照；不能证明同名命令来自哪个文件' };
  }
  console.log(JSON.stringify(result, null, 2));
  if (result.hostError || result.host?.supported === false || result.plugins.some(p => p.status !== 'matching')) process.exitCode = 2;
  if (listFile && (!result.discovery.complete || result.discovery.missing.length)) process.exitCode = 2;
  // 安装成功后报告的plugins为安装前状态，用changed标明结果。
  if (action === 'install' && options.apply) process.exitCode = 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; }
}
