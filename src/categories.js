// ============================================================
// src/categories.js
// Keeps the blog on-topic.
//
//  - reads prompts/categories.json (the file YOU edit)
//  - picks which of the 3 categories to write about today
//  - rotation: the category used LEAST RECENTLY wins, so all three
//    come out evenly
//  - lets you force one with:  npm run post -- --category=vibe_coding
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CATEGORIES_FILE = path.join(HERE, '..', 'prompts', 'categories.json');

/** Reads and lightly checks categories.json. */
export function loadCategories() {
  let raw;
  try {
    raw = fs.readFileSync(CATEGORIES_FILE, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read ${CATEGORIES_FILE}: ${error.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`prompts/categories.json is not valid JSON: ${error.message}`);
  }

  const all = Array.isArray(parsed.categories) ? parsed.categories : [];
  if (all.length === 0) throw new Error('prompts/categories.json has no "categories" array.');

  // Keys that start with "_" are notes for humans, not categories.
  const valid = all.filter((c) => c && typeof c.id === 'string' && !c.id.startsWith('_'));

  const enabled = valid.filter((c) => c.enabled !== false);
  if (enabled.length === 0) throw new Error('Every category in categories.json has "enabled": false.');

  return { all: valid, enabled, fixedLabels: Array.isArray(parsed._fixedLabels) ? parsed._fixedLabels : [] };
}

/** Finds one category by id. Returns null when the id is unknown. */
export function findCategory(categories, id) {
  if (!id) return null;
  return categories.all.find((c) => c.id === id.toLowerCase().trim()) ?? null;
}

/**
 * Reads --category=vibe_coding from the command line.
 *   npm run post -- --category=vibe_coding     (equals form)
 *   npm run post -- --category vibe_coding     (space form)
 *
 * Both forms work, because PowerShell and npm split arguments
 * differently and we do not want to depend on that.
 */
export function parseCategoryOverride(argv = process.argv.slice(2)) {
  const args = argv.map(String);

  for (let index = 0; index < args.length; index++) {
    // --category=value
    const equals = args[index].match(/^--category=(.+)$/i);
    if (equals) return equals[1].trim().toLowerCase();

    // --category value   (the value is the NEXT argument)
    if (/^--category$/i.test(args[index])) {
      const next = args[index + 1];
      if (next && !next.startsWith('-')) return next.trim().toLowerCase();
    }
  }
  return null;
}

/**
 * Picks today's category by least-recently-used.
 *
 * For each category we find the most recent date it was used. The one
 * whose most recent use is oldest wins. A category never used at all
 * counts as older than any date, so brand new categories go first.
 *
 * @param {Array<{category?: string, date?: string}>} posted  from posted.json
 * @param {object} categories  result of loadCategories()
 * @param {string|null} override  forced category id, or null
 * @param {string} today  "YYYY-MM-DD" so we never pick a category
 *                       that already produced a post today
 */
export function chooseCategory({ posted = [], categories, override = null, today = null } = {}) {
  if (!categories) throw new Error('chooseCategory needs the categories object.');

  // ---- 1. Did the user force one? ----
  if (override) {
    const forced = findCategory(categories, override);
    if (!forced) {
      const known = categories.enabled.map((c) => c.id).join(', ');
      throw new Error(`Unknown category "${override}". Choose one of: ${known}`);
    }
    return { category: forced, reason: 'forced on the command line', override: true };
  }

  // ---- 2. Otherwise rotate: least recently used wins ----
  // Most recent use per category. "0000-00-00" means never used, which
  // sorts oldest, so unused categories come first.
  const lastUsed = new Map();
  for (const cat of categories.enabled) {
    lastUsed.set(cat.id, '0000-00-00');
  }

  for (const entry of posted) {
    const id = entry?.category;
    if (!id || !lastUsed.has(id)) continue;
    const date = entry?.date ?? '0000-00-00';
    if (date > lastUsed.get(id)) lastUsed.set(id, date);
  }

  // Sort by last use, oldest first. For equal values keep file order,
  // which makes the rotation predictable for you.
  const ranked = categories.enabled
    .map((cat, index) => ({ cat, last: lastUsed.get(cat.id), index }))
    .sort((a, b) => (a.last === b.last ? a.index - b.index : a.last < b.last ? -1 : 1));

  const winner = ranked[0];

  const never = winner.last === '0000-00-00';
  const reason = never
    ? 'never used before'
    : `last used on ${winner.last} (the longest time ago)`;

  return { category: winner.cat, reason, override: false };
}

/**
 * Prints the rotation so you can see the plan for the coming days.
 * Called only when you pass --show-rotation.
 */
export function describeRotation(categories, posted = []) {
  const lastUsed = new Map(categories.enabled.map((c) => [c.id, '0000-00-00']));
  for (const entry of posted) {
    if (entry?.category && lastUsed.has(entry.category)) {
      const date = entry?.date ?? '0000-00-00';
      if (date > lastUsed.get(entry.category)) lastUsed.set(entry.category, date);
    }
  }
  return categories.enabled
    .map((c) => `${c.id.padEnd(20)} last used: ${lastUsed.get(c.id)}`)
    .join('\n');
}