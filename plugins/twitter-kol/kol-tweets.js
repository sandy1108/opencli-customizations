// btc-kol-tracker-patch-version: 1.1.0
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';

const TWITTER_BEARER_TOKEN = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
const USER_TWEETS_QUERY_ID = '6fWQaBPK51aGyC_VC7t9GQ';
const USER_BY_SCREEN_NAME_QUERY_ID = 'IGgvgiOx4QZndDHuD3x9TQ';

const USER_TWEETS_FEATURES = {
  rweb_video_screen_enabled: false,
  payments_enabled: false,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  rweb_tipjar_consumption_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  premium_content_api_read_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_grok_analyze_button_fetch_trends_enabled: false,
  responsive_web_grok_analyze_post_followups_enabled: true,
  responsive_web_jetfuel_frame: true,
  responsive_web_grok_share_attachment_enabled: true,
  responsive_web_grok_annotations_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  content_disclosure_indicator_enabled: true,
  content_disclosure_ai_generated_indicator_enabled: true,
  responsive_web_grok_show_grok_translated_post: false,
  responsive_web_grok_analysis_button_from_backend: true,
  post_ctas_fetch_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_grok_image_annotation_enabled: true,
  responsive_web_grok_imagine_annotation_enabled: true,
  responsive_web_grok_community_note_auto_translation_is_enabled: false,
  responsive_web_enhance_cards_enabled: false,
};

const USER_BY_SCREEN_NAME_FEATURES = {
  hidden_profile_subscriptions_enabled: true,
  rweb_tipjar_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  subscriptions_verification_info_is_identity_verified_enabled: true,
  subscriptions_verification_info_verified_since_enabled: true,
  highlights_tweets_tab_ui_enabled: true,
  responsive_web_twitter_article_notes_tab_enabled: true,
  subscriptions_feature_can_gift_premium: true,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
};

const QUERY_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function cleanUsername(value) {
  return String(value || '').replace(/^@/, '').trim();
}

function resolveLimit(value) {
  const raw = value ?? 20;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ArgumentError('--limit must be an integer from 1 to 100');
  }
  return limit;
}

function buildUserByScreenNameUrl(queryId, screenName) {
  const variables = { screen_name: screenName, withSafetyModeUserFields: true };
  return 'https://x.com/i/api/graphql/' + queryId + '/UserByScreenName'
    + '?variables=' + encodeURIComponent(JSON.stringify(variables))
    + '&features=' + encodeURIComponent(JSON.stringify(USER_BY_SCREEN_NAME_FEATURES));
}

function buildUserTweetsUrl(queryId, userId, count, cursor) {
  const variables = {
    userId,
    count,
    includePromotedContent: false,
    withQuickPromoteEligibilityTweetFields: true,
    withVoice: true,
  };
  if (cursor) variables.cursor = cursor;
  return 'https://x.com/i/api/graphql/' + queryId + '/UserTweets'
    + '?variables=' + encodeURIComponent(JSON.stringify(variables))
    + '&features=' + encodeURIComponent(JSON.stringify(USER_TWEETS_FEATURES));
}

function mediaUrl(media) {
  if (media.type === 'photo') return media.media_url_https || media.media_url || null;
  const variants = media.video_info?.variants || [];
  const mp4s = variants
    .filter((variant) => variant.content_type === 'video/mp4' && variant.url)
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  return mp4s[0]?.url || media.media_url_https || media.media_url || null;
}

function extractMedia(legacy) {
  const media = legacy?.extended_entities?.media || legacy?.entities?.media;
  if (!Array.isArray(media) || media.length === 0) {
    return { has_media: false, media_urls: [] };
  }
  const urls = [...new Set(media.map(mediaUrl).filter(Boolean))];
  return { has_media: urls.length > 0, media_urls: urls };
}

function unwrapTweetResult(result) {
  if (!result) return null;
  return result.tweet || result;
}

