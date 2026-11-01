# -*- coding: utf-8 -*-
"""无源码正式环境与用户授权边界；只使用临时目录，不联网。"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

REPO = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('runtime_client', REPO / 'scripts/runtime_client.py')
client = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client)


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='runtime-client-test-')
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        self.host = self.base / 'host with spaces'
        self.host.mkdir()
        (self.host / 'package.json').write_text('{"name":"@jackwener/opencli","version":"2.0.2"}')
        self.runtime = self.base / 'runtime'
        self.options = dict(runtime=self.runtime, host_package=self.host, backup_root=self.base / 'backups')
        self.repo = self.base / 'source'
        self.repo.mkdir()
        for name in ['scripts', 'plugins', 'sources.json', 'opencli-plugin.json']:
            source = REPO / name
            if source.is_dir():
                shutil.copytree(source, self.repo / name)
            else:
                shutil.copyfile(source, self.repo / name)

    def check(self):
        return client.inspect_installed('youtube-transcript', runtime=self.runtime, host_package=self.host)

    def install(self):
        return client.install_plugin('youtube-transcript', repo=self.repo, **self.options)

    def test_check_missing_never_downloads_or_creates_directories(self):
        with mock.patch.object(client.subprocess, 'run', side_effect=AssertionError('cannot execute')):
            report = self.check()
        self.assertEqual('missing', report['plugins'][0]['status'])
        self.assertTrue(report['installation']['approvalRequired'])
        self.assertFalse(self.runtime.exists())

    def test_install_without_download_consent_has_no_subprocess_or_writes(self):
        with mock.patch.object(client.subprocess, 'run', side_effect=AssertionError('cannot execute')):
            with self.assertRaisesRegex(ValueError, '用户同意'):
                client.install_plugin('youtube-transcript', **self.options)
        self.assertFalse(self.runtime.exists())

    def test_installed_snapshot_works_after_source_deleted_and_stale_env_ignored(self):
        self.install()
        shutil.rmtree(self.repo)
        with mock.patch.dict(os.environ, {'OPENCLI_CUSTOMIZATIONS_ROOT': '/nonexistent/old/source'}), mock.patch.object(client.subprocess, 'run', side_effect=AssertionError('cannot execute')):
            report = self.check()
        self.assertEqual('matching', report['plugins'][0]['status'])
        self.assertEqual('0.1.3', report['plugins'][0]['version'])
        self.assertFalse(report['remoteChecked'])

    def test_tampered_plugin_conflicts_before_download(self):
        self.install()
        (self.runtime / 'plugins/youtube-transcript/transcript.js').write_text('changed')
        with mock.patch.object(client.subprocess, 'run', side_effect=AssertionError('cannot execute')):
            with self.assertRaisesRegex(ValueError, '冲突'):
                client.install_plugin('youtube-transcript', allow_download=True, update=True, **self.options)
        self.assertEqual('conflict', self.check()['plugins'][0]['status'])

    def test_host_change_is_not_implicit_update(self):
        self.install()
        (self.host / 'package.json').write_text('{"name":"@jackwener/opencli","version":"2.0.1"}')
        self.assertEqual('host-relink', self.check()['plugins'][0]['status'])
        with self.assertRaisesRegex(ValueError, '更新授权'):
            self.install()
        self.assertEqual(['youtube-transcript'], client.install_plugin('youtube-transcript', repo=self.repo, update=True, **self.options)['changed'])
        self.assertEqual('matching', self.check()['plugins'][0]['status'])

    def test_minimum_version_is_checked_without_remote_fetch(self):
        self.install()
        with mock.patch.dict(client.MINIMUM, {'youtube-transcript': '0.1.4'}):
            self.assertEqual('version-too-old', self.check()['plugins'][0]['status'])

    def test_local_candidate_change_also_requires_update_consent(self):
        self.install()
        # README受安装哈希保护但不属于sources.json命令来源，可模拟已审候选变更。
        (self.repo / 'plugins/youtube-transcript/README.md').write_text('reviewed candidate')
        with self.assertRaisesRegex(ValueError, '更新授权'):
            self.install()
        self.assertEqual('matching', self.check()['plugins'][0]['status'])

    def test_unknown_host_link_is_conflict(self):
        self.install()
        link = self.runtime / 'plugins/youtube-transcript/node_modules/@jackwener/opencli'
        link.unlink()
        link.symlink_to(self.base / 'unknown')
        self.assertEqual('conflict', self.check()['plugins'][0]['status'])

    def test_extra_files_bad_receipts_and_native_lock_are_conflicts(self):
        self.install()
        target = self.runtime / 'plugins/youtube-transcript'
        receipt = target / '.customization-state.json'
        original = receipt.read_bytes()
        for value in ['{bad', '{}', '{"schema":1,"plugin":"other"}']:
            receipt.write_text(value)
            self.assertEqual('conflict', self.check()['plugins'][0]['status'])
        receipt.write_bytes(original)
        (target / 'extra.js').write_text('extra')
        self.assertEqual('conflict', self.check()['plugins'][0]['status'])
        (target / 'extra.js').unlink()
        (self.runtime / 'plugins.lock.json').write_text('{"youtube-transcript":{}}')
        self.assertEqual('conflict', self.check()['plugins'][0]['status'])

    def test_missing_host_is_reported_without_crash_or_download(self):
        (self.host / 'package.json').unlink()
        self.assertIn('hostError', self.check())
        with self.assertRaisesRegex(ValueError, '宿主'):
            client.install_plugin('youtube-transcript', allow_download=True, **self.options)

    def test_remote_success_and_each_failure_remove_temporary_checkout(self):
        real_run = subprocess.run
        for failure in [None, 'clone', 'timeout', 'revision', 'install']:
            with self.subTest(failure=failure):
                clone_paths = []
                runtime = self.base / ('remote-' + str(failure))
                def fake_run(argv, **kwargs):
                    if 'clone' in argv:
                        clone_paths.append(Path(argv[-1]))
                        shutil.copytree(self.repo, argv[-1])
                        if failure == 'timeout':
                            raise subprocess.TimeoutExpired(argv, 120)
                        return subprocess.CompletedProcess(argv, 1 if failure == 'clone' else 0, '', 'clone failed' if failure == 'clone' else '')
                    if 'rev-parse' in argv:
                        return subprocess.CompletedProcess(argv, 0, 'bad' if failure == 'revision' else 'a' * 40, '')
                    if failure == 'install' and '--apply' in argv:
                        return subprocess.CompletedProcess(argv, 1, '', 'install failed')
                    return real_run(argv, **kwargs)
                with mock.patch.object(client.subprocess, 'run', side_effect=fake_run):
                    if failure:
                        with self.assertRaises((ValueError, subprocess.TimeoutExpired)):
                            client.install_plugin('youtube-transcript', allow_download=True, runtime=runtime, host_package=self.host, backup_root=self.base / 'remote-backups')
                    else:
                        report = client.install_plugin('youtube-transcript', allow_download=True, runtime=runtime, host_package=self.host, backup_root=self.base / 'remote-backups')
                        self.assertTrue(report['temporaryCheckoutRemoved'])
                        self.assertEqual('a' * 40, report['source']['commit'])
                self.assertEqual(1, len(clone_paths))
                self.assertFalse(clone_paths[0].parent.exists())

    def test_unsupported_host_stops_before_download(self):
        (self.host / 'package.json').write_text('{"name":"@jackwener/opencli","version":"2.1.0"}')
        with mock.patch.object(client.subprocess, 'run', side_effect=AssertionError('cannot execute')):
            with self.assertRaisesRegex(ValueError, '宿主'):
                client.install_plugin('youtube-transcript', allow_download=True, **self.options)


if __name__ == '__main__':
    unittest.main()
