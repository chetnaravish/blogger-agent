// ============================================================
// src/images.js
// Makes the images for a post using PIXABAY ONLY.
//
// Pollinations and Openverse are gone. Pixabay needs one API key
// (PIXABAY_API_KEY in .env) and gives real, topic-relevant photos.
//
// Rules for this file:
//   - NEVER throws. A failed image search never stops the post.
//   - Images must match the topic: we search with the picture words
//     the writer chose, not with the article title.
//   - Few images on purpose: 1 hero + 1 section picture at most.
//   - Saved as a small JPEG (<= 1280px wide, <= 300 KB) into images/,
//     then pushed to GitHub and served from jsDelivr.
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const PIXABAY_URL = 'https://pixabay.com/api/';

// The blog looks better with a couple of pictures than with a wall of
// them, and every extra image costs a GitHub push + a jsDelivr wait.
const MAX_SECTION_IMAGES = 1;

// Hard limits, so a post can never carry a huge file.
const MAX_WIDTH = 1280;
const MAX_BYTES = 300 * 1024; // 300 KB

// wsrv.nl is a free resize service used ONLY while we build the post.
// The published blog only ever links to jsDelivr (our own GitHub repo).
const RESIZE_SERVICE = 'https://wsrv.nl/';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------
// API key
// ---------------------------------------------------------------

/**
 * Reads the Pixabay key from the environment.
 * We accept a couple of common spellings so a renamed .env line does
 * not silently switch images off.
 *
 * @returns {string} '' when the key is missing (caller must cope)
 */
function getPixabayKey() {
  const names = ['PIXABAY_API_KEY', 'PIXABAY_KEY', 'PIXABAY_TOKEN'];
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim().replace(/^["']|["']$/g, '').trim()) {
      return value.trim().replace(/^["']|["']$/g, '').trim();
    }
  }
  return '';
}

// ---------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------

/** Words that make a photo search worse, so we drop them. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'your', 'into',
  'about', 'when', 'where', 'what', 'how', 'can', 'use', 'using', 'one',
  'why', 'when', 'you', 'are', 'its', 'it', 'to', 'of', 'in', 'on', 'a',
]);

/**
 * Turns a heading or keyword into a photo search.
 *
 * "Keep it under 50 characters" becomes "keep under characters", and
 * a useful visual keyword like "gavel on wooden desk" becomes
 * "gavel wooden desk".
 */
function toSearchQuery(text) {
  const words = String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word));
  return words.slice(0, 5).join(' ');
}

/**
 * A gentler search query for the portfolio cover. It keeps short but
 * important words such as "ai" and only removes punctuation, so a
 * model-supplied coverQuery like "ai laptop desk" stays intact.
 */
function toPhotoQuery(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .join(' ');
}

/**
 * Reads the width/height out of a JPEG header, so we can CHECK an
 * image without installing an image library.
 *
 * @returns {{width:number, height:number}|null}
 */
export function jpegSize(buffer) {
  if (!buffer || buffer.length < 4) return null;
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;

  let offset = 2;
  while (offset < buffer.length - 9) {
    if (buffer[offset] !== 0xff) {
      offset++;
      continue;
    }

    const marker = buffer[offset + 1];
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isStartOfFrame) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }

    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

/** A JPEG we can actually publish. */
function isUsableImage(buffer) {
  if (!buffer || buffer.length < 5000) return false;
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return false;
  const size = jpegSize(buffer);
  if (!size || size.width < 400) return false;
  return true;
}

/** Download with a hard timeout, so a hanging site cannot stall the run. */
async function download(url, timeoutMs, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'blogger-agent/1.0' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const buffer = Buffer.from(await response.arrayBuffer());
    if (!isUsableImage(buffer)) throw new Error('downloaded file is not a usable JPEG');
    console.log(`[images] ${label} -> ${(buffer.length / 1024).toFixed(0)} KB`);
    return buffer;
  } finally {
    clearTimeout(timer);
  }
}

