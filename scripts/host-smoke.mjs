import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findHost, install, REPO } from './manage.mjs';

// 只复制宿主模块，依赖只读链接到已有安装；不运行宿主main/postinstall/daemon。
export function hostSmoke(hostPackage, dependencies) {
  const sandbox = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'opencli-host-smoke-'));
  try {
    const host = path.join(sandbox, 'host');
    fs.mkdirSync(host);
    fs.copyFileSync(path.join(hostPackage, 'package.json'), path.join(host, 'package.json'));
    fs.cpSync(path.join(hostPackage, 'dist'), path.join(host, 'dist'), { recursive: true });
    fs.symlinkSync(dependencies, path.join(host, 'node_modules'), 'dir');
    const runtime = path.join(sandbox, 'home/.opencli');
    install({ hostPackage: host, runtime, backupRoot: path.join(sandbox, 'backups'), ids: ['twitter-kol', 'github-releases', 'audiolibrary', 'youtube-transcript'], apply: true });
    const child = spawnSync(process.execPath, [path.join(REPO, 'tests/host-worker.mjs'), sandbox], { encoding: 'utf8', timeout: 30000 });
    if (child.status !== 0) throw new Error(`宿主隔离测试失败：${child.stderr || child.stdout}`);
    return JSON.parse(child.stdout);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    // 第一个位置参数为待测宿主包，可选第二参数为已经安装的node_modules目录。
    const installed = findHost();
    const host = process.argv[2] ? path.resolve(process.argv[2]) : installed.path;
    const dependencies = process.argv[3] ? path.resolve(process.argv[3]) : path.join(installed.path, 'node_modules');
    console.log(JSON.stringify(hostSmoke(host, dependencies), null, 2));
  } catch (error) { console.error(error.stack); process.exitCode = 1; }
}
