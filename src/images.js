// ============================================================
// src/images.js
// Makes the images for a post. NO API KEY NEEDED.
//
//   Main   : Pollinations  - free AI pictures, no signup
//   Backup : Openverse     - free real photos (CC BY / CC0 / PDM)
//
// Both can fail. This module NEVER throws - if nothing works the
// post is published without any image.
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const POLLINATIONS_URL = 'https://image.pollinations.ai/prompt/';
const OPENVERSE_URL = 'https://api.openverse.org/v1/images/';

// Pollinations free tier allows 1 image every 45 seconds per IP.
const POLLINATIONS_COOLDOWN_MS = 46000;

// We must hit these limits, so they are fixed rules, not settings.
const MAX_WIDTH = 1280;
const MAX_BYTES = 300 * 1024; // 300 KB

// wsrv.nl is a free resize service used ONLY while we build the post.
// The published blog only ever links to jsDelivr (our own GitHub repo),
// so readers and Blogger never touch this service.
const RESIZE_SERVICE = 'https://wsrv.nl/';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Remembers when we last called Pollinations, so we respect the 45s limit.
let lastPollinationsCall = 0;

// ---------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------

/**
 * Reads the width/height out of a JPEG header.
 * A JPEG stores its size in an SOF segment, so we can read it by
 * walking the marker chain. This means we can CHECK an image
 * without installing an image library.
 *
 * @returns {{width:number, height:number}|null}
 */
export function jpegSize(buffer) {
  if (!buffer || buffer.length < 4) return null;
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null; // not a JPEG

  let offset = 2;
  while (offset < buffer.length - 9) {
    if (buffer[offset] !== 0xff) {
      offset++; // padding byte between segments
      continue;
    }

    const marker = buffer[offset + 1];
    // SOF0..SOF15 hold the frame size. Skip DHT/JPG/DAC in that range.
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isStartOfFrame) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }

    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return null; // corrupt, stop instead of looping forever
    offset += 2 + length;
  }
  return null;
}