function extractTweet(result, seen, fallbackScreenName) {
  const tw = unwrapTweetResult(result);
  const legacy = tw?.legacy || {};
  if (!tw?.rest_id || seen.has(tw.rest_id)) return null;
  seen.add(tw.rest_id);

  const user = tw.core?.user_results?.result;
  const screenName = user?.legacy?.screen_name || user?.core?.screen_name || fallbackScreenName;
  const displayName = user?.legacy?.name || user?.core?.name || '';
  const noteText = tw.note_tweet?.note_tweet_results?.result?.text;
  const text = noteText || legacy.full_text || '';
  const isRetweet = Boolean(legacy.retweeted_status_result || text.startsWith('RT @'));

  return {
    id: tw.rest_id,
    author: screenName,
    created_at: legacy.created_at || '',
    is_retweet: isRetweet,
    text,
    likes: legacy.favorite_count || 0,
    retweets: legacy.retweet_count || 0,
    replies: legacy.reply_count || 0,
    views: Number(tw.views?.count) || 0,
    url: `https://x.com/${screenName}/status/${tw.rest_id}`,
    ...extractMedia(legacy),
    name: displayName,
  };
}

function parseUserTweets(data, seen, fallbackScreenName) {
  const parsedRows = [];
  let nextCursor = null;
  const instructions = data?.data?.user?.result?.timeline_v2?.timeline?.instructions
    || data?.data?.user?.result?.timeline?.timeline?.instructions
    || [];

  for (const instruction of instructions) {
    if (instruction.type === 'TimelinePinEntry') continue;
    for (const entry of instruction.entries || []) {
      const content = entry.content || {};
      if (content.entryType === 'TimelineTimelineCursor' || content.__typename === 'TimelineTimelineCursor') {
        if (content.cursorType === 'Bottom' || content.cursorType === 'ShowMore') nextCursor = content.value;
        continue;
      }
      if (entry.entryId?.startsWith('cursor-bottom-') || entry.entryId?.startsWith('cursor-showMore-')) {
        nextCursor = content.value || content.itemContent?.value || nextCursor;
        continue;
      }

      const direct = extractTweet(content.itemContent?.tweet_results?.result, seen, fallbackScreenName);
      if (direct) {
        parsedRows.push(direct);
        continue;
      }

      for (const item of content.items || []) {
        const nested = extractTweet(item.item?.itemContent?.tweet_results?.result, seen, fallbackScreenName);
        if (nested) parsedRows.push(nested);
      }
    }
  }

  return { parsedRows, nextCursor };
}

function summarizeErrors(data) {
  const errors = data?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return '';
  return errors.map((err) => err.message || err.code || 'unknown error').join('; ');
}

async function resolveTwitterQueryId(page, operationName) {
  const resolved = await page.evaluate(`async () => {
    const operationName = ${JSON.stringify(operationName)};
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const resp = await fetch('https://raw.githubusercontent.com/fa0311/twitter-openapi/refs/heads/main/src/config/placeholder.json', { signal: controller.signal });
      clearTimeout(timeout);
      if (resp.ok) {
        const data = await resp.json();
        const entry = data?.[operationName];
        if (entry?.queryId) return entry.queryId;
      }
    } catch {
      clearTimeout(timeout);
    }

    try {
      const scripts = Array.from(document.scripts || [])
        .map((script) => script.src)
        .filter((src) => src && src.includes('/responsive-web/client-web/'));
      for (const scriptUrl of scripts.slice(0, 15)) {
        try {
          const text = await (await fetch(scriptUrl)).text();
          const re = new RegExp('queryId:"([A-Za-z0-9_-]+)"[^}]{0,200}operationName:"' + operationName + '"');
          const match = text.match(re);
          if (match) return match[1];
        } catch {}
      }
    } catch {}
    return null;
  }`);
  return typeof resolved === 'string' && QUERY_ID_PATTERN.test(resolved) ? resolved : null;
}

async function queryIdCandidates(page, operationName, fallbackId) {
  const candidates = [fallbackId];
  const resolved = await resolveTwitterQueryId(page, operationName);
  if (resolved && !candidates.includes(resolved)) candidates.push(resolved);
  return candidates;
}

async function fetchJson(page, url, headers) {
  return page.evaluate(`async () => {
    const resp = await fetch(${JSON.stringify(url)}, {
      headers: ${JSON.stringify(headers)},
      credentials: 'include',
    });
    const text = await resp.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      return { ok: false, status: resp.status, error: 'Response was not JSON' };
    }
    return { ok: resp.ok, status: resp.status, data };
  }`);
}

