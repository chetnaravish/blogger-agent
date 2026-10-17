// ============================================================
// src/logger.js
// Reads and writes posted.json (the memory of what we already
// published). This file is the ONLY place that touches it.
//
// Entry shape:
// { "date": "2026-10-17", "title": "...", "topic": "...",
//   "url": "...", "draft": true }
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POSTED_FILE = path.join(HERE, '..', 'posted.json');

// India Standard Time = UTC + 5h30m. No daylight saving, so it is fixed.
const IST_OFFSET_MINUTES = 330;

/**
 * Returns the current date in IST as "YYYY-MM-DD".
 * The pipeline compares this with logged dates so it never
 * publishes two posts on the same day.
 */
export function getIstDate(from = new Date()) {
  const shifted = new Date(from.getTime() + IST_OFFSET_MINUTES * 60 * 1000);
  // after shifting, getUTC*() reads the IST wall clock
  return shifted.toISOString().slice(0, 10);
}

/** Current IST time as "HH:MM" - only used for nice log messages. */
export function getIstTime(from = new Date()) {
  const shifted = new Date(from.getTime() + IST_OFFSET_MINUTES * 60 * 1000);
  return shifted.toISOString().slice(11, 16);
}

/**
 * Reads posted.json. Returns [] if the file is missing or broken,
 * so one bad character never stops the pipeline.
 */
export function readPosted() {
  try {
    if (!fs.existsSync(POSTED_FILE)) return [];
    const raw = fs.readFileSync(POSTED_FILE, 'utf8').trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.warn(`[logger] posted.json could not be read (${error.message}). Using an empty list.`);
    return [];
  }
}

/** Writes the list back to posted.json with pretty formatting. */
export function writePosted(entries) {
  fs.writeFileSync(POSTED_FILE, JSON.stringify(entries, null, 2) + '\n', 'utf8');
}

/**
 * True if a LIVE (non-draft) post already exists for that IST date.
 * This is the duplicate-post guard used by the pipeline.
 */
export function hasLivePostForDate(date, entries = readPosted()) {
  return entries.some((entry) => entry?.date === date && entry?.draft === false);
}

/** Adds one entry at the end and saves the file. */
export function addEntry(entry) {
  const entries = readPosted();
  entries.push(entry);
  writePosted(entries);
  return entries;
}

/**
 * Last N published titles, newest first. Sent to Groq so it does
 * not suggest a topic we already covered.
 */
export function getRecentTitles(limit = 30, entries = readPosted()) {
  return entries
    .filter((entry) => typeof entry?.title === 'string' && entry.title.trim())
    .slice(-limit)
    .reverse()
    .map((entry) => entry.title.trim());
}