/** Resizes any image URL to <=1280px wide JPEG under 300 KB, no library needed. */
async function resizeToJpeg(sourceUrl, timeoutMs, label) {
  // Step down in quality until the file fits under 300 KB.
  for (const quality of [78, 66, 55]) {
    const url =
      `${RESIZE_SERVICE}?url=${encodeURIComponent(sourceUrl)}` +
      `&w=${MAX_WIDTH}&output=jpg&q=${quality}&we`;

    try {
      const buffer = await download(url, timeoutMs, `${label} @ q${quality}`);
      const size = jpegSize(buffer);

      if (size && size.width > MAX_WIDTH) throw new Error(`still ${size.width}px wide`);
      if (buffer.length <= MAX_BYTES) return buffer;

      console.warn(`[images] ${label} is ${(buffer.length / 1024).toFixed(0)} KB, trying lower quality.`);
    } catch (error) {
      console.warn(`[images] resize failed for ${label}: ${error.message}`);
      break;
    }
  }

  // Fallback: grab the original and hope it is small enough.
  try {
    const buffer = await download(sourceUrl, timeoutMs, `${label} (original)`);
    if (buffer.length <= MAX_BYTES) return buffer;
    console.warn(`[images] ${label} original is ${(buffer.length / 1024).toFixed(0)} KB, too big - skipping.`);
  } catch (error) {
    console.warn(`[images] ${label} could not be downloaded: ${error.message}`);
  }
  return null;
}

/** True when the file really is a WebP image. */
function isWebp(buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length > 1000 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  );
}

