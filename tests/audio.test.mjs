// 来源：user-skills/audio-library-search/tests/adapter.test.mjs；仅调整仓库路径和宿主定位。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, cp, mkdir, symlink, rm, access, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { findHost } from '../scripts/manage.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
// 手写最小样本保留真实站点的标签结构，不保存网页里的动态下载参数。
function song(slug, title, genre = 'Hip Hop &amp; Rap', mood = 'Calm', license = 'Creative Commons — Attribution 3.0 Unported — CC BY 3.0') {
  return `<div itemscope itemtype="http://schema.org/MusicRecording">
    <a class="m-title__title" href="/artist/${slug}"><h2 itemprop="name">${title}</h2></a>
    <a itemprop="byArtist" href="/artist">A &amp; B</a>
    <a itemprop="genre" href="/genres/hip-hop-rap">${genre}</a>
    <a class="m-title__mood" href="/moods/${mood.toLowerCase()}">${mood}</a>
    <meta content="${title}, lofi" itemprop="keywords">
    <meta itemprop="license" content="Music: ${title} &lt;br&gt; License: ${license} &lt;br&gt;">
    <meta itemprop="url" content="https://www.youtube.com/watch?v=preview1234">
    <a aria-label="Go to Youtube's song" href="https://www.youtube.com/watch?v=original123">YouTube</a>
    <span data-download-gate="/download/DO-NOT-EXPORT" data-authors-link="https://soundcloud.com/artist/${slug}">Download</span>
  </div>`;
}
const page = (...records) => records.join('') + '<a href="?page=2">NEXT +</a>';
const response = (body, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html' } });

test('adapter: extraction, bounded search, failures and detail validation', async (t) => {
  await assert.doesNotReject(access(join(root, 'plugins/audiolibrary/core.mjs')), 'adapter implementation is missing');
  const packageRoot = process.env.AUDIOLIB_OPENCLI_PACKAGE || findHost().path;
  assert.ok(packageRoot, 'set AUDIOLIB_OPENCLI_PACKAGE to the installed OpenCLI package for integration tests');
  const sandbox = await mkdtemp(join(tmpdir(), 'audio-library-test-'));
  const oldFetch = globalThis.fetch;
  try {
    await cp(join(root, 'plugins/audiolibrary'), join(sandbox, 'audiolibrary'), { recursive: true });
    await writeFile(join(sandbox, 'package.json'), '{"type":"module"}\n');
    await mkdir(join(sandbox, 'node_modules/@jackwener'), { recursive: true });
    await symlink(resolve(packageRoot), join(sandbox, 'node_modules/@jackwener/opencli'), 'junction');
    const core = await import(pathToFileURL(join(sandbox, 'audiolibrary/core.mjs')).href);

    await t.test('decodes entities, separates preview from original, never exports a download gate', () => {
      const [row] = core.parseTracks(page(song('one', 'Night &#39;Walk&#39; &amp; Rain')), 'https://www.audiolibrary.com.co/moods/calm');
      assert.equal(row.title, "Night 'Walk' & Rain");
      assert.equal(row.artist, 'A & B');
      assert.equal(row.genre, 'Hip Hop & Rap');
      assert.equal(row.trackUrl, 'https://www.audiolibrary.com.co/artist/one');
      assert.equal(row.previewUrl, 'https://www.youtube.com/watch?v=preview1234');
      assert.equal(row.youtubeUrl, 'https://www.youtube.com/watch?v=original123');
      assert.match(row.licenseText, /\nLicense:/);
      assert.equal(row.licenseReview, 'attribution-required');
      assert.doesNotMatch(JSON.stringify(row), /DO-NOT-EXPORT/);
    });
    await t.test('flags ND and missing license instead of claiming editing permission', () => {
      const [nd, missing] = core.parseTracks(page(song('nd', 'ND', 'Cinematic', 'Calm', 'CC BY-ND 3.0'), song('missing', 'Unknown', 'Ambient', 'Calm', '')), 'https://www.audiolibrary.com.co/');
      assert.equal(nd.licenseReview, 'review-nd');
      assert.equal(missing.licenseReview, 'review-source-terms');
    });
    await t.test('rejects broken structure and ignores commented records', () => {
      assert.throws(() => core.parseTracks('<html>Challenge</html>', 'https://www.audiolibrary.com.co/'), { code: 'COMMAND_EXEC' });
      const rows = core.parseTracks(`<!-- ${song('fake', 'FAKE')} -->${song('real', 'REAL')}`, 'https://www.audiolibrary.com.co/');
      assert.deepEqual(rows.map(r => r.title), ['REAL']);
      assert.throws(() => core.parseTracks(song('broken', 'Broken').replace('itemprop="name"', 'itemprop="changed"'), 'https://www.audiolibrary.com.co/'), { code: 'COMMAND_EXEC' });
      assert.throws(() => core.parseTracks(song('broken', 'Broken', '', ''), 'https://www.audiolibrary.com.co/'), { code: 'COMMAND_EXEC' });
    });
    await t.test('parses category shape and rejects lookalike foreign hosts', () => {
      const html = '<a class="m-list-item" href="/genres/hip-hop-rap"><h2>Hip Hop &amp; Rap</h2></a>';
      assert.deepEqual(core.parseCategories(html, 'genres'), [{ kind: 'genres', slug: 'hip-hop-rap', name: 'Hip Hop & Rap', url: 'https://www.audiolibrary.com.co/genres/hip-hop-rap' }]);
      assert.throws(() => core.parseCategories('<a class="m-list-item" href="https://wwwXaudiolibraryXcomXco/genres/ambient"><h2>Fake</h2></a>', 'genres'), { code: 'COMMAND_EXEC' });
    });
    await t.test('filters BOTH mood and genre, keyword is local, scans only the budget', async () => {
      const fetched = [];
      globalThis.fetch = async (url) => {
        fetched.push(String(url));
        return response(fetched.length === 1 ? page(song('wrong', 'Rain', 'Pop', 'Happy')) : page(song('right', 'Rain Lofi')));
      };
      const rows = await core.searchTracks({ mood: 'calm', genre: 'hip-hop-rap', query: 'rain', pages: 2, limit: 3 });
      assert.deepEqual(rows.map(r => r.title), ['Rain Lofi']);
      assert.equal(rows[0].scannedPages, 2);
      assert.equal(rows[0].sourcePage, 'https://www.audiolibrary.com.co/moods/calm?page=2');
      assert.deepEqual(fetched, ['https://www.audiolibrary.com.co/moods/calm?page=1', 'https://www.audiolibrary.com.co/moods/calm?page=2']);
    });
    await t.test('deduplicates records and does not re-fetch exhausted pagination', async () => {
      let calls = 0;
      globalThis.fetch = async () => { calls++; return response(song('same', 'Same') + song('same', 'Same')); };
      const rows = await core.searchTracks({ pages: 3, limit: 10 });
      assert.equal(rows.length, 1);
      assert.equal(calls, 1);
    });
    await t.test('empty bounded search raises EmptyResultError with scanned scope', async () => {
      globalThis.fetch = async () => response(page(song('one', 'Sunny')));
      await assert.rejects(core.searchTracks({ query: 'unmatched', pages: 1 }), e => e.code === 'EMPTY_RESULT' && /1/.test(e.hint));
    });
    await t.test('bad args cause zero network requests', async () => {
      globalThis.fetch = async () => { assert.fail('invalid args must not fetch'); };
      for (const args of [{ pages: 4 }, { limit: 0 }, { page: 1.5 }, { mood: '../calm' }, { genre: 'fake-genre' }]) {
        await assert.rejects(core.searchTracks(args), { code: 'ARGUMENT' });
      }
      for (const url of ['https://evil.test/artist/song', '/download/artist/token', '/moods/calm', 'https://user:password@www.audiolibrary.com.co/artist/song', '/artist/song?secret=x']) {
        await assert.rejects(core.getTrack({ url }), { code: 'ARGUMENT' });
      }
    });
    await t.test('HTTP errors, timeout and markup drift are distinct errors', async () => {
      globalThis.fetch = async () => response('rate limited', 429);
      await assert.rejects(core.searchTracks({}), { code: 'COMMAND_EXEC' });
      globalThis.fetch = async () => { throw new DOMException('timed out', 'TimeoutError'); };
      await assert.rejects(core.searchTracks({}), { code: 'TIMEOUT' });
      globalThis.fetch = async () => response('<html>anti-bot</html>');
      await assert.rejects(core.searchTracks({}), { code: 'COMMAND_EXEC' });
    });
    await t.test('detail rejects a response for another song', async () => {
      globalThis.fetch = async () => response(song('two', 'Other'));
      await assert.rejects(core.getTrack({ url: '/artist/one' }), { code: 'COMMAND_EXEC' });
    });
    await t.test('actual OpenCLI definitions use public strategy and exact output columns', async () => {
      for (const name of ['search', 'categories', 'track']) await import(pathToFileURL(join(sandbox, `audiolibrary/${name}.js`)).href);
      const registry = await import(pathToFileURL(join(resolve(packageRoot), 'dist/src/registry-api.js')).href);
      globalThis.fetch = async (url) => response(String(url).endsWith('/genres') ? '<a class="m-list-item" href="/genres/ambient"><h2>Ambient</h2></a>' : song('one', 'ONE'));
      for (const [name, args] of [['search', {}], ['categories', { kind: 'genres' }], ['track', { url: '/artist/one' }]]) {
        const definition = registry.getRegistry().get(`audiolibrary/${name}`);
        assert.equal(definition.browser, false);
        assert.equal(definition.strategy, 'public');
        const rows = await definition.func(args);
        assert.deepEqual(Object.keys(rows[0]), definition.columns);
      }
    });
  } finally {
    globalThis.fetch = oldFetch;
    await rm(sandbox, { recursive: true, force: true });
  }
});
