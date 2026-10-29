// ============================================================
// src/portfolioGitHub.js
// Small GitHub REST/Git Data API client for the portfolio repo.
//
// Only the calls the portfolio step needs:
//   - read the branch head and its tree
//   - read files at that exact commit
//   - create blobs, a tree, a commit and move the branch
//
// The token is only ever sent in the Authorization header. It is
// never logged, not even inside error messages.
// ============================================================

const API = 'https://api.github.com';

/** Encode one repo path without turning its slashes into %2F. */
function encodePath(filePath) {
  return String(filePath)
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
}

/** Branch names can contain slashes, so encode each segment separately. */
function encodeRef(branch) {
  return String(branch)
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
}

function textSnippet(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

export class PortfolioGitHub {
  constructor({ token, repo, branch = 'main' }) {
    const cleanToken = String(token ?? '').trim().replace(/^["']|["']$/g, '');
    if (!cleanToken) {
      throw new Error('PORTFOLIO_GH_TOKEN is missing. Add it to .env or GitHub Secrets.');
    }

    const cleanRepo = String(repo ?? '').trim().replace(/^["']|["']$/g, '');
    if (!cleanRepo.includes('/')) {
      throw new Error(`PORTFOLIO_REPO must look like "owner/repo" (got "${cleanRepo}").`);
    }

    this.token = cleanToken;
    this.repo = cleanRepo;
    this.branch = String(branch ?? '').trim().replace(/^["']|["']$/g, '') || 'main';
  }

  async request(endpoint, { method = 'GET', body, accept = 'application/vnd.github+json' } = {}) {
    const headers = {
      Authorization: `Bearer ${this.token}`,
      Accept: accept,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'blogger-agent/1.0',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const response = await fetch(`${API}${endpoint}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const error = new Error(
        `GitHub ${method} ${endpoint.split('?')[0]} failed (HTTP ${response.status})` +
          (text ? `: ${textSnippet(text)}` : '')
      );
      error.status = response.status;
      error.body = text;
      throw error;
    }

    return response;
  }

  /** Current commit sha of the configured branch. */
  async getHeadCommit() {
    const response = await this.request(
      `/repos/${this.repo}/git/ref/heads/${encodeRef(this.branch)}`
    );
    const data = await response.json();
    const sha = data?.object?.sha;
    if (!sha) throw new Error(`GitHub returned no commit for branch "${this.branch}".`);
    return sha;
  }

  /** Tree sha belonging to a commit. */
  async getCommit(commitSha) {
    const response = await this.request(`/repos/${this.repo}/git/commits/${commitSha}`);
    const data = await response.json();
    const treeSha = data?.tree?.sha;
    if (!treeSha) throw new Error(`GitHub returned no tree for commit ${commitSha}.`);
    return { treeSha, data };
  }

  /**
   * Every blob path in a tree. Used to check whether a post file or an
   * asset already exists BEFORE we write anything.
   */
  async getTreePaths(treeSha) {
    const response = await this.request(
      `/repos/${this.repo}/git/trees/${treeSha}?recursive=1`
    );
    const data = await response.json();
    const paths = new Set(
      (Array.isArray(data?.tree) ? data.tree : [])
        .filter((entry) => entry?.type === 'blob' && typeof entry.path === 'string')
        .map((entry) => entry.path)
    );
    return { paths, truncated: Boolean(data?.truncated) };
  }

  /** Raw text of a file at a commit. Throws 404 when it does not exist. */
  async readTextFile(filePath, ref) {
    const response = await this.request(
      `/repos/${this.repo}/contents/${encodePath(filePath)}?ref=${encodeURIComponent(ref)}`,
      { accept: 'application/vnd.github.raw+json' }
    );
    return response.text();
  }

  /** Raw text, or null when the file does not exist. */
  async readOptionalTextFile(filePath, ref) {
    try {
      return await this.readTextFile(filePath, ref);
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  }

  /** True when the file exists at the commit (metadata call, 404 = no). */
  async fileExists(filePath, ref) {
    try {
      await this.request(
        `/repos/${this.repo}/contents/${encodePath(filePath)}?ref=${encodeURIComponent(ref)}`
      );
      return true;
    } catch (error) {
      if (error.status === 404) return false;
      throw error;
    }
  }

  async createBlob(content, encoding = 'utf-8') {
    const response = await this.request(`/repos/${this.repo}/git/blobs`, {
      method: 'POST',
      body: { content, encoding },
    });
    const data = await response.json();
    if (!data?.sha) throw new Error('GitHub did not return a blob sha.');
    return data.sha;
  }

  async createTree(baseTree, entries) {
    const response = await this.request(`/repos/${this.repo}/git/trees`, {
      method: 'POST',
      body: { base_tree: baseTree, tree: entries },
    });
    const data = await response.json();
    if (!data?.sha) throw new Error('GitHub did not return a tree sha.');
    return data.sha;
  }

  async createCommit({ message, tree, parent }) {
    const response = await this.request(`/repos/${this.repo}/git/commits`, {
      method: 'POST',
      body: { message, tree, parents: [parent] },
    });
    const data = await response.json();
    if (!data?.sha) throw new Error('GitHub did not return a commit sha.');
    return data.sha;
  }

  /**
   * Move the branch to a new commit. force:false is deliberate: if the
   * branch moved while we were preparing, GitHub refuses and the caller
   * re-reads the branch and tries again.
   */
  async updateRef(commitSha) {
    const response = await this.request(
      `/repos/${this.repo}/git/refs/heads/${encodeRef(this.branch)}`,
      { method: 'PATCH', body: { sha: commitSha, force: false } }
    );
    return response.json();
  }
}