/** Download a WebP with a hard timeout and validate it before use. */
async function downloadWebp(url, timeoutMs, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'blogger-agent/1.0' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const buffer = Buffer.from(await response.arrayBuffer());
    if (!isWebp(buffer)) throw new Error('downloaded file is not a usable WebP');
    console.log(`[images] ${label} -> ${(buffer.length / 1024).toFixed(0)} KB`);
    return buffer;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resizes a source photo to a fixed WebP crop with wsrv.nl.
 * `fit=cover` keeps the requested aspect ratio, which is what the
 * portfolio card and the social cover both need.
 */
async function resizeToWebp(sourceUrl, { width, height }, timeoutMs, label) {
  for (const quality of [82, 70]) {
    const url =
      `${RESIZE_SERVICE}?url=${encodeURIComponent(sourceUrl)}` +
      `&w=${width}&h=${height}&fit=cover&output=webp&q=${quality}`;

    try {
      return await downloadWebp(url, timeoutMs, `${label} @ q${quality}`);
    } catch (error) {
      console.warn(`[images] WebP resize failed for ${label} (q${quality}): ${error.message}`);
    }
  }
  return null;
}

/**
 * Finds, crops and returns the two images the portfolio needs.
 *
 * It reuses the same Pixabay search and credit helpers as the Blogger
 * flow, but returns raw buffers because the portfolio publisher sends
 * them to GitHub in the same commit as the HTML.
 *
 * `excludeIds` holds the Pixabay ids already used by today's Blogger
 * post. If the best hit is one of them, the next result is used.
 *
 * @param {object} params
 * @param {string} params.query        the model's coverQuery (2-3 words)
 * @param {string[]} [params.excludeIds]
 * @param {number} [params.timeoutMs]
 * @returns {Promise<{pixabayId:string, cover:Buffer, card:Buffer, alt:string, credit:object}>}
 */
export async function findPortfolioPhotos({
  query,
  excludeIds = [],
  timeoutMs = 60000,
} = {}) {
  const key = getPixabayKey();
  if (!key) {
    throw new Error('PIXABAY_API_KEY is missing, so the portfolio image cannot be made.');
  }

  const searchQuery = toPhotoQuery(query) || toPhotoQuery('technology workspace');

  // The portfolio is about tech and marketing, so try Pixabay's business
  // and computer categories first. A plain search for "funnel" otherwise
  // returns kitchen funnels and mushrooms.
  let hits = [];
  for (const pixabayCategory of ['business', 'computer', '']) {
    hits = await searchPixabay(searchQuery, timeoutMs, key, pixabayCategory);
    if (hits.length >= 3) break;
  }
  if (hits.length === 0) {
    throw new Error(`Pixabay returned no photos for "${searchQuery}".`);
  }

  const excluded = new Set(excludeIds.map((id) => String(id)));
  const wanted = new Set(searchQuery.split(/\s+/).filter(Boolean));

  const score = (hit) => {
    let points = 0;
    const tags = String(hit.tags ?? '').toLowerCase();
    for (const word of wanted) if (tags.includes(word)) points += 5;
    const width = Number(hit.imageWidth) || 0;
    const height = Number(hit.imageHeight) || 0;
    if (width >= 1200) points += 3;
    if (height && width / height >= 1.4) points += 3;
    return points;
  };

  const candidates = hits
    .filter((hit) => !excluded.has(String(hit.id)))
    .slice()
    .sort((a, b) => score(b) - score(a))
    .slice(0, 6);

  if (candidates.length === 0) {
    throw new Error('Pixabay only returned the image already used by the Blogger post.');
  }

  for (const hit of candidates) {
    const cover = await resizeToWebp(hit.largeImageURL, { width: 1200, height: 630 }, timeoutMs, 'portfolio cover');
    if (!cover) continue;

    const card = await resizeToWebp(hit.largeImageURL, { width: 778, height: 560 }, timeoutMs, 'portfolio card');
    if (!card) continue;

    console.log(`[images] Portfolio photo chosen: Pixabay id ${hit.id} (${String(hit.tags ?? '').slice(0, 60)})`);
    return {
      pixabayId: String(hit.id),
      cover,
      card,
      alt: String(hit.tags ?? '').trim() || searchQuery,
      credit: pixabayCredit(hit),
    };
  }

  throw new Error(`Could not download or resize a usable Pixabay photo for "${searchQuery}".`);
}

// ---------------------------------------------------------------
// Pixabay search
// ---------------------------------------------------------------

/**
 * Searches Pixabay for photos that match the query.
 *
 * We only ask for real photographs (image_type=photo), horizontal and
 * large enough for a blog banner, with safe search on.
 *
 * @returns {Promise<object[]>} hits, or [] when anything goes wrong
 */
async function searchPixabay(query, timeoutMs, key, pixabayCategory = '') {
  if (!key) {
    console.warn('[images] PIXABAY_API_KEY is not set, so no image will be fetched.');
    return [];
  }

  const params = new URLSearchParams({
    key,
    q: query,
    image_type: 'photo',
    orientation: 'horizontal',
    safesearch: 'true',
    min_width: String(MAX_WIDTH),
    per_page: '20',
  });
  if (pixabayCategory) params.set('category', pixabayCategory);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${PIXABAY_URL}?${params}`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'blogger-agent/1.0' },
    });

    if (!response.ok) {
      // 400 usually means a bad key or a bad query - say so plainly.
      const body = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}${body ? ` ${body.slice(0, 120)}` : ''}`);
    }

    const data = await response.json();
    const hits = Array.isArray(data?.hits) ? data.hits : [];
    return hits.filter((hit) => typeof hit?.largeImageURL === 'string' && hit.largeImageURL);
  } catch (error) {
    console.warn(`[images] Pixabay search failed for "${query}": ${error.message}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Picks the best unused hit: prefer a wide photo whose own tags agree
 * with what we searched for, so the picture really matches the topic.
 *
 * @param {object[]} hits
 * @param {Set<string>} usedIds  ids we already used in this post
 * @param {string} query         the words we searched for
 */
function pickBest(hits, usedIds, query) {
  const wanted = new Set(toSearchQuery(query).split(/\s+/).filter(Boolean));
  if (hits.length === 0) return null;

  const score = (hit) => {
    let points = 0;
    if (usedIds.has(String(hit.id))) points -= 100; // never repeat a photo
    const tags = String(hit.tags ?? '').toLowerCase();
    for (const word of wanted) if (tags.includes(word)) points += 5;
    const width = Number(hit.imageWidth) || 0;
    const height = Number(hit.imageHeight) || 0;
    if (width >= 1280) points += 3;
    if (height && width / height >= 1.4) points += 3; // nice banner shape
    return points;
  };

  const best = hits.slice().sort((a, b) => score(b) - score(a))[0];
  return score(best) <= -100 ? null : best; // only repeats available
}

/**
 * Credit line for a Pixabay photo.
 * The Pixabay Content License does not require credit, but showing it
 * is honest and tells readers where the picture came from.
 */
function pixabayCredit(hit) {
  return {
    creator: hit?.user || 'Pixabay',
    creatorUrl: hit?.user_id ? `https://pixabay.com/users/${hit.user_id}-${hit.user}/` : 'https://pixabay.com/',
    license: 'pixabay',
    licenseVersion: '',
    licenseLabel: 'Pixabay Content License',
    licenseUrl: 'https://pixabay.com/service/terms/',
    pageUrl: hit?.pageURL || 'https://pixabay.com/',
    title: hit?.tags || '',
  };
}

// ---------------------------------------------------------------
// Saving to the repo
// ---------------------------------------------------------------

/**
 * Saves one image into images/ with a name that can never clash:
 *   2026-10-20-hero-4f9a2c.jpg
 * @returns {string} the file name
 */
export function saveImage(buffer, imagesDir, { date, slot }) {
  fs.mkdirSync(imagesDir, { recursive: true });
  const unique = crypto.randomBytes(3).toString('hex');
  const filename = `${date}-${slot}-${unique}.jpg`;
  fs.writeFileSync(path.join(imagesDir, filename), buffer);
  return filename;
}

// ---------------------------------------------------------------
// Alt text
// ---------------------------------------------------------------

