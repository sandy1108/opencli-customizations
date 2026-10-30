import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';

const API_ROOT = 'https://api.github.com';
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;
const REPO_PATTERN = /^(?<owner>[A-Za-z0-9_.-]+)\/(?<name>[A-Za-z0-9_.-]+)$/;

function parseRepo(value) {
  const repo = String(value ?? '').trim();
  if (!repo) {
    throw new ArgumentError('repo is required', 'Example: opencli github releases openclaw/openclaw --limit 3');
  }
  // 点号可用于普通仓库名，但单独的./..会被URL归一化，必须在请求前拒绝。
  if (!REPO_PATTERN.test(repo) || repo.split('/').some(part => part === '.' || part === '..')) {
    throw new ArgumentError('repo must be in owner/repo form', 'Example: opencli github releases openclaw/openclaw --limit 3');
  }
  return repo;
}

function resolveLimit(value) {
  const raw = value ?? DEFAULT_LIMIT;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new ArgumentError(`--limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  return limit;
}

function responseMessage(payload, fallback) {
  if (payload && typeof payload === 'object' && typeof payload.message === 'string' && payload.message.trim()) {
    return payload.message.trim();
  }
  return fallback;
}

async function requestReleases(repo, limit) {
  const url = `${API_ROOT}/repos/${repo}/releases?per_page=${limit}`;
  let response;

  try {
    response = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'opencli-github-releases',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  } catch (error) {
    throw new CommandExecutionError(
      `GitHub releases request failed: ${error?.message || error}`,
      `Repository: ${repo}`,
    );
  }

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (response.status === 404) {
    throw new CommandExecutionError(
      `GitHub repository "${repo}" was not found`,
      'Use owner/repo, for example: openclaw/openclaw',
    );
  }

  if (response.status === 403 || response.status === 429) {
    throw new CommandExecutionError(
      `GitHub API denied the request: ${responseMessage(payload, `HTTP ${response.status}`)}`,
      'Retry later, or use an authenticated GitHub client if you need a higher rate limit.',
    );
  }

  if (!response.ok) {
    throw new CommandExecutionError(
      `GitHub releases request failed: ${responseMessage(payload, `HTTP ${response.status}`)}`,
      `Repository: ${repo}`,
    );
  }

  if (!Array.isArray(payload)) {
    throw new CommandExecutionError(
      'GitHub releases response was not an array',
      `Repository: ${repo}`,
    );
  }

  return payload;
}

cli({
  site: 'github',
  name: 'releases',
  access: 'read',
  description: 'List GitHub repository releases with release notes',
  domain: 'github.com',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: 'repo', positional: true, required: true, help: 'Repository in owner/repo form' },
    { name: 'limit', type: 'int', default: DEFAULT_LIMIT, help: 'Number of releases to return, 1-100' },
  ],
  columns: ['repo', 'tag_name', 'name', 'prerelease', 'published_at', 'url', 'body'],
  func: async (args) => {
    const repo = parseRepo(args.repo);
    const limit = resolveLimit(args.limit);
    const releases = await requestReleases(repo, limit);

    if (releases.length === 0) {
      throw new EmptyResultError('github releases', `No releases found for "${repo}"`);
    }

    return releases.map((release) => ({
      repo,
      tag_name: typeof release?.tag_name === 'string' ? release.tag_name : '',
      name: typeof release?.name === 'string' ? release.name : '',
      prerelease: Boolean(release?.prerelease),
      published_at: typeof release?.published_at === 'string' ? release.published_at : '',
      url: typeof release?.html_url === 'string' ? release.html_url : '',
      body: typeof release?.body === 'string' ? release.body : '',
    }));
  },
});
