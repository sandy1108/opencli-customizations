// audio-library-search adapter version: 1.0.0
import { ArgumentError, CommandExecutionError, EmptyResultError, TimeoutError } from '@jackwener/opencli/errors';

export const BASE = 'https://www.audiolibrary.com.co';
export const TRACK_COLUMNS = ['title', 'artist', 'genre', 'mood', 'trackUrl', 'previewUrl', 'youtubeUrl', 'authorDownloadUrl', 'licenseType', 'licenseReview', 'licenseText', 'keywords'];
const MOODS = ['Happy', 'Calm', 'Inspirational', 'Bright', 'Dark', 'Sad', 'Funky', 'Romantic', 'Dramatic', 'Angry'];
const GENRES = {
  'dance-electronic': 'Dance & Electronic', cinematic: 'Cinematic', holiday: 'Holiday', ambient: 'Ambient',
  'jazz-blues': 'Jazz & Blues', 'hip-hop-rap': 'Hip Hop & Rap', 'r-b-soul': 'R&B & Soul', pop: 'Pop',
  'children-s': "Children's", classical: 'Classical', 'country-folk': 'Country & Folk',
  'alternative-punk': 'Alternative & Punk', rock: 'Rock', reggae: 'Reggae',
};

function decode(value = '') {
  const entities = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’' };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, entity) => {
    if (entity.startsWith('#')) {
      const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
    }
    return entities[entity.toLowerCase()] ?? all;
  });
}
function text(value = '') {
  return decode(value).replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, '').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
}
function attributes(tag) {
  const values = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) values[match[1].toLowerCase()] = decode(match[2] ?? match[3]);
  return values;
}
function cleanHtml(html) {
  return html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
}
function elements(html, tag) {
  return [...html.matchAll(new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, 'gi'))].map(m => ({ attrs: attributes(m[1]), body: m[2] }));
}
function hasClass(attrs, name) { return (attrs.class ?? '').split(/\s+/).includes(name); }
function httpLink(raw, base = BASE) {
  if (!raw || raw.startsWith('#')) return null;
  try {
    const url = new URL(raw, base);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

/** 按 MusicRecording 边界切分；本站含不规范自闭合 div，不依赖 DOM 栈猜测归属。 */
export function parseTracks(html, sourceUrl) {
  const source = cleanHtml(html);
  const starts = [...source.matchAll(/<div\b[^>]*>/gi)].filter(m => /(?:^|\/)MusicRecording$/.test(attributes(m[0]).itemtype ?? ''));
  if (!starts.length) throw new CommandExecutionError('未找到 MusicRecording，页面结构可能变化或请求被拦截');
  return starts.map((start, i) => {
    const block = source.slice(start.index, starts[i + 1]?.index ?? source.length);
    const anchors = elements(block, 'a');
    const meta = {};
    for (const match of block.matchAll(/<meta\b[^>]*>/gi)) {
      const attrs = attributes(match[0]);
      if (attrs.itemprop && !(attrs.itemprop in meta)) meta[attrs.itemprop] = attrs.content ?? '';
    }
    const recordTitle = elements(block, 'h2').find(e => e.attrs.itemprop === 'name');
    const titleLink = anchors.find(e => hasClass(e.attrs, 'm-title__title'));
    const recordArtist = anchors.find(e => e.attrs.itemprop === 'byArtist');
    const recordGenre = anchors.find(e => e.attrs.itemprop === 'genre');
    const recordMood = anchors.find(e => hasClass(e.attrs, 'm-title__mood'));
    const recordUrl = httpLink(titleLink?.attrs.href, sourceUrl);
    if (!text(recordTitle?.body) || !text(recordArtist?.body) || !text(recordGenre?.body) || !text(recordMood?.body) || !recordUrl?.startsWith(`${BASE}/`)) {
      throw new CommandExecutionError('曲目必需字段缺失，停止返回可能错位的数据');
    }
    const downloadTag = [...block.matchAll(/<span\b[^>]*>/gi)].map(m => attributes(m[0])).find(a => 'data-authors-link' in a);
    const attribution = text(meta.license || downloadTag?.['data-license'] || '');
    const licenseLine = attribution.match(/(?:^|\n)License:\s*([^\n]+)/i)?.[1]?.trim() || null;
    let review = 'review-source-terms';
    if (/CC BY-ND|NoDerivs|NoDerivatives/i.test(licenseLine ?? '')) review = 'review-nd';
    else if (/CC BY-NC|NonCommercial/i.test(licenseLine ?? '')) review = 'review-nc';
    else if (/CC BY-SA|ShareAlike/i.test(licenseLine ?? '')) review = 'review-sa';
    else if (/CC BY(?:\s|$)|Creative Commons.*Attribution/i.test(licenseLine ?? '')) review = 'attribution-required';
    return {
      title: text(recordTitle.body), artist: text(recordArtist.body), genre: text(recordGenre.body), mood: text(recordMood.body),
      trackUrl: recordUrl, previewUrl: httpLink(meta.url),
      youtubeUrl: httpLink(anchors.find(e => e.attrs['aria-label'] === "Go to Youtube's song")?.attrs.href),
      authorDownloadUrl: httpLink(downloadTag?.['data-authors-link']),
      licenseType: licenseLine, licenseReview: review, licenseText: attribution || null, keywords: text(meta.keywords) || null,
    };
  });
}

export function parseCategories(html, kind) {
  const rows = [];
  for (const item of elements(cleanHtml(html), 'a')) {
    if (!hasClass(item.attrs, 'm-list-item')) continue;
    const link = httpLink(item.attrs.href);
    if (!link) continue;
    const url = new URL(link);
    const match = url.origin === BASE && !url.search && !url.hash && url.pathname.match(new RegExp(`^/${kind}/([a-z0-9-]+)$`));
    const heading = elements(item.body, 'h2')[0];
    if (match && text(heading?.body)) rows.push({ kind, slug: match[1], name: text(heading.body), url: link });
  }
  if (!rows.length) throw new CommandExecutionError('分类列表结构变化，未找到有效分类');
  return rows;
}

function integer(value, fallback, name, max) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < 1 || number > max) throw new ArgumentError(`${name} 必须是 1–${max} 的整数`);
  return number;
}
function normalize(value) { return String(value ?? '').normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim(); }
function category(value, names, label) {
  if (value === undefined || value === null || value === '') return null;
  const key = Object.keys(names).find(k => normalize(k) === normalize(value) || normalize(names[k]) === normalize(value));
  if (!key) throw new ArgumentError(`未知 ${label}: ${value}`, `支持的 slug: ${Object.keys(names).join(', ')}`);
  return key;
}