/** A JPEG we can actually publish. */
function isUsableImage(buffer) {
  if (!buffer || buffer.length < 5000) return false;
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return false; // must be JPEG
  const size = jpegSize(buffer);
  if (!size || size.width < 400) return false; // too small to look good
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

/** Resizes any image URL to 1280px wide JPEG under 300 KB, no library needed. */
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
      // If the resize service itself is down, try the original file.
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

// ---------------------------------------------------------------
// Main source: Pollinations (free AI images)
// ---------------------------------------------------------------

/** Waits out the 45 second free-tier limit. */
async function respectPollinationsLimit() {
  const waitFor = lastPollinationsCall + POLLINATIONS_COOLDOWN_MS - Date.now();
  if (waitFor > 0) {
    console.log(`[images] Pollinations free tier allows 1 image per 45s. Waiting ${Math.ceil(waitFor / 1000)}s...`);
    await sleep(waitFor);
  }
}

/**
 * Asks Pollinations for one 1280x720 image.
 * @returns {Promise<Buffer|null>}
 */
async function generateFromPollinations(prompt, timeoutMs, label) {
  const url =
    `${POLLINATIONS_URL}${encodeURIComponent(prompt)}` +
    '?width=1280&height=720&nologo=true&safe=true&seed=' +
    Math.floor(Math.random() * 100000);

  for (let attempt = 1; attempt <= 2; attempt++) {
    await respectPollinationsLimit();
    lastPollinationsCall = Date.now();

    try {
      console.log(`[images] Pollinations: generating "${label}" (try ${attempt}/2)...`);
      const buffer = await download(url, timeoutMs, `Pollinations ${label}`);

      const size = jpegSize(buffer);
      if (size && size.width > MAX_WIDTH) throw new Error(`${size.width}px wide, limit is ${MAX_WIDTH}px`);
      if (buffer.length > MAX_BYTES) throw new Error(`${(buffer.length / 1024).toFixed(0)} KB is over the limit`);

      return buffer;
    } catch (error) {
      // HTTP 402 with FREE_LIMIT means "come back in N seconds".
      const retryHint = error.message.match(/retry after (\d+)s/i);
      if (retryHint) {
        const waitSeconds = Number(retryHint[1]) + 2;
        console.warn(`[images] Pollinations rate limit hit. Waiting ${waitSeconds}s...`);
        await sleep(waitSeconds * 1000);
        continue;
      }

      console.warn(`[images] Pollinations failed for ${label}: ${error.message}`);
      if (attempt < 2) await sleep(3000);
    }
  }
  return null;
}

// ---------------------------------------------------------------
// Backup source: Openverse (free real photos)
// ---------------------------------------------------------------

/**
 * Searches Openverse for photos we can reuse.
 * We only ask for licenses that are safe for a blog:
 *   by  = CC BY      (credit the photographer - we do that)
 *   cc0 = CC0        (public domain)
 *   pdm = Public Domain Mark
 */
async function searchOpenverse(keyword, timeoutMs) {
  const params = new URLSearchParams({
    q: keyword,
    license: 'by,cc0,pdm',
    mature: 'false',
    aspect_ratio: 'wide',
    size: 'large',
    page_size: '8',
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${OPENVERSE_URL}?${params}`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'blogger-agent/1.0' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const results = (await response.json()).results ?? [];
    return results.filter((item) => item?.url);
  } catch (error) {
    console.warn(`[images] Openverse search failed for "${keyword}": ${error.message}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Picks one Openverse photo and downloads it resized.
 * @returns {Promise<{buffer:Buffer, credit:object}|null>}
 */
async function fetchFromOpenverse(keyword, timeoutMs, label) {
  const results = await searchOpenverse(keyword, timeoutMs);
  if (results.length === 0) return null;

  for (const item of results.slice(0, 3)) {
    const buffer = await resizeToJpeg(item.url, timeoutMs, `Openverse ${label}`);
    if (!buffer) continue;

    // Credit is required for CC BY, and we show it either way.
    const credit = {
      creator: item.creator ?? item.title ?? 'Unknown',
      creatorUrl: item.creator_url ?? '',
      license: item.license ?? '',
      licenseVersion: item.license_version ?? '',
      licenseUrl: item.license_url ?? 'https://creativecommons.org/licenses/',
      pageUrl: item.foreign_landing_url ?? item.url,
      title: item.title ?? '',
    };

    console.log(`[images]   credit: "${credit.title || credit.creator}" - CC ${String(credit.license).toUpperCase()} ${credit.licenseVersion}`);
    return { buffer, credit };
  }
  return null;
}

// ---------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------

// Things we never want in a blog picture.
const NEGATIVE = 'no text, no words, no letters, no logo, no watermark, no signature, no caption, no real person, no face, no identifiable human';

// Turns the article title and keywords into a picture prompt.
function buildPrompt({ topic, title, heading }) {
  const subject = [topic, heading, title].filter(Boolean).join('. ');

  return [
    `Editorial illustration for a technology blog article.`,
    `Subject: ${subject}.`,
    `Style: clean modern flat vector illustration, soft natural lighting, muted professional colours.`,
    `Wide 16:9 landscape composition, plenty of empty space, uncluttered.`,
    NEGATIVE + '.',
  ].join(' ');
}

/** A keyword short enough for a stock-photo search. */
function simplifyKeyword(keyword) {
  const words = String(keyword ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2);
  return words[0] ?? '';
}

// ---------------------------------------------------------------
// Saving to the repo
// ---------------------------------------------------------------

/**
 * Saves one image into images/ with a name that can never clash:
 *   2026-10-17-hero-4f9a2c.jpg
 * @returns {string} the file name
 */
export function saveImage(buffer, imagesDir, { date, slot }) {
  fs.mkdirSync(imagesDir, { recursive: true });
  const unique = crypto.randomBytes(3).toString('hex'); // 6 random chars
  const filename = `${date}-${slot}-${unique}.jpg`;
  fs.writeFileSync(path.join(imagesDir, filename), buffer);
  return filename;
}

// ---------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------

/**
 * Builds every image for the article.
 *
 * @param {object} params
 * @param {object} params.article       the article from article.js
 * @param {string[]} params.sectionHeadings  one per section we want an image for
 * @param {string} params.date          "YYYY-MM-DD" used in the file name
 * @param {string} params.imagesDir     where to save
 * @param {number} params.timeoutMs     per request timeout
 * @param {number} params.maxSectionImages
 * @returns {Promise<{hero:object|null, sections:object[], sources:string[]}>}
 */
export async function findImages({ article, sectionHeadings = [], date, imagesDir, timeoutMs = 60000, maxSectionImages = 2 }) {
  const result = { hero: null, sections: [], sources: [] };
  const keywords = (article.image_keywords ?? []).filter(Boolean);

  console.log('[images] No API key needed. Trying Pollinations first, Openverse as backup.');
  console.log(`[images] Keywords from the article: ${keywords.join(', ') || '(none)'}`);

  /**
   * One image, trying the main source then the backup.
   * @returns {Promise<object|null>} saved image record
   */
  async function makeOne({ slot, alt, keyword }) {
    const prompt = buildPrompt({ topic: article.title, title: article.title, heading: alt });

    // --- Main source ---
    const generated = await generateFromPollinations(prompt, timeoutMs, slot);
    if (generated) {
      const filename = saveImage(generated, imagesDir, { date, slot });
      result.sources.push(`Pollinations (${slot})`);
      return { file: filename, bytes: generated.length, source: 'Pollinations', alt, credit: null };
    }

    // --- Backup source ---
    const searchTerm = keyword || simplifyKeyword(keywords[0]) || article.title;
    const backup = await fetchFromOpenverse(searchTerm, timeoutMs, slot);
    if (backup) {
      const filename = saveImage(backup.buffer, imagesDir, { date, slot });
      result.sources.push(`Openverse (${slot})`);
      return {
        file: filename,
        bytes: backup.buffer.length,
        source: 'Openverse',
        alt,
        credit: backup.credit,
      };
    }

    console.warn(`[images] Could not get an image for ${slot}. Moving on without it.`);
    return null;
  }

  // ---- 1. Hero image ----
  const hero = await makeOne({
    slot: 'hero',
    alt: `Illustration for "${article.title}"`,
    keyword: keywords[0],
  });
  if (hero) result.hero = hero;

  // ---- 2. Section images ----
  const wanted = Math.min(maxSectionImages, sectionHeadings.length);
  for (let index = 0; index < wanted; index++) {
    const heading = sectionHeadings[index];
    const image = await makeOne({
      slot: `section-${index + 1}`,
      alt: `Illustration for "${heading}"`,
      keyword: keywords[index + 1] || keywords[0],
    });
    if (image) result.sections.push(image);
  }

  // ---- 3. Summary ----
  const total = 1 + result.sections.length;
  console.log(`[images] Done. ${total} image(s) saved: ${result.sources.join(', ') || 'none'}`);
  console.log(`[images] Sources used: ${[...new Set(result.sources)].join(', ') || 'none'}`);

  return result;
}

export { MAX_WIDTH, MAX_BYTES };