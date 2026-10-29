// ============================================================
// src/portfolioTopics.js
// Picks the topic for the PORTFOLIO post. Completely separate from
// the Blogger topic picker (src/topic.js) - the portfolio gets
// evergreen beginner explainers such as "What is digital marketing"
// or "How to make your own chatbot", not daily news.
//
//   1. the first topic in prompts/portfolio_topics.json that is not
//      already in the portfolio's published-posts.json
//   2. when the list is used up, Groq suggests one in the same style
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chat, extractJson } from './groq.js';
import { asciiSlug } from './portfolioPublisher.js';

const TOPICS_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'prompts',
  'portfolio_topics.json'
);

/** Reads prompts/portfolio_topics.json. */
export function loadPortfolioTopics() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(TOPICS_FILE, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read prompts/portfolio_topics.json: ${error.message}`);
  }

  const categories = parsed?.categories && typeof parsed.categories === 'object' ? parsed.categories : {};
  if (Object.keys(categories).length === 0) {
    throw new Error('prompts/portfolio_topics.json has no "categories".');
  }

  const topics = (Array.isArray(parsed.topics) ? parsed.topics : []).filter(
    (item) => item && typeof item.topic === 'string' && item.topic.trim() && categories[item.category]
  );

  return { categories, topics };
}

/** Category object in the shape the portfolio writer expects. */
function toCategory(categories, id) {
  const entry = categories[id];
  return { id, label: entry.label, description: entry.description, audience: entry.audience };
}

/** Least recently used category, so the portfolio rotates subjects. */
function nextCategoryId(categories, publishedEntries) {
  const lastUsed = new Map(Object.keys(categories).map((id) => [id, '']));
  for (const entry of publishedEntries) {
    if (lastUsed.has(entry?.category) && String(entry.date ?? '') > lastUsed.get(entry.category)) {
      lastUsed.set(entry.category, String(entry.date));
    }
  }
  return [...lastUsed.entries()].sort((a, b) => a[1].localeCompare(b[1]))[0][0];
}

/** Asks Groq for one new topic once the list is used up. */
async function suggestTopic({ categories, categoryId, avoidTitles, usedKeys, examples }) {
  const category = categories[categoryId];
  const prompt = `Suggest ONE topic for a beginner-friendly explainer post on the personal portfolio blog of Chetna Ravish, a web developer and digital marketer.

Category: ${category.label} - ${category.description}
Audience: ${category.audience}

The topic must be evergreen (not news), something beginners really search for, and phrased like these examples:
${examples.map((item) => `- ${item}`).join('\n')}

Do NOT suggest any of these, or a close rewording of them:
${avoidTitles.map((item) => `- ${item}`).join('\n') || '- (none yet)'}

Reply with ONLY this JSON object:
{"topic":""}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const raw = await chat([{ role: 'user', content: prompt }], { json: true, temperature: 0.9 });
    const topic = String(extractJson(raw)?.topic ?? '').replace(/["<>\\]/g, '').trim();
    if (topic && topic.length <= 80 && !usedKeys.has(asciiSlug(topic, 80))) return topic;
    console.warn(`[portfolio] Suggested topic rejected (attempt ${attempt}/3): "${topic}"`);
  }
  throw new Error('Groq could not suggest a new portfolio topic. Add more topics to prompts/portfolio_topics.json.');
}

/**
 * Picks the next portfolio topic.
 *
 * @param {Array} publishedEntries   the portfolio repo's published-posts.json
 * @param {string[]} [existingSlugs] slugs of every blog-*.html already on the site
 * @returns {Promise<{topic:string, category:object, source:string}>}
 */
export async function pickPortfolioTopic(publishedEntries = [], existingSlugs = []) {
  const { categories, topics } = loadPortfolioTopics();
  const usedKeys = new Set(publishedEntries.map((entry) => String(entry?.topicKey ?? '')).filter(Boolean));

  const next = topics.find((item) => !usedKeys.has(asciiSlug(item.topic, 80)));
  if (next) {
    return { topic: next.topic, category: toCategory(categories, next.category), source: 'topic list' };
  }

  const categoryId = nextCategoryId(categories, publishedEntries);
  const avoidTitles = [
    ...topics.map((item) => item.topic),
    ...publishedEntries.map((entry) => entry?.title).filter(Boolean),
    ...existingSlugs.map((slug) => slug.replace(/^blog-/, '').replace(/-/g, ' ')),
  ];
  const topic = await suggestTopic({
    categories,
    categoryId,
    avoidTitles,
    usedKeys,
    examples: topics.slice(0, 6).map((item) => item.topic),
  });
  return { topic, category: toCategory(categories, categoryId), source: 'Groq (topic list used up)' };
}
