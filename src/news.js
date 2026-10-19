// ============================================================
// src/news.js
// Finds REAL, current tech headlines so "AI Updates" articles are not
// based on the model's stale memory (it once suggested a 2024 topic
// in 2026).
//
// Two sources, both free with NO API key:
//   1. Hacker News (Algolia) - clean JSON
//   2. Google News RSS      - backup, parsed with regex (no libraries)
//
// Hard rules for this file:
//   - It must NEVER throw. A news failure is not worth failing a post.
//   - Results are cached on disk so a network blip, or two runs in the
//     same day, do not waste time or break the run.
// ============================================================

import fs from 'node:fs';
import path from 'node:path';

const CACHE_FILE = path.join(process.cwd(), 'news-cache.json');

/** Keep results for 6 hours. Long enough for retries, short enough to stay fresh. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** Search words for each category that wants real news. */
const QUERIES = {
  ai_updates: 'AI models',
};

/** User-Agent matters: Google blocks requests that look like a script. */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';

/** Reads the disk cache, if it is still fresh. */
function readCache(categoryId) {
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const cache = JSON.parse(raw);
    const entry = cache?.[categoryId];
    if (!entry?.fetchedAt) return null;
    if (Date.now() - Date.parse(entry.fetchedAt) > CACHE_TTL_MS) return null;
    return entry;
  } catch {
    return null; // no cache yet, or it is damaged - either way, just refetch
  }
}

/** Writes the disk cache. Never throws. */
function writeCache(categoryId, entry) {
  try {
    let cache = {};
    try {
      cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) ?? {};
    } catch {
      cache = {};
    }
    cache[categoryId] = entry;
    fs.writeFileSync(CACHE_FILE, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
  } catch {
    // Caching is a convenience. If the disk says no, we still have the data.
  }
}

/**
 * Runs fetch with a timeout, so a hung request can never stall a
 * scheduled run forever.
 */
async function fetchWithTimeout(url, ms = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json, text/xml, */*' },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Source 1: Hacker News via the free Algolia API.
 * No key, clean JSON, sorted by points.
 */
async function fetchHackerNews(query, hoursOld = 72) {
  const since = Math.floor(Date.now() / 1000) - hoursOld * 3600;
  const url =
    'https://hn.algolia.com/api/v1/search' +
    `?query=${encodeURIComponent(query)}` +
    '&tags=story&hitsPerPage=20' +
    `&numericFilters=created_at_i>${since}`;

  const response = await fetchWithTimeout(url);
  if (!response.ok) throw new Error(`Hacker News HTTP ${response.status}`);

  const data = await response.json();
  const hits = Array.isArray(data?.hits) ? data.hits : [];

  return hits
    .filter((hit) => typeof hit?.title === 'string' && hit.title.trim())
    .map((hit) => ({
      title: hit.title.trim(),
      url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
      source: 'Hacker News',
      points: Number(hit.points) || 0,
      publishedAt: hit.created_at || null,
    }));
}

/**
 * Source 2: Google News RSS, parsed with regex.
 *
 * There is no XML library in this project on purpose, so we pull out
 * <item> blocks and the tags we need. That is enough for headlines.
 */
async function fetchGoogleNews(query, hoursOld = 72) {
  const url =
    'https://news.google.com/rss/search' +
    `?q=${encodeURIComponent(query)}` +
    '&hl=en-US&gl=US&ceid=US:en';

  const response = await fetchWithTimeout(url);
  if (!response.ok) throw new Error(`Google News HTTP ${response.status}`);

  const xml = await response.text();
  const cutoff = Date.now() - hoursOld * 3600;

  const items = xml.split('<item>').slice(1);
  const headlines = [];

  for (const block of items) {
    const title = block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)?.[1];
    const link = block.match(/<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/)?.[1];
    const dateText = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1];

    if (!title) continue;
    const cleanTitle = decodeEntities(title.trim());
    if (cleanTitle.length < 25) continue; // skip one-word noise

    // Drop anything older than our window, if Google gave us a date.
    if (dateText) {
      const when = Date.parse(dateText.trim());
      if (Number.isFinite(when) && when < cutoff) continue;
    }

    headlines.push({
      title: cleanTitle,
      url: link?.trim() || url,
      source: 'Google News',
      points: 0,
      publishedAt: dateText?.trim() || null,
    });
  }

  return headlines;
}

/** Turns `&amp;` `&#39;` and friends back into plain text. */
function decodeEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/**
 * Removes duplicates and stories that are clearly not about AI,
 * then keeps the strongest few.
 */
function cleanHeadlines(headlines, count) {
  const seen = new Set();
  const out = [];

  for (const item of headlines) {
    const key = item.title.toLowerCase().replace(/[^a-z0-9 ]/g, '').slice(0, 60);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  // Hacker News stories with lots of points are the ones people care about.
  return out.sort((a, b) => b.points - a.points).slice(0, count);
}

/**
 * Real current headlines for a category.
 *
 * Returns { headlines, source, fetchedAt, fromCache }.
 * On any failure it returns an EMPTY list instead of throwing, because
 * an evergreen article is better than no article at all.
 *
 * @param {object} params
 * @param {object} params.category category entry from categories.json
 * @param {number} [params.count]  how many headlines to return
 */
export async function getNewsHeadlines({ category, count = 12 } = {}) {
  const categoryId = category?.id ?? 'ai_updates';

  // Only news-based categories bother with this at all.
  if (category?.news_based !== true) {
    return { headlines: [], source: 'none', fetchedAt: null, fromCache: false };
  }

  const cached = readCache(categoryId);
  if (cached?.headlines?.length) {
    console.log(`[news] Using ${cached.headlines.length} cached headline(s) from ${cached.fetchedAt}.`);
    return { ...cached, fromCache: true };
  }

  const query = QUERIES[categoryId] ?? 'AI';
  const sourcesUsed = [];
  let headlines = [];

  // Source 1: Hacker News
  try {
    const hn = await fetchHackerNews(query);
    sourcesUsed.push('Hacker News');
    headlines.push(...hn);
    console.log(`[news] Hacker News gave ${hn.length} headline(s).`);
  } catch (error) {
    console.warn(`[news] Hacker News failed: ${error.message}`);
  }

  // Source 2: Google News (only if we need more)
  if (headlines.length < count) {
    try {
      const gn = await fetchGoogleNews(query);
      sourcesUsed.push('Google News');
      headlines.push(...gn);
      console.log(`[news] Google News gave ${gn.length} headline(s).`);
    } catch (error) {
      console.warn(`[news] Google News failed: ${error.message}`);
    }
  }

  const cleaned = cleanHeadlines(headlines, count);
  const fetchedAt = new Date().toISOString();

  if (cleaned.length === 0) {
    console.warn('[news] No headlines found. The article will stay evergreen (no dates, no news claims).');
    return { headlines: [], source: 'none', fetchedAt, fromCache: false };
  }

  const result = {
    headlines: cleaned,
    source: sourcesUsed.join(' + '),
    fetchedAt,
    fromCache: false,
  };
  writeCache(categoryId, result);
  console.log(`[news] ${cleaned.length} headline(s) ready from ${result.source}.`);
  return result;
}