async function resolveUserId(page, username, headers) {
  const candidates = await queryIdCandidates(page, 'UserByScreenName', USER_BY_SCREEN_NAME_QUERY_ID);
  const problems = [];

  for (const queryId of candidates) {
    const url = buildUserByScreenNameUrl(queryId, username);
    const result = await fetchJson(page, url, headers);
    const user = result.data?.data?.user?.result;
    const userId = user?.rest_id;
    if (result.ok && userId) {
      return { userId, screenName: user?.legacy?.screen_name || user?.core?.screen_name || username };
    }
    problems.push(`UserByScreenName ${queryId}: HTTP ${result.status}; ${result.error || summarizeErrors(result.data) || 'missing rest_id'}`);
  }

  throw new CommandExecutionError(`Could not resolve @${username}. ${problems.join(' | ')}`);
}

async function fetchTweetPage(page, username, userId, limit, cursor, headers, queryIdCandidatesForTweets, workingQueryId) {
  const candidates = workingQueryId ? [workingQueryId] : queryIdCandidatesForTweets;
  const problems = [];
  for (const queryId of candidates) {
    const count = Math.min(100, limit + 10);
    const url = buildUserTweetsUrl(queryId, userId, count, cursor);
    const result = await fetchJson(page, url, headers);
    const seen = new Set();
    const parsed = parseUserTweets(result.data, seen, username);
    if (result.ok && (parsed.parsedRows.length > 0 || !summarizeErrors(result.data))) {
      return { ...parsed, queryId };
    }
    problems.push(`UserTweets ${queryId}: HTTP ${result.status}; ${result.error || summarizeErrors(result.data) || 'no tweet entries parsed'}`);
  }
  throw new CommandExecutionError(problems.join(' | '));
}

cli({
  site: 'twitter',
  name: 'kol-tweets',
  access: 'read',
  description: "Fetch a Twitter/X user's recent tweets for KOL monitoring using an isolated session",
  domain: 'x.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  siteSession: 'ephemeral',
  args: [
    { name: 'username', type: 'string', positional: true, required: true, help: 'Twitter/X screen name, with or without @' },
    { name: 'limit', type: 'int', default: 20, help: 'Max tweets to return, 1-100' },
  ],
  columns: ['id', 'author', 'created_at', 'is_retweet', 'text', 'likes', 'retweets', 'replies', 'views', 'url', 'has_media', 'media_urls'],
  func: async (page, kwargs) => {
    const username = cleanUsername(kwargs.username);
    if (!username) throw new ArgumentError('username is required');
    const limit = resolveLimit(kwargs.limit);

    await page.goto(`https://x.com/${encodeURIComponent(username)}`);
    await page.wait(2);

    const cookies = await page.getCookies({ url: 'https://x.com' });
    const ct0 = cookies.find((cookie) => cookie.name === 'ct0')?.value || null;
    if (!ct0) throw new AuthRequiredError('x.com', 'Not logged into x.com (no ct0 cookie)');

    const headers = {
      Authorization: `Bearer ${decodeURIComponent(TWITTER_BEARER_TOKEN)}`,
      'X-Csrf-Token': ct0,
      'X-Twitter-Auth-Type': 'OAuth2Session',
      'X-Twitter-Active-User': 'yes',
      'X-Twitter-Client-Language': 'en',
    };

    const { userId, screenName } = await resolveUserId(page, username, headers);
    const tweetQueryIds = await queryIdCandidates(page, 'UserTweets', USER_TWEETS_QUERY_ID);
    const rowsById = new Map();
    let cursor = null;
    let workingQueryId = null;

    for (let pageNo = 0; pageNo < 5 && rowsById.size < limit; pageNo++) {
      const pageResult = await fetchTweetPage(page, screenName, userId, limit - rowsById.size, cursor, headers, tweetQueryIds, workingQueryId);
      workingQueryId = pageResult.queryId;
      for (const row of pageResult.parsedRows) {
        if (rowsById.size >= limit) break;
        rowsById.set(row.id, row);
      }
      if (!pageResult.nextCursor || pageResult.nextCursor === cursor) break;
      cursor = pageResult.nextCursor;
    }

    if (rowsById.size === 0) {
      throw new EmptyResultError(`@${username} has no recent tweets`, 'Account may be private, suspended, or X returned an empty timeline');
    }

    return [...rowsById.values()].slice(0, limit).map((row) => ({
      id: row.id,
      author: row.author,
      created_at: row.created_at,
      is_retweet: row.is_retweet,
      text: row.text,
      likes: row.likes,
      retweets: row.retweets,
      replies: row.replies,
      views: row.views,
      url: row.url,
      has_media: row.has_media,
      media_urls: row.media_urls,
    }));
  },
});
