// ============================================================
// src/blogger.js
// Talks to Google:
//   1. trade the long-lived refresh token for a short-lived access token
//   2. create the post with posts.insert
// ============================================================

// Load .env so this module works on its own. dotenv never overwrites
// a real env var, so GitHub Actions secrets always win.
import 'dotenv/config';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const BLOGGER_API = 'https://www.googleapis.com/blogger/v3';
const SCOPE = 'https://www.googleapis.com/auth/blogger';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Turns a failed fetch into an Error that carries the HTTP status. */
async function toError(response, what) {
  const body = await response.text().catch(() => '');
  const error = new Error(`${what} failed (HTTP ${response.status}): ${body.slice(0, 500)}`);
  error.status = response.status;
  error.body = body;
  return error;
}

/** true when the error means "just try again in a moment". */
function isTransient(error) {
  return error.status === 429 || (error.status >= 500 && error.status <= 599);
}

/**
 * Gets a fresh access token from the refresh token.
 *
 * access tokens last only 1 hour, but the refresh token in .env stays
 * valid, so we simply mint a new one on every run.
 */
export async function getAccessToken({ clientId, clientSecret, refreshToken }) {
  const missing = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'].filter(
    (_, index) => ![clientId, clientSecret, refreshToken][index]
  );
  if (missing.length > 0) {
    throw new Error(`${missing.join(', ')} is missing from .env. Run "npm run check".`);
  }

  let lastNetworkError = null;

  // A dropped connection here has no HTTP status, so it never reaches the
  // error handling below. Give it a couple of tries before giving up.
  for (let attempt = 1; attempt <= 3; attempt++) {
    let response;
    try {
      response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
        }),
      });
    } catch (error) {
      lastNetworkError = error;
      console.warn(`[blogger] Token request could not connect (${error.message}). Try ${attempt}/3...`);
      await sleep(5000 * attempt);
      continue;
    }

    if (!response.ok) {
      const error = await toError(response, 'Google token request');

      // invalid_grant = the refresh token was revoked / deleted / belongs to
      // a different app. The only fix is to log in again.
      if (error.body.includes('invalid_grant')) {
        throw new Error(
          'Google says invalid_grant: your refresh token is no longer valid.\n' +
            'Fix: run "npm run auth", log in again, and paste the NEW refresh token into .env\n' +
            'as GOOGLE_REFRESH_TOKEN. (Nothing is wrong with your code.)'
        );
      }

      throw error;
    }

    const data = await response.json();
    if (!data.access_token) throw new Error('Google did not return an access token.');
    return data.access_token;
  }

  throw new Error(
    `Could not reach Google to get an access token (${lastNetworkError?.message}). ` +
      `This is a connection problem, not a mistake in your setup. Try again later.`
  );
}

/** Lists your blogs. Used by scripts/auth.js to find BLOGGER_BLOG_ID. */
export async function listBlogs(accessToken) {
  const response = await fetch(`${BLOGGER_API}/users/self/blogs`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw await toError(response, 'Listing blogs');
  return (await response.json()).items ?? [];
}

/** Turns a Blogger error body into a message a human can act on. */
function explainBloggerError(error) {
  const body = error.body ?? '';

  if (error.status === 403) {
    if (/insufficientPermissions|insufficient authentication scopes|scope/i.test(body)) {
      return (
        'Google returned 403 (not enough permission).\n' +
        'The token is missing the Blogger scope. Fix: run "npm run auth" again, and on the\n' +
        'Google screen make sure the app asks for the Blogger permission and click Allow.'
      );
    }
    if (/blogNotFound|not found/i.test(body)) {
      return (
        'Google returned 403 (blog not found).\n' +
        'BLOGGER_BLOG_ID in .env is probably wrong. Run "npm run auth" to print the\n' +
        'correct id for your blog.'
      );
    }
    return 'Google returned 403 (forbidden). Check that the blog is public and your account owns it.';
  }

  if (error.status === 400) {
    return 'Google rejected the post data (400). The article HTML may be empty or too large.';
  }

  if (error.status === 401) {
    return 'Google returned 401 (unauthorized). The access token was refused. Run "npm run auth" again.';
  }

  return error.message;
}

/**
 * Creates the post in Blogger.
 *
 * @param {object} params
 * @param {string} params.accessToken
 * @param {() => Promise<string>} [params.refreshAccessToken]
 *        Called only if Google answers 401, so a token that expired
 *        mid-run never fails the post.
 * @param {string} params.blogId
 * @param {string} params.title
 * @param {string} params.content      ready-to-publish HTML
 * @param {string[]} params.labels
 * @param {boolean} params.isDraft     true = save as draft, false = publish now
 * @returns {Promise<{id:string, url:string, published:boolean, updated:string}>}
 */
export async function publishPost({
  accessToken,
  refreshAccessToken,
  blogId,
  title,
  content,
  labels = [],
  isDraft = true,
}) {
  if (!blogId) throw new Error('BLOGGER_BLOG_ID is missing from .env. Run "npm run auth" to get it.');

  const endpoint = `${BLOGGER_API}/blogs/${blogId}/posts?isDraft=${isDraft ? 'true' : 'false'}`;

  // Blogger body: kind is required, title/content/labels are our post.
  const payload = {
    kind: 'blogger#post',
    title,
    content,
    labels: labels.map((label) => String(label).trim()).filter(Boolean),
  };

  let lastError = null;
  let currentToken = accessToken;

  // Up to 3 attempts = the first try plus 2 retries.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${currentToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const error = await toError(response, 'Blogger posts.insert');
        lastError = error;

        // 401 = access token expired mid-run. Mint a new one and retry.
        if (error.status === 401 && attempt < 3) {
          if (!refreshAccessToken) throw new Error(explainBloggerError(error));
          console.warn('[blogger] Access token refused (401). Getting a new one and retrying...');
          currentToken = await refreshAccessToken();
          continue;
        }

        if (isTransient(error) && attempt < 3) {
          const waitSeconds = 10 * attempt;
          console.warn(`[blogger] Google said HTTP ${error.status}. Waiting ${waitSeconds}s and retrying...`);
          await sleep(waitSeconds * 1000);
          continue;
        }

        // Not recoverable: replace the raw error with a helpful message.
        throw new Error(explainBloggerError(error));
      }

      const post = await response.json();
      return {
        id: post.id,
        url: post.url ?? '',
        published: post.status === 'PUBLISHED',
        updated: post.updated,
      };
    } catch (error) {
      lastError = error;

      // A dropped connection has NO status at all - "fetch failed",
      // "ECONNRESET", "UND_ERR_CONNECT_TIMEOUT". We still have the whole
      // article at this point, so it is worth trying again rather than
      // throwing away everything the run already built.
      const isNetworkError = !error.status;
      if (isNetworkError && attempt < 3) {
        const waitSeconds = 10 * attempt;
        console.warn(`[blogger] Network problem: ${error.message}. Waiting ${waitSeconds}s and retrying...`);
        await sleep(waitSeconds * 1000);
        continue;
      }
      if (isNetworkError) {
        throw new Error(
          `Google could not be reached after 3 tries (${error.message}).\n` +
            `This is a connection problem, not a mistake in your setup. Run the post again later.`
        );
      }

      // 429/5xx retries and the final message already happened above.
      throw error;
    }
  }

  throw lastError ?? new Error('Publishing failed.');
}

export { SCOPE };