/**
 * Alt text a screen reader (and Google) can actually use.
 * It names the scene instead of just repeating the title.
 */
function buildAltText({ articleTitle, heading, query }) {
  const scene = [query, heading].filter(Boolean).join(', ');
  if (!scene) return articleTitle || 'Article image';
  const text = `${scene} - illustration for "${articleTitle}"`;
  return text.length > 120 ? `${scene} - illustration` : text;
}

// ---------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------

/**
 * Builds the images for the article. Pixabay only, and only a few.
 *
 * @param {object} params
 * @param {object} params.article   the article from article.js
 * @param {string[]} params.sectionHeadings
 * @param {string} params.date      "YYYY-MM-DD" used in the file name
 * @param {string} params.imagesDir
 * @param {number} params.timeoutMs
 * @returns {Promise<{hero:object|null, sections:object[], sources:string[]}>}
 */
export async function findImages({ article, sectionHeadings = [], date, imagesDir, timeoutMs = 60000 }) {
  const result = { hero: null, sections: [], sources: [] };
  const key = getPixabayKey();
  const usedIds = new Set();

  const keywords = (article.image_keywords ?? []).filter(Boolean);

  if (!key) {
    console.warn('[images] PIXABAY_API_KEY is missing. The post will be created without images.');
    console.warn('[images] Add it to .env (and to GitHub Actions secrets), then run again.');
    return result;
  }

  console.log('[images] Source: Pixabay only.');
  console.log(`[images] Picture words from the article: ${keywords.join(', ') || '(none)'}`);

  /**
   * One image. Searches Pixabay with topic words, then downloads and
   * resizes it. NOTHING in here is allowed to throw - a failed picture
   * means the post simply goes out without it.
   *
   * @returns {Promise<object|null>}
   */
  async function makeOne({ slot, heading, preferredQuery }) {
    try {
      // Try up to two search phrases, best first, so a narrow query
      // still lands a picture.
      const queries = [
        toSearchQuery(preferredQuery),
        toSearchQuery(heading),
        toSearchQuery(keywords[0] ?? article.title),
      ].filter((q, index, all) => q && all.indexOf(q) === index);

      for (const query of queries) {
        const hits = await searchPixabay(query, timeoutMs, key);
        const hit = pickBest(hits, usedIds, query);
        if (!hit) {
          console.warn(`[images] No suitable Pixabay photo for "${query}".`);
          continue;
        }

        const buffer = await resizeToJpeg(hit.largeImageURL, timeoutMs, `${slot} (${query})`);
        if (!buffer) continue;

        usedIds.add(String(hit.id));
        const filename = saveImage(buffer, imagesDir, { date, slot });
        result.sources.push(`Pixabay (${slot})`);

        console.log(`[images]   tags: ${String(hit.tags ?? '').slice(0, 70)}`);
        return {
          file: filename,
          bytes: buffer.length,
          source: 'Pixabay',
          // Kept so the portfolio step can avoid reusing this exact photo.
          pixabayId: String(hit.id),
          alt: buildAltText({ articleTitle: article.title, heading, query }),
          credit: pixabayCredit(hit),
        };
      }

      console.warn(`[images] Could not get an image for ${slot}. Moving on without it.`);
      return null;
    } catch (error) {
      // Disk full, permissions, anything unexpected. Never crash the post.
      console.warn(`[images] Unexpected problem with ${slot}: ${error.message}. Skipping this image.`);
      return null;
    }
  }

  // ---- 1. Hero picture (topic words first - it must match the post) ----
  const hero = await makeOne({
    slot: 'hero',
    heading: article.sections?.[0]?.heading ?? '',
    preferredQuery: keywords[0] ?? article.title,
  }).catch(() => null);
  if (hero) result.hero = hero;

  // ---- 2. One section picture, never a wall of them ----
  for (let index = 0; index < Math.min(MAX_SECTION_IMAGES, sectionHeadings.length); index++) {
    const heading = sectionHeadings[index];
    const image = await makeOne({
      slot: `section-${index + 1}`,
      heading,
      preferredQuery: keywords[index + 1] ?? keywords[0] ?? heading,
    }).catch(() => null);
    if (image) result.sections.push(image);
  }

  // ---- 3. Summary ----
  const total = (result.hero ? 1 : 0) + result.sections.length;
  console.log(`[images] Done. ${total} image(s) saved from Pixabay.`);
  if (total === 0) console.log('[images] The post will be published without images.');

  return result;
}

export { MAX_WIDTH, MAX_BYTES, MAX_SECTION_IMAGES };
