// 基于OpenCLI 1.8.6（Apache-2.0）的自定义字幕实现。
// 2026-10-30迁移：相对辅助模块改为.mjs，更新恢复说明；业务逻辑保持原样。
/**
 * YouTube transcript — extracts caption tracks through the watch player.
 *
 * YouTube timedtext URLs can require player-generated PO tokens. Load the
 * watch page, ask the player captions module to select a track, then reuse the
 * generated json3 timedtext URL before falling back to watch HTML captions.
 *
 * Modes:
 *   --mode grouped (default): sentences merged, speaker detection, chapters
 *   --mode raw: every caption segment as-is with precise timestamps
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { extractJsonAssignmentFromHtml, parseVideoId, prepareYoutubeApiPage } from './utils.mjs';
import { groupTranscriptSegments, formatGroupedTranscript, } from './transcript-group.mjs';
import { CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';

// WEB_CLIPPING_YOUTUBE_PATCH v1
// 这是 web-clipping 技能维护的 YouTube 字幕补丁（基于 opencli 1.8.6 官方 adapter）。
// 主要修复：
//   1. 中文语言码不统一：zh / zh-CN / zh-SG / zh-Hans / zh-TW / zh-HK / zh-Hant / yue
//   2. 网络抓包会把 lang=zh-CN&tlang=en 这类自动翻译轨误当成原字幕
//   3. 播放器/API 路径都拿不到字幕时，没有“转写文稿”DOM 面板兜底
//   4. 同标签页导航产生的 watch 文档处于低信任态：播放器拿到的 timedtext 是
//      0 字节（pot=103），转写面板触发的 get_transcript 返回 400。进入提取前
//      用 location.reload() 重建文档规避；播放器只看到空响应时 reload 重试一次
//   5. 标签页 hidden 时 YouTube 不发起任何字幕请求，先尝试激活标签页
// 已迁为独立plugin；adapter reset youtube不会卸载本插件。恢复操作见docs/installation.md。

function normalizeLangCode(code) {
    return String(code || '').trim().toLowerCase().replace(/_/g, '-');
}

// 展开 --lang（支持逗号分隔），生成按优先级排列的候选语言码。
// 中文请求默认“简体优先、繁体兜底”，避免 zh-Hans 精确匹配不到 zh-CN 轨。
function expandLangPreferences(input) {
    const tokens = String(input || '').split(',').map(normalizeLangCode).filter(Boolean);
    if (tokens.length === 0)
        return [];
    const preferences = [];
    const add = (code) => {
        if (code && !preferences.includes(code))
            preferences.push(code);
    };
    for (const token of tokens) {
        if (token === 'zh' || token === 'zh-hans' || token === 'zh-cn' || token === 'zh-sg' || token.startsWith('zh-cn-')) {
            ['zh-hans', 'zh-cn', 'zh-sg', 'zh', 'zh-hant', 'zh-tw', 'zh-hk', 'zh-mo'].forEach(add);
        }
        else if (token === 'zh-hant' || token === 'zh-tw' || token === 'zh-hk' || token === 'zh-mo') {
            ['zh-hant', 'zh-tw', 'zh-hk', 'zh-mo', 'zh', 'zh-hans', 'zh-cn', 'zh-sg'].forEach(add);
        }
        else if (token === 'yue' || token === 'zh-yue' || token === 'cantonese') {
            ['yue', 'zh-yue', 'zh-hk', 'zh-hant', 'zh', 'zh-tw', 'zh-mo', 'zh-hans', 'zh-cn'].forEach(add);
        }
        else {
            add(token);
            add(token.split('-')[0]);
        }
    }
    return preferences;
}

// 字幕轨语言码是否满足某个候选语言：精确匹配，或候选语言是轨道语言的主语言
// （en 命中 en-US；zh 命中 zh-Hant）。反向不匹配，避免 zh-Hant 被泛化 zh 抢走。
function langCodeMatches(code, preference) {
    const normalized = normalizeLangCode(code);
    const wanted = normalizeLangCode(preference);
    if (!normalized || !wanted)
        return false;
    if (normalized === wanted)
        return true;
    return normalized.startsWith(wanted + '-');
}

function unwrapBrowserResult(value) {
    if (value && typeof value === 'object' && 'session' in value && 'data' in value) {
        return value.data;
    }
    return value;
}

function normalizeSegmentsPayload(value, source, { allowNull = false } = {}) {
    const payload = unwrapBrowserResult(value);
    if (payload == null && allowNull)
        return null;
    if (Array.isArray(payload))
        return payload;
    if (payload && typeof payload === 'object' && payload.error) {
        throw new CommandExecutionError(String(payload.error));
    }
    throw new CommandExecutionError(`Malformed ${source} payload`);
}

// 文档重建后的静置时间（秒）：等待 watch 页面和播放器重新初始化。
const RELOAD_SETTLE_SECONDS = 3;

// 同标签页导航产生的 watch 文档处于低信任态，播放器 mint 出的 timedtext 只有
// 0 字节、页面自身的 get_transcript 返回 400。实测 location.reload() 能重建
// 文档并恢复（2026-10-29 A/B：导航后 pot=103/0B，reload 后 pot=120 有数据）。
// opencli 1.8.6 的浏览器桥白名单拒绝 CDP Page.reload，只能用页面内 reload。
async function reloadWatchDocument(page) {
    try {
        await page.evaluate(`location.reload(); 'reloading'`);
    }
    catch {
        // 导航会中断本次 evaluate，属于预期行为；新文档已经在加载。
    }
    await page.wait(RELOAD_SETTLE_SECONDS);
}

// hidden 文档里播放器不会发起字幕请求（实测连 CC/转写点击都不产生网络请求）。
// 尝试把当前标签页切为激活态，失败时由调用方决定是否继续。
async function ensurePageVisible(page) {
    const readVisibility = async () => {
        try {
            return String(unwrapBrowserResult(await page.evaluate('document.visibilityState')) || '');
        }
        catch {
            return '';
        }
    };
    if ((await readVisibility()) === 'visible')
        return true;
    try {
        if (typeof page.getActivePage === 'function' && typeof page.selectTab === 'function') {
            await page.selectTab(page.getActivePage());
            await page.wait(1);
        }
    }
    catch {
        // 激活失败不阻断主流程
    }
    return (await readVisibility()) === 'visible';
}

function parseJson3Segments(text) {
    let data;
    try {
        data = JSON.parse(text);
    }
    catch (err) {
        throw new CommandExecutionError(`Malformed json3 timedtext response: ${err?.message || err}`);
    }
    if (!Array.isArray(data?.events)) {
        throw new CommandExecutionError('Malformed json3 timedtext response: missing events array');
    }
    const rows = [];
    for (const event of data.events) {
        const startMs = Number(event?.tStartMs || 0);
        const durMs = Number(event?.dDurationMs || 0);
        const segs = Array.isArray(event?.segs) ? event.segs : [];
        const line = segs.map(seg => seg?.utf8 || '').join('').replace(/\s+/g, ' ').trim();
        if (!line)
            continue;
        rows.push({
            start: startMs / 1000,
            end: (startMs + durMs) / 1000,
            text: line,
        });
    }
    return rows;
}

function timedtextUrlMatchesVideo(url, videoId) {
    if (!videoId)
        return true;
    try {
        const parsed = new URL(url);
        return parsed.searchParams.get('v') === videoId;
    }
    catch {
        return false;
    }
}

function extractSegmentsFromNetworkCapture(entries, langPreferences, videoId, minTimestamp = null) {
    const payload = unwrapBrowserResult(entries);
    if (!Array.isArray(payload) || payload.length === 0)
        return { segments: [] };
    const preferences = Array.isArray(langPreferences) ? langPreferences : [];
    const candidates = [];
    for (const entry of payload) {
        const timestamp = Number(entry?.timestamp);
        if (entry?.captureComplete === false)
            continue;
        if (Number.isFinite(minTimestamp) && Number.isFinite(timestamp) && timestamp < minTimestamp)
            continue;
        const url = String(entry?.url || '');
        if (!url.includes('/api/timedtext'))
            continue;
        if (!url.includes('fmt=json3') || !url.includes('pot='))
            continue;
        // Scope to the current video — daemon-shared tabs can retain captured
        // timedtext entries from prior YouTube SPA navigations that match
        // the same lang. Use exact query-param equality rather than substring
        // matching so v=<prefix> cannot match v=<prefix><suffix>.
        if (!timedtextUrlMatchesVideo(url, videoId))
            continue;
        let parsedUrl;
        try {
            parsedUrl = new URL(url);
        }
        catch {
            continue;
        }
        // tlang 是自动翻译轨：lang=zh-CN&tlang=en 返回的是英文，不能当原字幕用。
        if (parsedUrl.searchParams.get('tlang'))
            continue;
        const language = normalizeLangCode(parsedUrl.searchParams.get('lang'));
        let rank = 0;
        if (preferences.length > 0) {
            rank = preferences.findIndex(preference => langCodeMatches(language, preference));
            if (rank === -1)
                continue;
        }
        candidates.push({ entry, language, rank });
    }
    // 同一优先级里优先使用最近一次抓包。
    candidates.reverse();
    candidates.sort((a, b) => a.rank - b.rank);
    let malformed = '';
    for (const { entry, language } of candidates) {
        const body = typeof entry?.responsePreview === 'string' ? entry.responsePreview : '';
        if (!body)
            continue;
        try {
            const parsed = parseJson3Segments(body);
            if (parsed.length > 0)
                return { segments: parsed, language };
        }
        catch (err) {
            malformed = err?.message || String(err);
        }
    }
    return malformed ? { error: malformed } : { segments: [] };
}

// DOM面板无段落时，要求当前播放器发出所选语言的timedtext请求，再由宿主网络捕获器读取响应。
function createPlayerTimedtextRequestScript(videoId, langPreferences) {
    return `(async () => {
  const targetVideoId = ${JSON.stringify(videoId)};
  const langPrefs = ${JSON.stringify(langPreferences)};
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const normalize = code => String(code || '').trim().toLowerCase().replace(/_/g, '-');
  const matches = (code, preference) => {
    const actual = normalize(code);
    const wanted = normalize(preference);
    return !!actual && !!wanted && (actual === wanted || actual.startsWith(wanted + '-'));
  };
  const player = document.getElementById('movie_player');
  if (!player?.getOption || !player?.setOption) return { requested: false };

  const toPlayerTrack = track => {
    if (!track?.languageCode) return null;
    const name = track.name?.simpleText
      || (Array.isArray(track.name?.runs) ? track.name.runs.map(run => run?.text || '').join('') : '')
      || track.languageCode;
    return {
      displayName: name,
      id: null,
      is_default: false,
      is_servable: false,
      is_translateable: !!track.isTranslatable,
      kind: track.kind || '',
      languageCode: track.languageCode,
      languageName: name,
      name: '',
      vss_id: track.vssId || ((track.kind === 'asr' ? 'a.' : '.') + track.languageCode),
    };
  };
  const available = player.getOption('captions', 'tracklist');
  const captionTracks = player.getPlayerResponse?.()
    ?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  const tracks = Array.isArray(available) && available.length
    ? available
    : (Array.isArray(captionTracks) ? captionTracks.map(toPlayerTrack).filter(Boolean) : []);
  if (!tracks.length) return { requested: false };

  let track = null;
  const preferManual = candidates => candidates.find(item => item?.kind !== 'asr') || candidates[0];
  for (const preference of langPrefs) {
    track = preferManual(tracks.filter(item => matches(item?.languageCode, preference)));
    if (track) break;
  }
  if (!track && langPrefs.length) return { requested: false };
  if (!track) {
    track = tracks.find(item => normalize(item.languageCode) === 'en' && item.kind !== 'asr')
      || tracks.find(item => normalize(item.languageCode).startsWith('en') && item.kind !== 'asr')
      || tracks.find(item => item.kind !== 'asr')
      || tracks[0];
  }

  const isCurrentTimedtext = rawUrl => {
    try {
      const url = new URL(rawUrl, location.origin);
      const language = normalize(url.searchParams.get('lang'));
      return url.pathname.includes('/api/timedtext')
        && url.searchParams.get('v') === targetVideoId
        && url.searchParams.get('fmt') === 'json3'
        && !!url.searchParams.get('pot')
        && !url.searchParams.get('tlang')
        && (!langPrefs.length || langPrefs.some(preference => matches(language, preference)))
        && (!track?.languageCode || matches(language, track.languageCode) || matches(track.languageCode, language));
    } catch {
      return false;
    }
  };

  try {
    try { player.loadModule?.('captions'); } catch {}
    await sleep(500);
    const selectedTrack = { ...track };
    delete selectedTrack.translationLanguage;
    try { player.setOption('captions', 'track', selectedTrack); } catch {}
    try { player.setOption('captions', 'translationLanguage', null); } catch {}
    try { player.playVideo?.(); } catch {}
    for (let attempt = 0; attempt < 20; attempt++) {
      const requested = performance.getEntriesByType('resource').some(entry => isCurrentTimedtext(entry.name));
      if (requested) {
        await sleep(500);
        return { requested: true, language: track.languageCode };
      }
      await sleep(500);
    }
    return { requested: false, language: track.languageCode };
  } finally {
    try { player.pauseVideo?.(); } catch {}
  }
})()`;
}

cli({
    site: 'youtube',
    name: 'transcript',
    access: 'read',
    description: 'Get YouTube video transcript/subtitles',
    domain: 'www.youtube.com',
    strategy: Strategy.COOKIE,
    args: [
        { name: 'url', required: true, positional: true, help: 'YouTube video URL or video ID' },
        { name: 'lang', required: false, help: '字幕语言：zh（简体优先）/ zh-Hant（繁体优先）/ en 等；支持逗号分隔兜底，如 zh-Hans,zh-CN,zh' },
        { name: 'mode', required: false, default: 'grouped', help: 'Output mode: grouped (readable paragraphs) or raw (every segment)' },
        { name: 'source', required: false, default: 'auto', help: '提取路径：auto（默认）/ api（播放器+页面数据）/ dom（DOM优先，面板无段落时用播放器字幕网络响应兜底）' },
    ],
    // columns intentionally omitted — raw and grouped modes return different schemas,
    // so we let the renderer auto-detect columns from the data keys.
    func: async (page, kwargs) => {
        const videoId = parseVideoId(kwargs.url);
        const langInput = String(kwargs.lang || '').trim();
        const langPreferences = expandLangPreferences(langInput);
        const mode = kwargs.mode || 'grouped';
        const source = String(kwargs.source || 'auto').toLowerCase();
        if (!['auto', 'api', 'dom'].includes(source)) {
            throw new CommandExecutionError(`Invalid --source "${source}" (expected auto, api, or dom)`);
        }
        const watchUrl = 'https://www.youtube.com/watch?v=' + encodeURIComponent(videoId);
        const canCapture = typeof page.startNetworkCapture === 'function' && typeof page.readNetworkCapture === 'function';

        let segments = null;
        let usedLanguage = null;
        let usedSource = null;
        let failure = null;
        // DOM/API失败也会读取该标记，必须在播放器分支之外初始化。
        let lowTrustEmptyResponses = false;

        if (canCapture) {
            try {
                const started = await page.startNetworkCapture('/api/timedtext');
                if (started !== false) {
                    // 捕获器可能复用上个页面的队列；先排空，避免旧响应进入本次解析。
                    await page.readNetworkCapture();
                }
            }
            catch {
                // Best-effort only. The in-page capture and XML fallback still run.
            }
        }

        if (source !== 'dom') {
            await page.goto(watchUrl, { waitUntil: 'none' });
            await page.wait(3);
            // 后台窗口里 visibilityState 可能是 hidden 但播放器仍能工作，这里只做
            // 一次尽力激活，不据此报错。
            await ensurePageVisible(page);
            const playerScript = `
      (async () => {
        const langPrefs = ${JSON.stringify(langPreferences)};
        const langRequested = ${JSON.stringify(langInput)};
        // Scope all timedtext URL matching to the current video. YouTube is an
        // SPA, so watch→watch navigations preserve performance.getEntriesByType
        // entries from prior videos. Without this check a stale same-language
        // URL can be picked up by the polling loop before the current video's
        // fetch hook fires, leaking the predecessor's captions.
        const targetVideoId = ${JSON.stringify(videoId)};
        const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

        function normalizeCode(code) {
          return String(code || '').trim().toLowerCase().replace(/_/g, '-');
        }

        function matchesPreference(code, preference) {
          const normalized = normalizeCode(code);
          const wanted = normalizeCode(preference);
          if (!normalized || !wanted) return false;
          if (normalized === wanted) return true;
          return normalized.startsWith(wanted + '-');
        }

        function textFromJson3Event(event) {
          if (!Array.isArray(event?.segs)) return '';
          return event.segs.map(seg => seg?.utf8 || '').join('').replace(/\\s+/g, ' ').trim();
        }

        function parseJson3(text) {
          let data;
          try {
            data = JSON.parse(text);
          } catch (err) {
            return { error: 'Malformed json3 timedtext response: ' + (err?.message || String(err)) };
          }
          if (!Array.isArray(data.events)) {
            return { error: 'Malformed json3 timedtext response: missing events array' };
          }
          const rows = [];
          for (const event of data.events) {
            const startMs = Number(event.tStartMs || 0);
            const durMs = Number(event.dDurationMs || 0);
            const text = textFromJson3Event(event);
            if (!text) continue;
            rows.push({
              start: startMs / 1000,
              end: (startMs + durMs) / 1000,
              text,
            });
          }
          return { rows };
        }

        function timedtextUrlMatchesVideo(url) {
          try {
            const parsed = new URL(url, location.origin);
            return parsed.searchParams.get('v') === targetVideoId;
          } catch {
            return false;
          }
        }

        function isTranslatedUrl(url) {
          try {
            return !!new URL(url, location.origin).searchParams.get('tlang');
          } catch {
            return false;
          }
        }

        function urlLanguage(url) {
          try {
            return normalizeCode(new URL(url, location.origin).searchParams.get('lang'));
          } catch {
            return '';
          }
        }

        function urlSatisfiesPreferences(url) {
          const code = urlLanguage(url);
          if (!code) return langPrefs.length === 0;
          if (langPrefs.length === 0) return true;
          return langPrefs.some(preference => matchesPreference(code, preference));
        }

        function captionTrackToPlayerTrack(track) {
          if (!track?.languageCode) return null;
          const name = track.name?.simpleText
            || (Array.isArray(track.name?.runs) ? track.name.runs.map(run => run?.text || '').join('') : '')
            || track.languageCode;
          return {
            displayName: name,
            id: null,
            is_default: false,
            is_servable: false,
            is_translateable: !!track.isTranslatable,
            kind: track.kind || '',
            languageCode: track.languageCode,
            languageName: name,
            name: '',
            vss_id: track.vssId || ((track.kind === 'asr' ? 'a.' : '.') + track.languageCode),
          };
        }

        function getTrackCandidates(player) {
          const tracklist = player?.getOption?.('captions', 'tracklist');
          if (Array.isArray(tracklist) && tracklist.length > 0) return tracklist;
          const captionTracks = player?.getPlayerResponse?.()
            ?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
          if (!Array.isArray(captionTracks)) return [];
          return captionTracks.map(captionTrackToPlayerTrack).filter(Boolean);
        }

        function pickTrack(tracklist) {
          if (!Array.isArray(tracklist) || tracklist.length === 0) return null;
          const best = (predicate) => {
            const candidates = tracklist.filter(predicate);
            return candidates.find(track => track?.kind !== 'asr') ?? candidates[0];
          };
          for (const preference of langPrefs) {
            const track = best(candidate => matchesPreference(candidate?.languageCode, preference));
            if (track) return track;
          }
          if (langPrefs.length > 0) return null;
          return tracklist.find(t => normalizeCode(t.languageCode) === 'en' && t.kind !== 'asr')
            || tracklist.find(t => normalizeCode(t.languageCode).startsWith('en') && t.kind !== 'asr')
            || tracklist.find(t => normalizeCode(t.languageCode) === 'en')
            || tracklist.find(t => t.kind !== 'asr')
            || tracklist[0];
        }

        function findTimedtextUrl(track) {
          const urls = performance.getEntriesByType('resource')
            .map(entry => entry.name)
            .filter(url => url.includes('/api/timedtext')
                        && url.includes('fmt=json3')
                        && url.includes('pot=')
                        && !isTranslatedUrl(url)
                        && timedtextUrlMatchesVideo(url)
                        && urlSatisfiesPreferences(url));
          if (!urls.length) return '';
          if (track?.languageCode) {
            const wanted = normalizeCode(track.languageCode);
            const match = [...urls].reverse().find((rawUrl) => {
              const got = urlLanguage(rawUrl);
              return got === wanted || got.startsWith(wanted + '-') || wanted.startsWith(got + '-');
            });
            if (match) return match;
          }
          return urls[urls.length - 1];
        }

        function isJson3TimedtextUrl(url, track) {
          if (!url || !url.includes('/api/timedtext')) return false;
          if (!url.includes('fmt=json3')) return false;
          if (!url.includes('pot=')) return false;
          if (!timedtextUrlMatchesVideo(url)) return false;
          if (isTranslatedUrl(url)) return false;
          if (!urlSatisfiesPreferences(url)) return false;
          if (!track?.languageCode) return true;
          const got = urlLanguage(url);
          const wanted = normalizeCode(track.languageCode);
          return got === wanted || got.startsWith(wanted + '-') || wanted.startsWith(got + '-');
        }

        const player = document.getElementById('movie_player');
        if (!player?.getOption || !player?.setOption) {
          return null;
        }

        let track = null;
        let tracklist = [];
        for (let i = 0; i < 20; i++) {
          tracklist = getTrackCandidates(player);
          track = pickTrack(tracklist);
          if (track) break;
          await sleep(500);
        }
        if (!track) {
          // 有字幕轨但没有任何一条满足 --lang：明确报错，避免静默返回其它语言。
          if (tracklist.length > 0 && langPrefs.length > 0) {
            return {
              error: 'No caption track matches --lang "' + langRequested + '"',
              available: tracklist.map(t => t.languageCode + (t.kind === 'asr' ? ' (auto)' : '')),
            };
          }
          return null;
        }

        const originalFetch = globalThis.fetch;
        const boundOriginalFetch = originalFetch?.bind(globalThis);
        const OriginalXHR = globalThis.XMLHttpRequest;
        let capturedJson3Text = '';
        // 低信任文档的特征：拿到了 timedtext URL，但响应 body 全是空的（pot 无效）。
        let timedtextUrlsSeen = 0;
        let emptyTimedtextBodies = 0;
        try {
          if (boundOriginalFetch) {
            globalThis.fetch = async (...args) => {
              const response = await boundOriginalFetch(...args);
              try {
                const req = args[0];
                const reqUrl = typeof req === 'string' ? req : req?.url || '';
                if (isJson3TimedtextUrl(reqUrl, track) && response?.ok) {
                  const text = await response.clone().text();
                  if (text && !capturedJson3Text) {
                    capturedJson3Text = text;
                  }
                }
              } catch {}
              return response;
            };
          }
          if (OriginalXHR) {
            globalThis.XMLHttpRequest = class TimedtextCaptureXHR extends OriginalXHR {
              open(method, url, ...rest) {
                this.__opencliTimedtextUrl = typeof url === 'string' ? url : '';
                return super.open(method, url, ...rest);
              }
              send(...args) {
                this.addEventListener('load', () => {
                  try {
                    const url = this.__opencliTimedtextUrl || this.responseURL || '';
                    if (!isJson3TimedtextUrl(url, track)) return;
                    if (this.status < 200 || this.status >= 300) return;
                    const text = typeof this.responseText === 'string' ? this.responseText : '';
                    if (text && !capturedJson3Text) {
                      capturedJson3Text = text;
                    }
                  } catch {}
                });
                return super.send(...args);
              }
            };
          }

          // Do not clear resource timings: some videos emit a valid timedtext URL
          // before our polling loop starts; keeping existing entries avoids misses.
          try { player.loadModule?.('captions'); } catch {}
          await sleep(500);
          // 去掉 translationLanguage，防止播放器继续请求 tlang 翻译轨。
          const trackForPlayer = { ...track };
          delete trackForPlayer.translationLanguage;
          try { player.setOption('captions', 'track', trackForPlayer); } catch {}
          try { player.setOption('captions', 'translationLanguage', null); } catch {}
          try { player.playVideo?.(); } catch {}

          for (let i = 0; i < 30; i++) {
            await sleep(500);
            if (capturedJson3Text) {
              const parsed = parseJson3(capturedJson3Text);
              if (parsed.error) return { error: parsed.error };
              if (parsed.rows.length > 0) {
                return { rows: parsed.rows, language: track.languageCode, source: 'player' };
              }
            }
            const url = findTimedtextUrl(track);
            if (!url) continue;
            timedtextUrlsSeen++;
            const resp = await fetch(url, { credentials: 'include' });
            if (!resp.ok) continue;
            const text = await resp.text();
            if (!text) {
              emptyTimedtextBodies++;
              continue;
            }
            const parsed = parseJson3(text);
            if (parsed.error) return { error: parsed.error };
            if (parsed.rows.length > 0) {
              return { rows: parsed.rows, language: track.languageCode, source: 'player' };
            }
          }

          return {
            empty: timedtextUrlsSeen > 0 && emptyTimedtextBodies > 0,
            attempts: timedtextUrlsSeen,
            emptyBodies: emptyTimedtextBodies,
          };
        } finally {
          try { player?.pauseVideo?.(); } catch {}
          if (originalFetch) globalThis.fetch = originalFetch;
          if (OriginalXHR) globalThis.XMLHttpRequest = OriginalXHR;
        }
      })()
    `;
            const isLowTrustPayload = (payload) => !!payload && !Array.isArray(payload) && payload.empty === true;
            let playerPayload = unwrapBrowserResult(await page.evaluate(playerScript));
            lowTrustEmptyResponses = isLowTrustPayload(playerPayload);
            if (lowTrustEmptyResponses) {
                // 拿到了 timedtext URL 但响应全是空 body，是低信任文档的确定信号。
                // reload 重建文档后重试一次；attempts=0（播放器根本没发请求）不重试，
                // 那种情况多由标签页 hidden 或页面未加载完导致，reload 无济于事。
                console.error(`[youtube transcript] 播放器 timedtext 全为空响应（attempts=${playerPayload.attempts || 0}），重建文档后重试一次`);
                await reloadWatchDocument(page);
                playerPayload = unwrapBrowserResult(await page.evaluate(playerScript));
                lowTrustEmptyResponses = lowTrustEmptyResponses || isLowTrustPayload(playerPayload);
            }
            if (playerPayload && !Array.isArray(playerPayload) && playerPayload.error) {
                const available = Array.isArray(playerPayload.available) ? playerPayload.available : [];
                throw new CommandExecutionError(`${playerPayload.error}${available.length > 0 ? ' (available: ' + available.join(', ') + ')' : ''}`);
            }
            if (playerPayload && Array.isArray(playerPayload.rows) && playerPayload.rows.length > 0) {
                segments = playerPayload.rows;
                usedLanguage = playerPayload.language || null;
                usedSource = 'player';
            }
            else if (Array.isArray(playerPayload) && playerPayload.length > 0) {
                // 兼容旧返回格式：直接返回段落数组。
                segments = playerPayload;
                usedSource = 'player';
            }

            if (!segments && canCapture) {
                try {
                    const captured = extractSegmentsFromNetworkCapture(await page.readNetworkCapture(), langPreferences, videoId);
                    if (captured.error) {
                        throw new CommandExecutionError(captured.error);
                    }
                    if (captured.segments.length > 0) {
                        segments = captured.segments;
                        usedLanguage = captured.language || null;
                        usedSource = 'network';
                    }
                }
                catch (err) {
                    if (err instanceof CommandExecutionError)
                        throw err;
                    // Keep existing fallback path when capture is unavailable.
                }
            }

            if (!segments) {
                await prepareYoutubeApiPage(page);
                // Fallback: get caption track URL from watch page HTML
                const captionData = unwrapBrowserResult(await page.evaluate(`
      (async () => {
        const extractJsonAssignmentFromHtml = ${extractJsonAssignmentFromHtml.toString()};

        const watchResp = await fetch('/watch?v=' + encodeURIComponent(${JSON.stringify(videoId)}), {
          credentials: 'include',
        });
        if (!watchResp.ok) return { error: 'Watch HTML returned HTTP ' + watchResp.status };

        const html = await watchResp.text();
        const player = extractJsonAssignmentFromHtml(html, 'ytInitialPlayerResponse');
        if (!player) return { error: 'ytInitialPlayerResponse not found in watch HTML' };

        const renderer = player.captions?.playerCaptionsTracklistRenderer;
        if (!renderer?.captionTracks?.length) {
          return { error: 'No captions available for this video' };
        }

        const tracks = renderer.captionTracks;
        const available = tracks.map(t => t.languageCode + (t.kind === 'asr' ? ' (auto)' : ''));
        const langPrefs = ${JSON.stringify(langPreferences)};
        const langRequested = ${JSON.stringify(langInput)};

        function normalizeCode(code) {
          return String(code || '').trim().toLowerCase().replace(/_/g, '-');
        }

        function matchesPreference(code, preference) {
          const normalized = normalizeCode(code);
          const wanted = normalizeCode(preference);
          if (!normalized || !wanted) return false;
          if (normalized === wanted) return true;
          return normalized.startsWith(wanted + '-');
        }

        const best = (predicate) => {
          const candidates = tracks.filter(predicate);
          return candidates.find(t => t.kind !== 'asr') ?? candidates[0];
        };

        let track = null;
        for (const preference of langPrefs) {
          track = best(t => matchesPreference(t.languageCode, preference));
          if (track) break;
        }
        if (!track && langPrefs.length > 0) {
          return {
            error: 'No caption track matches --lang "' + langRequested + '"',
            available,
          };
        }
        if (!track) {
          track = tracks.find(t => t.kind !== 'asr') || tracks[0];
        }

        return {
          captionUrl: track.baseUrl,
          language: track.languageCode,
          kind: track.kind || 'manual',
          available,
          requestedLang: langRequested || null,
        };
      })()
    `));
                if (!captionData || typeof captionData !== 'object' || Array.isArray(captionData)) {
                    failure = { type: 'error', message: `Failed to get caption info: ${typeof captionData === 'string' ? captionData : 'malformed response'}` };
                }
                else if (captionData.error) {
                    if (captionData.error === 'No captions available for this video') {
                        failure = { type: 'empty' };
                    }
                    else if (String(captionData.error).startsWith('No caption track matches')) {
                        const available = Array.isArray(captionData.available) ? captionData.available : [];
                        throw new CommandExecutionError(`${captionData.error}${available.length > 0 ? ' (available: ' + available.join(', ') + ')' : ''}`);
                    }
                    else {
                        failure = { type: 'error', message: `${captionData.error}${captionData.available ? ' (available: ' + captionData.available.join(', ') + ')' : ''}` };
                    }
                }
                else if (typeof captionData.captionUrl !== 'string') {
                    failure = { type: 'error', message: 'Malformed caption info payload' };
                }
                else {
                    if (captionData.requestedLang && normalizeLangCode(captionData.language) !== normalizeLangCode(captionData.requestedLang)) {
                        console.error(`Note: --lang "${captionData.requestedLang}" matched "${captionData.language}" (available: ${captionData.available.join(', ')})`);
                    }
                    // Step 2: Fetch caption XML and parse segments
                    // Ensure caption URL requests srv3 XML format — YouTube may return empty
                    // responses when no explicit format is specified.
                    const originalCaptionUrl = captionData.captionUrl;
                    let captionUrl = originalCaptionUrl;
                    if (!/[&?]fmt=/.test(originalCaptionUrl)) {
                        captionUrl = originalCaptionUrl + (originalCaptionUrl.includes('?') ? '&' : '?') + 'fmt=srv3';
                    }
                    const xmlResult = await page.evaluate(`
      (async () => {
        async function fetchCaptionXml(url) {
          const resp = await fetch(url);
          if (!resp.ok) return { error: 'Caption URL returned HTTP ' + resp.status };
          return { xml: await resp.text() || '' };
        }

        const primaryUrl = ${JSON.stringify(captionUrl)};
        const originalUrl = ${JSON.stringify(originalCaptionUrl)};
        let result = await fetchCaptionXml(primaryUrl);
        if (result.error) return result;

        // If srv3 format returned an empty successful body, retry with the
        // original URL. Do not hide HTTP/non-OK failures behind fallback.
        if (!result.xml.length && originalUrl !== primaryUrl) {
          result = await fetchCaptionXml(originalUrl);
          if (result.error) {
            return result;
          }
        }
        const xml = result.xml;

        if (!xml.length) {
          return { error: 'Caption URL returned empty response' };
        }

        function getAttr(tag, name) {
          const needle = name + '="';
          const idx = tag.indexOf(needle);
          if (idx === -1) return '';
          const valStart = idx + needle.length;
          const valEnd = tag.indexOf('"', valStart);
          if (valEnd === -1) return '';
          return tag.substring(valStart, valEnd);
        }

        function decodeEntities(s) {
          return s
            .replaceAll('&amp;', '&')
            .replaceAll('&lt;', '<')
            .replaceAll('&gt;', '>')
            .replaceAll('&quot;', '"')
            .replaceAll('&#39;', "'");
        }

        const isFormat3 = xml.includes('<p t="');
        const marker = isFormat3 ? '<p ' : '<text ';
        const endMarker = isFormat3 ? '</p>' : '</text>';
        const results = [];
        let pos = 0;

        while (true) {
          const tagStart = xml.indexOf(marker, pos);
          if (tagStart === -1) break;
          let contentStart = xml.indexOf('>', tagStart);
          if (contentStart === -1) break;
          contentStart += 1;
          const tagEnd = xml.indexOf(endMarker, contentStart);
          if (tagEnd === -1) break;

          const attrStr = xml.substring(tagStart + marker.length, contentStart - 1);
          const content = xml.substring(contentStart, tagEnd);

          let startSec, durSec;
          if (isFormat3) {
            startSec = (parseFloat(getAttr(attrStr, 't')) || 0) / 1000;
            durSec = (parseFloat(getAttr(attrStr, 'd')) || 0) / 1000;
          } else {
            startSec = parseFloat(getAttr(attrStr, 'start')) || 0;
            durSec = parseFloat(getAttr(attrStr, 'dur')) || 0;
          }

          // Strip inner tags (e.g. <s> in srv3 format) and decode entities
          const text = decodeEntities(content.replace(/<[^>]+>/g, '')).split('\\\\n').join(' ').trim();
          if (text) {
            results.push({ start: startSec, end: startSec + durSec, text });
          }

          pos = tagEnd + endMarker.length;
        }

        if (results.length === 0) {
          return { error: 'Parsed 0 segments from caption XML' };
        }

        return results;
      })()
    `);
                    if (xmlResult && !Array.isArray(xmlResult) && xmlResult.error) {
                        failure = { type: 'error', message: xmlResult.error };
                    }
                    else {
                        const rows = normalizeSegmentsPayload(xmlResult, 'caption XML extraction');
                        if (rows.length > 0) {
                            segments = rows;
                            usedLanguage = captionData.language;
                            usedSource = 'html';
                        }
                    }
                }
            }
        }

        // Step 2.5: DOM 兜底 —— 播放器/HTML 路径都拿不到时，打开“转写文稿”面板读取已渲染段落。
        // YouTube 自己的播放器请求带 PO Token，面板里的字幕通常能正常显示。
        if (!segments && source !== 'api') {
            await page.goto(watchUrl, { waitUntil: 'none' });
            await page.wait(2);
            await ensurePageVisible(page);
            // 这里的同标签页导航同样会产出低信任文档；不 reload，面板触发的
            // get_transcript 会一直 400，转写段永远渲染不出来。
            await reloadWatchDocument(page);
            await ensurePageVisible(page);
            const domResult = unwrapBrowserResult(await page.evaluate(`
      (async () => {
        const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

        function isVisible(el) {
          if (!el) return false;
          const style = getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        }

        function getPanel() {
          // 新版播放器用 target-id="PAmodern_transcript_view"，旧版是
          // engagement-panel-searchable-transcript；两套面板可能同时存在，
          // 优先选已经渲染出字幕段的那一个。
          const panels = Array.from(document.querySelectorAll('ytd-engagement-panel-section-list-renderer'))
            .filter(panel => /transcript/i.test(panel.getAttribute('target-id') || ''));
          return panels.find(panel => panel.querySelector('transcript-segment-view-model, ytd-transcript-segment-renderer'))
            || panels.find(panel => panel.getAttribute('visibility') === 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED')
            || panels[0]
            || null;
        }

        function isPanelOpen(panel) {
          if (!panel) return false;
          const visibility = panel.getAttribute('visibility');
          if (visibility === 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN') return false;
          if (visibility === 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED' || visibility === 'ENGAGEMENT_PANEL_VISIBILITY_MINIMIZED') return true;
          return isVisible(panel);
        }

        function findTranscriptButton() {
          const selectors = [
            'ytd-video-description-transcript-section-renderer button',
            'ytd-video-description-transcript-section-renderer yt-button-shape button',
            'button[aria-label*="transcript" i]',
            'button[aria-label*="转写" i]',
            'button[aria-label*="文字" i]',
          ];
          for (const selector of selectors) {
            const buttons = Array.from(document.querySelectorAll(selector)).filter(isVisible);
            const button = buttons.find(el => /transcript|转写|文字|字幕|script/i.test(
              (el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '')
            ));
            if (button) return button;
          }
          return null;
        }

        function activateTranscriptTab(panel) {
          const tabs = Array.from(panel.querySelectorAll('yt-tab-shape, tp-yt-paper-tab, [role="tab"]'));
          const tab = tabs.find(el => /transcript|转写|字幕/i.test(
            (el.textContent || '') + ' ' + (el.getAttribute('tab-title') || '')
          ));
          if (!tab) return;
          const selected = tab.getAttribute('aria-selected') === 'true'
            || tab.hasAttribute('selected')
            || tab.classList.contains('iron-selected');
          if (!selected) {
            try { tab.click(); } catch {}
          }
        }

        function parseTimestamp(value) {
          const text = String(value || '').trim();
          if (!text) return null;
          const parts = text.split(':').map(part => Number(part.trim()));
          if (parts.some(part => Number.isNaN(part))) return null;
          if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
          if (parts.length === 2) return parts[0] * 60 + parts[1];
          if (parts.length === 1) return parts[0];
          return null;
        }

        function readSegments(panel) {
          // 新版面板没有 #segments-container，段落直接挂在面板内部；
          // 直接在面板范围里查，兼容新旧两套 DOM。
          const modern = panel.querySelectorAll('transcript-segment-view-model');
          const legacy = panel.querySelectorAll('ytd-transcript-segment-renderer');
          const items = modern.length > 0 ? modern : legacy;
          const rows = [];
          for (const segment of items) {
            const timestampEl = segment.querySelector('.ytwTranscriptSegmentViewModelTimestamp, .segment-timestamp');
            const textEl = segment.querySelector('span.yt-core-attributed-string, span.ytAttributedStringHost, .yt-core-attributed-string, .segment-text');
            if (!timestampEl || !textEl) continue;
            const start = parseTimestamp(timestampEl.textContent);
            const text = (textEl.textContent || '').replace(/\\s+/g, ' ').trim();
            if (start === null || !text) continue;
            rows.push({ start, text });
          }
          // DOM 中没有 end，用下一段起点补齐；最后一段默认 3 秒。
          return rows.map((row, index) => ({
            start: row.start,
            end: index + 1 < rows.length ? rows[index + 1].start : row.start + 3,
            text: row.text,
          }));
        }

        const debug = { expanded: false, button: null, panels: [] };
        let panel = getPanel();
        if (!isPanelOpen(panel)) {
          // 描述区和转写按钮是懒加载的，后台窗口可能比前台慢，轮询等待。
          let button = null;
          for (let i = 0; i < 30; i++) {
            button = findTranscriptButton();
            if (button) break;
            if (!debug.expanded) {
              const expand = Array.from(document.querySelectorAll('ytd-text-inline-expander #expand, tp-yt-paper-button#expand')).find(isVisible);
              if (expand) {
                try { expand.click(); } catch {}
                debug.expanded = true;
              }
            }
            await sleep(500);
          }
          if (!button) {
            return { error: '找不到“显示转写文稿”按钮（页面可能未加载完，或该视频没有字幕面板）', debug };
          }
          debug.button = (button.textContent || button.getAttribute('aria-label') || '').trim();
          try { button.click(); } catch {}
        }

        for (let i = 0; i < 40; i++) {
          await sleep(500);
          panel = getPanel();
          if (!panel) continue;
          activateTranscriptTab(panel);
          const rows = readSegments(panel);
          if (rows.length > 0) {
            // 面板的语言由 YouTube 自己的下拉框决定，播放器当前轨道可能残留
            // 上一次的翻译语言，不能拿来当面板语言，因此这里不臆测 language。
            return { rows, language: null, source: 'dom' };
          }
        }
        debug.panels = Array.from(document.querySelectorAll('ytd-engagement-panel-section-list-renderer'))
          .filter(p => /transcript/i.test(p.getAttribute('target-id') || ''))
          .map(p => ({
            target: p.getAttribute('target-id'),
            visibility: p.getAttribute('visibility'),
            segments: p.querySelectorAll('transcript-segment-view-model, ytd-transcript-segment-renderer').length,
          }));
        return { error: '转写面板已打开，但 20 秒内没有读到字幕段（面板可能仍在加载，或该视频无字幕）', debug };
      })()
    `));
            if (domResult && Array.isArray(domResult.rows) && domResult.rows.length > 0) {
                segments = domResult.rows;
                usedLanguage = domResult.language || null;
                usedSource = 'dom';
            }
            else if (domResult?.error) {
                const debug = domResult.debug ? ' debug=' + JSON.stringify(domResult.debug) : '';
                failure = failure || { type: 'error', message: domResult.error + debug };
            }

            if (!segments && canCapture) {
                try {
                    // DOM失败后重新开始定向捕获，避免旧视频或翻译轨的网络记录参与兜底。
                    try {
                        const started = await page.startNetworkCapture('/api/timedtext');
                        if (started !== false) {
                            // 保留未完成条目可避免捕获器等待悬挂响应；完成的旧条目会被排空。
                            await page.readNetworkCapture({ retainIncomplete: true });
                        }
                    }
                    catch {
                        // 捕获器不可用时保留原DOM诊断，不阻断命令。
                    }
                    await ensurePageVisible(page);
                    const fallbackStartedAt = Date.now();
                    await page.evaluate(createPlayerTimedtextRequestScript(videoId, langPreferences));
                    let captured = { segments: [] };
                    // readNetworkCapture保留未完成响应；短轮询只接受本次完整请求结果。
                    for (let attempt = 0; attempt < 24; attempt++) {
                        captured = extractSegmentsFromNetworkCapture(
                            await page.readNetworkCapture({ retainIncomplete: true }),
                            langPreferences,
                            videoId,
                            fallbackStartedAt,
                        );
                        if (captured.error || captured.segments.length > 0)
                            break;
                        await page.wait(0.25);
                    }
                    if (captured.error) {
                        throw new CommandExecutionError(captured.error);
                    }
                    if (captured.segments.length > 0) {
                        segments = captured.segments;
                        usedLanguage = captured.language || null;
                        usedSource = 'network';
                    }
                }
                catch (err) {
                    if (err instanceof CommandExecutionError)
                        throw err;
                    // 网络兜底是尽力路径；失败时保留转写面板的原始错误。
                }
            }
        }

        if (!segments || segments.length === 0) {
            if (failure?.type === 'empty') {
                // "No captions available" 是合法 empty 数据条件（作者没开字幕 + YT 没自动生成），
                // 与 bilibili subtitle 的 EmptyResultError 同模式。下游应按 code EMPTY_RESULT 跳过
                // 重试和 softFail 计数。其它 error（HTTP / parse / 短暂空响应）仍按 fetch 失败抛。
                throw new EmptyResultError('youtube transcript', '该视频没有字幕（作者未开启 + 无自动字幕）。');
            }
            const trustHint = lowTrustEmptyResponses
                ? '（播放器拿到的 timedtext 全为 0 字节，属低信任文档特征；已 reload 重试 1 次仍失败，建议稍后重跑）'
                : '';
            throw new CommandExecutionError((failure?.message || 'Failed to extract transcript') + trustHint);
        }
        if (usedSource === 'dom' && !usedLanguage) {
            // DOM面板没有可靠语言元数据；提示未验证，但不丢弃已读取到的非空段落。
            const requestedLanguage = langInput ? ` requested=${langInput}` : '';
            console.error(`[youtube transcript] source=dom language=unverified${requestedLanguage}`);
        }
        else if (usedSource) {
            console.error(`[youtube transcript] source=${usedSource}${usedLanguage ? ' language=' + usedLanguage : ''}`);
        }
        // Step 3: Fetch chapters (for grouped mode)
        let chapters = [];
        if (mode === 'grouped') {
            try {
                const chapterData = unwrapBrowserResult(await page.evaluate(`
          (async () => {
            const cfg = window.ytcfg?.data_ || {};
            const apiKey = cfg.INNERTUBE_API_KEY;
            if (!apiKey) return [];

            const resp = await fetch('/youtubei/v1/next?key=' + apiKey + '&prettyPrint=false', {
              method: 'POST',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                context: { client: { clientName: 'WEB', clientVersion: '2.20240101.00.00' } },
                videoId: ${JSON.stringify(videoId)}
              })
            });
            if (!resp.ok) return [];
            const data = await resp.json();

            const chapters = [];

            // Try chapterRenderer from player bar
            const panels = data.playerOverlays?.playerOverlayRenderer
              ?.decoratedPlayerBarRenderer?.decoratedPlayerBarRenderer
              ?.playerBar?.multiMarkersPlayerBarRenderer?.markersMap;

            if (Array.isArray(panels)) {
              for (const panel of panels) {
                const markers = panel.value?.chapters;
                if (!Array.isArray(markers)) continue;
                for (const marker of markers) {
                  const ch = marker.chapterRenderer;
                  if (!ch) continue;
                  const title = ch.title?.simpleText || '';
                  const startMs = ch.timeRangeStartMillis;
                  if (title && typeof startMs === 'number') {
                    chapters.push({ title, start: startMs / 1000 });
                  }
                }
              }
            }
            if (chapters.length > 0) return chapters;

            // Fallback: macroMarkersListItemRenderer from engagement panels
            const engPanels = data.engagementPanels;
            if (!Array.isArray(engPanels)) return [];
            for (const ep of engPanels) {
              const content = ep.engagementPanelSectionListRenderer?.content;
              const items = content?.macroMarkersListRenderer?.contents;
              if (!Array.isArray(items)) continue;
              for (const item of items) {
                const renderer = item.macroMarkersListItemRenderer;
                if (!renderer) continue;
                const t = renderer.title?.simpleText || '';
                const ts = renderer.timeDescription?.simpleText || '';
                if (!t || !ts) continue;
                const parts = ts.split(':').map(Number);
                let secs = null;
                if (parts.length === 3 && parts.every(n => !isNaN(n))) secs = parts[0]*3600 + parts[1]*60 + parts[2];
                else if (parts.length === 2 && parts.every(n => !isNaN(n))) secs = parts[0]*60 + parts[1];
                if (secs !== null) chapters.push({ title: t, start: secs });
              }
            }
            return chapters;
          })()
        `));
                if (Array.isArray(chapterData)) {
                    chapters = chapterData;
                }
            }
            catch {
                // Chapters are optional — proceed without them
            }
        }
        // Step 4: Format output based on mode
        if (mode === 'raw') {
            // Precise timestamps in seconds with decimals, matching bilibili/subtitle format
            return segments.map((seg, i) => ({
                index: i + 1,
                start: Number(seg.start).toFixed(2) + 's',
                end: Number(seg.end).toFixed(2) + 's',
                text: seg.text,
            }));
        }
        // Grouped mode: merge sentences, detect speakers, insert chapters
        const grouped = groupTranscriptSegments(segments.map(s => ({ start: s.start, text: s.text })));
        const { rows } = formatGroupedTranscript(grouped, chapters);
        return rows;
    },
});