/** 固定域名、限时、无登录；不重试 403/429，也不跟随外站重定向。 */
async function fetchHtml(url) {
  try {
    const response = await fetch(url, {
      headers: { Accept: 'text/html', 'User-Agent': 'audio-library-search/1.0.0' },
      redirect: 'error', signal: AbortSignal.timeout(20000),
    });
    if (response.status === 404) throw new EmptyResultError('audiolibrary', '该分类或曲目不存在');
    if (!response.ok) throw new CommandExecutionError(`Audio Library HTTP ${response.status}`, '停止请求；遇到限流或拦截时稍后再试');
    if (!(response.headers.get('content-type') ?? '').includes('text/html')) throw new CommandExecutionError('响应不是 HTML，停止解析');
    return await response.text();
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') throw new TimeoutError('Audio Library', 20);
    if (error instanceof CommandExecutionError || error instanceof EmptyResultError) throw error;
    throw new CommandExecutionError(`Audio Library 请求失败: ${error.message}`);
  }
}

export async function getCategories(args = {}) {
  const kind = args.kind ?? 'moods';
  if (!['moods', 'genres'].includes(kind)) throw new ArgumentError('kind 必须为 moods 或 genres');
  return parseCategories(await fetchHtml(`${BASE}/${kind}`), kind);
}

/** 关键词是在已读取的分类页中本地匹配，不冒充站内全文搜索。 */
export async function searchTracks(args = {}) {
  const page = integer(args.page, 1, 'page', 1000);
  const budget = integer(args.pages, 2, 'pages', 3);
  const limit = integer(args.limit, 10, 'limit', 30);
  const moods = Object.fromEntries(MOODS.map(name => [name.toLowerCase(), name]));
  const mood = category(args.mood, moods, 'mood');
  const genre = category(args.genre, GENRES, 'genre');
  const query = normalize(args.query);
  if (query.length > 200) throw new ArgumentError('query 最多 200 字符');
  const path = mood ? `/moods/${mood}` : genre ? `/genres/${genre}` : '';
  const matches = [];
  const seen = new Set();
  let scannedPages = 0;
  for (let offset = 0; offset < budget; offset++) {
    if (offset) await new Promise(resolve => setTimeout(resolve, 750));
    const sourcePage = `${BASE}${path}?page=${page + offset}`;
    const html = await fetchHtml(sourcePage);
    const rows = parseTracks(html, sourcePage);
    scannedPages++;
    for (const row of rows) {
      if (mood && normalize(row.mood) !== normalize(moods[mood])) continue;
      if (genre && normalize(row.genre) !== normalize(GENRES[genre])) continue;
      if (query && !normalize([row.title, row.artist, row.genre, row.mood, row.keywords].join(' ')).includes(query)) continue;
      if (seen.has(row.trackUrl)) continue;
      seen.add(row.trackUrl);
      matches.push({ ...row, sourcePage });
      if (matches.length === limit) break;
    }
    const nextPage = page + offset + 1;
    const hasNext = elements(cleanHtml(html), 'a').some(a => {
      const link = httpLink(a.attrs.href, sourcePage);
      if (!link) return false;
      const url = new URL(link);
      return url.origin === BASE && url.pathname === (path || '/') && url.searchParams.get('page') === String(nextPage);
    });
    if (matches.length === limit || !hasNext) break;
  }
  if (!matches.length) throw new EmptyResultError('audiolibrary search', `仅检查 ${path || '/'} 从第 ${page} 页开始的 ${scannedPages} 页；无匹配不代表全站没有`);
  return matches.map((row, index) => ({ rank: index + 1, ...row, scannedPages }));
}

export async function getTrack(args = {}) {
  const raw = String(args.url ?? '').trim();
  let url;
  try { url = new URL(raw, `${BASE}/`); } catch { throw new ArgumentError('url 必须是 Audio Library 曲目地址或 artist/song 路径'); }
  if (!raw || url.origin !== BASE || url.username || url.password || url.search || url.hash || !/^\/[a-z0-9-]+\/[a-z0-9-]+\/?$/.test(url.pathname) || /^\/(moods|genres|download|artists|api)\//.test(url.pathname) || /(?:^|\/)\.{1,2}(?:\/|$)/.test(raw)) {
    throw new ArgumentError('只接受本站的 artist/song 曲目路径，不接受分类、下载地址或附加参数');
  }
  url.pathname = url.pathname.replace(/\/$/, '');
  const rows = parseTracks(await fetchHtml(url.href), url.href);
  if (rows.length !== 1 || rows[0].trackUrl !== url.href) throw new CommandExecutionError('曲目详情与请求地址不一致，停止返回数据');
  return rows;
}
