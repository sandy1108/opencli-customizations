#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Skill附带的独立客户端；源文件在中央仓库，正式机不需要保留仓库。"""
from __future__ import annotations

import hashlib
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

SOURCE = 'https://github.com/sandy1108/opencli-customizations.git'
MINIMUM = {'twitter-kol': '0.1.0', 'github-releases': '0.1.0',
           'audiolibrary': '0.1.0', 'youtube-transcript': '0.1.3'}


def version_tuple(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d+\.\d+\.\d+', value):
        raise ValueError('只接受稳定版三段版本号')
    return tuple(map(int, value.split('.')))


def safe_directory(value):
    """检查路径祖先，不能先resolve而掩盖未知软链接。"""
    path = Path(os.path.abspath(Path(value).expanduser()))
    for part in [*reversed(path.parents), path]:
        if part.is_symlink() or (part.exists() and not part.is_dir()):
            raise ValueError('路径包含软链接或非目录：' + str(part))
    return path


def read_json(path):
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise ValueError('缺少普通JSON文件：' + str(path))
    return json.loads(path.read_text(encoding='utf-8'))


def find_host(explicit=None):
    value = explicit or shutil.which('opencli')
    if not value:
        raise ValueError('PATH中找不到OpenCLI；不会自动安装宿主')
    current = Path(value).expanduser().resolve()
    if not current.is_dir():
        current = current.parent
    for folder in [current, *current.parents]:
        package = folder / 'package.json'
        if package.is_file():
            data = read_json(package)
            if data.get('name') == '@jackwener/opencli':
                version = data.get('version')
                v = version_tuple(version)
                return {'path': str(folder), 'version': version,
                        'supported': (1, 8, 4) <= v < (2, 1, 0),
                        'moduleTested': version in ('1.8.4', '1.8.6', '2.0.2'),
                        'businessVerified': False}
        if explicit:
            break
    raise ValueError('找不到OpenCLI宿主包')


def inspect_installed(plugin, *, runtime=None, host_package=None):
    """离线对照安装收据，而不是对照最新远端源码；不证明来源可信或业务可用。"""
    if plugin not in MINIMUM:
        raise ValueError('未知插件：' + plugin)
    root = safe_directory(runtime or Path.home() / '.opencli')
    safe_directory(root / 'plugins')
    target = root / 'plugins' / plugin
    entry = {'plugin': plugin, 'target': str(target), 'status': 'missing'}
    report = {'mode': 'read-only', 'runtime': str(root), 'host': None, 'plugins': [entry],
              'evidence': 'installed-receipt-only', 'remoteChecked': False,
              'discovery': '未执行CLI；文件完整不代表命令可见或业务成功',
              'installation': {'approvalRequired': True, 'source': SOURCE,
                               'target': str(target), 'temporaryCheckout': True}}
    try:
        report['host'] = find_host(host_package)
    except (OSError, ValueError) as error:
        report['hostError'] = str(error)
    try:
        lock_file = root / 'plugins.lock.json'
        if lock_file.exists() or lock_file.is_symlink():
            lock = read_json(lock_file)
            if not isinstance(lock, dict) or plugin in lock:
                raise ValueError('原生lock格式异常或已管理此插件，不能混用管理器')
        if not target.exists() and not target.is_symlink():
            return report
        safe_directory(target)
        receipt = read_json(target / '.customization-state.json')
        if receipt.get('schema') != 1 or receipt.get('plugin') != plugin:
            raise ValueError('安装收据身份无效')
        expected = receipt.get('files')
        if not isinstance(expected, dict) or not expected:
            raise ValueError('安装收据文件清单无效')
        actual = {}
        for file in target.iterdir():
            if file.name in ('.customization-state.json', 'node_modules'):
                continue
            if file.is_symlink() or not file.is_file():
                raise ValueError('未知插件文件或目录：' + file.name)
            actual[file.name] = hashlib.sha256(file.read_bytes()).hexdigest()
        if actual != expected:
            raise ValueError('插件文件与安装收据不一致，拒绝覆盖')
        manifest = read_json(target / 'opencli-plugin.json')
        if manifest.get('name') != plugin or manifest.get('version') != receipt.get('version'):
            raise ValueError('插件manifest与收据不一致')
        entry['version'] = receipt['version']
        modules = safe_directory(target / 'node_modules')
        scope = safe_directory(modules / '@jackwener')
        if sorted(p.name for p in modules.iterdir()) != ['@jackwener'] or sorted(p.name for p in scope.iterdir()) != ['opencli']:
            raise ValueError('未知node_modules内容')
        link = scope / 'opencli'
        if not link.is_symlink():
            raise ValueError('宿主依赖不是软链接')
        linked = os.path.abspath(os.path.join(str(scope), os.readlink(link)))
        host = report['host'] or {}
        recorded_host = receipt.get('host')
        if not isinstance(recorded_host, dict):
            raise ValueError('收据宿主信息无效')
        if linked not in (recorded_host.get('path'), host.get('path')):
            raise ValueError('宿主依赖链接指向未知路径')
        if not host.get('supported'):
            entry['status'] = 'host-unsupported'
        elif linked != host['path'] or recorded_host.get('version') != host['version']:
            entry['status'] = 'host-relink'
        elif version_tuple(entry['version']) < version_tuple(MINIMUM[plugin]):
            entry['status'] = 'version-too-old'
        else:
            entry['status'] = 'matching'
    except (OSError, ValueError, TypeError, KeyError, AttributeError) as error:
        entry.update(status='conflict', reason=str(error))
    return report


def resolve_repo(value):
    """显式开发/隔离路径仍可用；故意不读取旧ROOT环境变量。"""
    if not value or not Path(value).expanduser().is_absolute():
        raise ValueError('--repo必须是显式绝对路径')
    root = Path(value).expanduser().resolve()
    manifest = read_json(root / 'opencli-plugin.json')
    if manifest.get('name') != 'opencli-customizations' or not (root / 'scripts/manage.mjs').is_file():
        raise ValueError('不是有效的opencli-customizations仓库')
    return root


def run_manager(repo, plugin, *, apply=False, runtime=None, host_package=None, backup_root=None):
    root = resolve_repo(repo)
    node = shutil.which('node')
    if not node:
        raise ValueError('PATH中没有Node，不自动安装')
    argv = [node, str(root / 'scripts/manage.mjs'), 'install' if apply else 'check', '--plugin', plugin]
    if apply:
        argv.append('--apply')
    for key, value in [('--runtime', runtime), ('--host-package', host_package), ('--backup-root', backup_root)]:
        if value is not None:
            argv.extend([key, str(value)])
    result = subprocess.run(argv, capture_output=True, text=True, encoding='utf-8', timeout=120)
    if result.returncode not in (0, 2):
        raise ValueError(result.stderr.strip() or result.stdout.strip() or '集中管理工具失败')
    report = json.loads(result.stdout)
    entries = report.get('pluginsAfter', report.get('plugins'))
    if not isinstance(entries, list) or len(entries) != 1 or entries[0].get('plugin') != plugin:
        raise ValueError('管理工具返回的插件身份不匹配')
    if apply and (result.returncode != 0 or entries[0].get('status') != 'matching'):
        raise ValueError('安装后状态不匹配')
    return report


def install_plugin(plugin, *, repo=None, allow_download=False, update=False, runtime=None,
                   host_package=None, backup_root=None):
    """仅在用户已明确同意后调用；程序不能代替Agent判断用户授权。"""
    options = dict(runtime=runtime, host_package=host_package, backup_root=backup_root)
    before = inspect_installed(plugin, runtime=runtime, host_package=host_package)
    status = before['plugins'][0]['status']
    if status == 'conflict':
        raise ValueError('发现未知修改/冲突，停止；不会下载或覆盖')
    if not (before.get('host') or {}).get('supported'):
        raise ValueError('OpenCLI宿主缺失或不兼容，停止；不会下载或升级宿主')
    if not update and status not in ('missing', 'matching'):
        raise ValueError('已有插件需要更新或重链接，须另获更新授权')
    if repo:
        preview = run_manager(repo, plugin, **options)
        if not update and preview['plugins'][0]['status'] not in ('missing', 'matching'):
            raise ValueError('本地候选不同或需修复；须另获更新授权')
        return run_manager(repo, plugin, apply=True, **options)
    if not allow_download:
        raise ValueError('下载与安装前必须取得用户同意；获准后显式传--allow-download')
    git = shutil.which('git')
    if not git:
        raise ValueError('找不到Git，不自动安装')
    # TemporaryDirectory覆盖成功、下载失败、超时和安装失败路径；只清理本次检出。
    with tempfile.TemporaryDirectory(prefix='opencli-customizations-') as temporary:
        root = Path(temporary).resolve() / 'repo'
        result = subprocess.run([git, 'clone', '--depth', '1', '--branch', 'master', '--', SOURCE, str(root)],
                                capture_output=True, text=True, encoding='utf-8', timeout=120)
        if result.returncode:
            raise ValueError('下载失败：' + result.stderr.strip())
        revision = subprocess.run([git, '-C', str(root), 'rev-parse', 'HEAD'], capture_output=True,
                                  text=True, encoding='utf-8', timeout=15)
        commit = revision.stdout.strip()
        if revision.returncode or not re.fullmatch('[0-9a-f]{40}', commit):
            raise ValueError('不能确认下载提交')
        preview = run_manager(root, plugin, **options)
        entry = preview['plugins'][0]
        if not update and entry['status'] not in ('missing', 'matching'):
            raise ValueError('远端版本不同或需修复；停止，需另获更新授权')
        report = run_manager(root, plugin, apply=True, **options)
        report['source'] = {'repository': SOURCE, 'commit': commit}
    report['temporaryCheckoutRemoved'] = True
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['check', 'install'])
    parser.add_argument('--plugin', required=True, choices=sorted(MINIMUM))
    parser.add_argument('--repo', help='仅安装时可选的显式本地源码路径')
    parser.add_argument('--allow-download', action='store_true', help='仅用户明确同意下载和安装后使用')
    parser.add_argument('--update', action='store_true', help='用户另行批准已有插件更新或重链接')
    parser.add_argument('--runtime')
    parser.add_argument('--host-package')
    parser.add_argument('--backup-root')
    args = parser.parse_args()
    if args.action == 'check' and (args.allow_download or args.update):
        parser.error('check不允许下载或更新')
    try:
        options = dict(runtime=args.runtime, host_package=args.host_package)
        if args.action == 'check':
            report = inspect_installed(args.plugin, **options)
        else:
            report = install_plugin(args.plugin, repo=args.repo, allow_download=args.allow_download,
                                    update=args.update, backup_root=args.backup_root, **options)
        print(json.dumps(report, ensure_ascii=False, indent=2))
        entry = report.get('pluginsAfter', report['plugins'])[0]
        return 0 if entry['status'] == 'matching' and (report.get('host') or {}).get('supported') else 2
    except (OSError, ValueError, TypeError, KeyError, subprocess.TimeoutExpired) as error:
        print(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=False))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
