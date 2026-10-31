import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, cp, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findHost } from '../scripts/manage.mjs';

// 调用真实注册函数；页面响应桩只复现失败路径，不执行网页代码或联网。
const installedHost = resolve(findHost().path);
const hosts = JSON.parse(process.env.OPENCLI_TEST_HOSTS || JSON.stringify([installedHost]));
for (const candidate of hosts) test(`youtube: ${candidate} DOM/auto/api typed diagnostics`, async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), 'youtube-regression-'));
  try {
    const host = join(sandbox, 'host');
    await mkdir(host);
    await cp(join(candidate, 'dist'), join(host, 'dist'), { recursive: true });
    await cp(join(candidate, 'package.json'), join(host, 'package.json'));
    await symlink(join(installedHost, 'node_modules'), join(host, 'node_modules'), 'junction');
    await cp(new URL('../plugins/youtube-transcript/', import.meta.url), join(sandbox, 'plugin'), { recursive: true });
    await mkdir(join(sandbox, 'node_modules/@jackwener'), { recursive: true });
    await symlink(host, join(sandbox, 'node_modules/@jackwener/opencli'), 'junction');
    await import(pathToFileURL(join(sandbox, 'plugin/transcript.js')).href);
    const { getRegistry } = await import(pathToFileURL(join(host, 'dist/src/registry-api.js')).href);
    const command = getRegistry().get('youtube/transcript');
    for (const source of ['dom', 'auto', 'api']) {
      await t.test(source, async () => {
        const page = {
          goto: async () => {}, wait: async () => {},
          evaluate: async code => {
            if (code.includes('location.reload()')) return 'reloading';
            if (code.includes('document.visibilityState')) return 'visible';
            if (code.includes('const targetVideoId')) return { empty: false, attempts: 0, emptyBodies: 0 };
            return { error: '字幕诊断桩：提取失败', debug: {} };
          },
        };
        await assert.rejects(command.func(page, { url: 'Z_Foiw4UTPk', source, mode: 'raw' }), error => {
          assert.equal(error.code, 'COMMAND_EXEC', `${error.name}: ${error.message}`);
          assert.match(error.message, /字幕诊断桩：提取失败/);
          assert.doesNotMatch(error.message, /not defined|低信任文档/);
          return true;
        });
      });
    }
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

for (const candidate of hosts) test(`youtube: ${candidate} DOM falls back to current-video timedtext`, async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'youtube-dom-network-fallback-'));
  try {
    const host = join(sandbox, 'host');
    await mkdir(host);
    await cp(join(candidate, 'dist'), join(host, 'dist'), { recursive: true });
    await cp(join(candidate, 'package.json'), join(host, 'package.json'));
    await symlink(join(installedHost, 'node_modules'), join(host, 'node_modules'), 'junction');
    await cp(new URL('../plugins/youtube-transcript/', import.meta.url), join(sandbox, 'plugin'), { recursive: true });
    await mkdir(join(sandbox, 'node_modules/@jackwener'), { recursive: true });
    await symlink(host, join(sandbox, 'node_modules/@jackwener/opencli'), 'junction');
    await import(`${pathToFileURL(join(sandbox, 'plugin/transcript.js')).href}?fallback`);
    const { getRegistry } = await import(pathToFileURL(join(host, 'dist/src/registry-api.js')).href);
    const command = getRegistry().get('youtube/transcript');

    const videoId = 'Z_Foiw4UTPk';
    const json3 = JSON.stringify({ events: [{ tStartMs: 1000, dDurationMs: 1500, segs: [{ utf8: '当前视频中文字幕' }] }] });
    const oldSameVideoJson3 = JSON.stringify({ events: [{ tStartMs: 1000, dDurationMs: 1500, segs: [{ utf8: '上一次捕获的旧结果' }] }] });
    let captureReadCount = 0;
    const captureReadOptions = [];
    let visibilityChecks = 0;
    const page = {
      captureFilter: null,
      playerFallbackRequested: false,
      startNetworkCapture: async filter => { page.captureFilter = filter; },
      readNetworkCapture: async options => {
        captureReadCount++;
        captureReadOptions.push(options);
        if (captureReadCount === 1) {
          return [{ url: `https://www.youtube.com/api/timedtext?fmt=json3&pot=stale&v=${videoId}&lang=zh-CN`, responsePreview: oldSameVideoJson3 }];
        }
        if (captureReadCount === 2) return [];
        const capturedAt = Date.now();
        return [
          { timestamp: capturedAt, captureComplete: true, url: 'https://www.youtube.com/api/timedtext?fmt=json3&pot=old&v=PREVIOUS_VIDEO&lang=zh-CN', responsePreview: json3 },
          { timestamp: capturedAt, captureComplete: true, url: `https://www.youtube.com/api/timedtext?fmt=json3&pot=translated&v=${videoId}&lang=zh-CN&tlang=en`, responsePreview: json3 },
          { timestamp: capturedAt, captureComplete: true, url: `https://www.youtube.com/api/timedtext?fmt=json3&pot=wrong-language&v=${videoId}&lang=en`, responsePreview: json3 },
          { timestamp: capturedAt, captureComplete: true, url: `https://www.youtube.com/api/timedtext?fmt=json3&pot=current&v=${videoId}&lang=zh-CN`, responsePreview: json3 },
          { timestamp: capturedAt - 10000, captureComplete: true, url: `https://www.youtube.com/api/timedtext?fmt=json3&pot=old-same-video&v=${videoId}&lang=zh-CN`, responsePreview: oldSameVideoJson3 },
          { timestamp: capturedAt, captureComplete: false, url: `https://www.youtube.com/api/timedtext?fmt=json3&pot=pending&v=${videoId}&lang=zh-CN`, responsePreview: oldSameVideoJson3 },
        ];
      },
      goto: async () => {},
      wait: async () => {},
      evaluate: async code => {
        if (code.includes('location.reload()')) return 'reloading';
        if (code.includes('document.visibilityState')) {
          visibilityChecks++;
          return 'visible';
        }
        if (code.includes('function getPanel()')) {
          assert.ok(visibilityChecks >= 2, 'DOM轮询前应确认页面可见');
          return { error: '面板没有字幕段', debug: {} };
        }
        if (code.includes('targetVideoId')) {
          assert.doesNotThrow(() => new Function(`return ${code}`));
          page.playerFallbackRequested = true;
          return { requested: true };
        }
        return null;
      },
    };

    const result = await command.func(page, { url: videoId, source: 'dom', lang: 'zh', mode: 'raw' });
    assert.equal(page.captureFilter, '/api/timedtext');
    assert.equal(captureReadCount, 3);
    assert.deepEqual(captureReadOptions[1], { retainIncomplete: true });
    assert.deepEqual(captureReadOptions[2], { retainIncomplete: true });
    assert.equal(page.playerFallbackRequested, true);
    assert.deepEqual(result, [{ index: 1, start: '1.00s', end: '2.50s', text: '当前视频中文字幕' }]);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

for (const candidate of hosts) test(`youtube: ${candidate} auto retains DOM result when requested language is unverified`, async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'youtube-dom-language-unknown-'));
  try {
    const host = join(sandbox, 'host');
    await mkdir(host);
    await cp(join(candidate, 'dist'), join(host, 'dist'), { recursive: true });
    await cp(join(candidate, 'package.json'), join(host, 'package.json'));
    await symlink(join(installedHost, 'node_modules'), join(host, 'node_modules'), 'junction');
    await cp(new URL('../plugins/youtube-transcript/', import.meta.url), join(sandbox, 'plugin'), { recursive: true });
    await mkdir(join(sandbox, 'node_modules/@jackwener'), { recursive: true });
    await symlink(host, join(sandbox, 'node_modules/@jackwener/opencli'), 'junction');
    await import(`${pathToFileURL(join(sandbox, 'plugin/transcript.js')).href}?unknown-language`);
    const { getRegistry } = await import(pathToFileURL(join(host, 'dist/src/registry-api.js')).href);
    const command = getRegistry().get('youtube/transcript');

    let domAttempts = 0;
    const page = {
      goto: async () => {},
      wait: async () => {},
      evaluate: async code => {
        if (code.includes('document.visibilityState')) return 'visible';
        if (code.includes('location.reload()')) return 'reloading';
        if (code.includes('targetVideoId')) return null;
        if (code.includes('extractJsonAssignmentFromHtml')) return { error: 'No captions available for this video' };
        if (code.includes('function getPanel()')) {
          domAttempts++;
          return { rows: [{ start: 1, end: 2, text: '测试段落' }], language: null, source: 'dom' };
        }
        return null;
      },
    };
    const diagnostics = [];
    const originalConsoleError = console.error;
    console.error = (...args) => diagnostics.push(args.map(String).join(' '));
    let result;
    try {
      result = await command.func(page, { url: 'Z_Foiw4UTPk', source: 'auto', lang: 'zh', mode: 'raw' });
    }
    finally {
      console.error = originalConsoleError;
    }

    assert.equal(domAttempts, 1, 'auto should reach DOM after language-aware paths return no segments');
    assert.equal(result.length, 1, 'nonempty DOM output should not be discarded because its language is unknown');
    assert.equal(result[0].text, '测试段落');
    assert.ok(
      diagnostics.some(message => message.includes('source=dom') && message.includes('language=unverified') && message.includes('requested=zh')),
      'DOM result should clearly report that the requested language was not verified',
    );
  }
  finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
