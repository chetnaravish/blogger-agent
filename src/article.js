// ============================================================
// src/article.js
// Asks Groq to write the full article and returns it as a checked
// JavaScript object (never a raw string we have to guess about).
//
// Required JSON shape:
// { "title", "meta_description", "intro",
//   "sections": [ { "heading", "body_html" } ],
//   "conclusion", "labels": [], "image_keywords": [] }
// ============================================================

import { chat, extractJson } from './groq.js';
import { sanitizeHtml } from './html.js';

/** Rough word count, used only for a friendly warning. */
function countWords(text) {
  return String(text ?? '')
    .replace(/<[^>]+>/g, ' ') // ignore HTML tags
    .split(/\s+/)
    .filter(Boolean).length;
}

/**
 * Returns a list of problems. Empty list means the article is usable.
 */
export function validateArticle(article) {
  const problems = [];

  if (!article || typeof article !== 'object') return ['reply was not a JSON object'];

  const needString = (key, minLength = 1) => {
    if (typeof article[key] !== 'string' || article[key].trim().length < minLength) {
      problems.push(`"${key}" is missing or too short`);
    }
  };

  needString('title', 10);
  needString('meta_description', 50);
  needString('intro', 50);
  needString('conclusion', 40);

  if (!Array.isArray(article.sections) || article.sections.length < 2) {
    problems.push('"sections" must be an array with at least 2 sections');
  } else {
    article.sections.forEach((section, index) => {
      if (!section || typeof section !== 'object') {
        problems.push(`section ${index + 1} is not an object`);
        return;
      }
      if (typeof section.heading !== 'string' || section.heading.trim().length < 3) {
        problems.push(`section ${index + 1} has no heading`);
      }
      if (typeof section.body_html !== 'string' || section.body_html.trim().length < 80) {
        problems.push(`section ${index + 1} body_html is missing or too short`);
      }
    });
  }

  if (!Array.isArray(article.labels) || article.labels.length < 1) {
    problems.push('"labels" must be an array of 1-5 tags');
  }

  if (!Array.isArray(article.image_keywords) || article.image_keywords.length < 1) {
    problems.push('"image_keywords" must be an array of 2-3 short search terms');
  }

  return problems;
}

/**
 * Turns a value into clean plain text.
 *
 * The model sometimes puts <p> tags inside "intro" or "conclusion".
 * Those fields are single paragraphs, and html.js escapes whatever it
 * is given - so without this the reader would literally see the tags.
 */
function plainText(value) {
  return String(value ?? '')
    .replace(/<br\s*\/?>/gi, ' ') // a line break is just a space here
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Tidies the raw model output into exactly the shape the pipeline wants. */
function cleanUp(raw) {
  const sections = (raw.sections ?? []).map((section) => ({
    heading: plainText(section.heading),
    body_html: sanitizeHtml(section.body_html),
  }));

  return {
    title: plainText(raw.title),
    meta_description: plainText(raw.meta_description),
    intro: plainText(raw.intro),
    sections,
    conclusion: plainText(raw.conclusion),
    labels: (raw.labels ?? [])
      .map((label) => plainText(label))
      .filter(Boolean)
      .slice(0, 5),
    image_keywords: (raw.image_keywords ?? [])
      .map((keyword) => plainText(keyword))
      .filter(Boolean)
      .slice(0, 3),
  };
}

/** Full word count of the article, for the log line. */
export function countArticleWords(article) {
  let total = countWords(article.intro) + countWords(article.conclusion);
  for (const section of article.sections ?? []) total += countWords(section.body_html);
  return total;
}

/**
 * @param {{ topic: string, angle?: string, niche: string, language: string }} params
 * @returns {Promise<object>} the validated article
 */
export async function generateArticle({ topic, angle = '', niche, language }) {
  const systemPrompt =
    `You are a careful blog writer for a beginner-friendly blog. Niche: ${niche}. ` +
    `You write in ${language}. You never invent facts, numbers or statistics.`;

  const basePrompt = `Write one complete blog article.

Topic: ${topic}
${angle ? `Angle: ${angle}` : ''}

Rules:
- Length: 800 to 950 words in total. This matters, so actually count as you write. Do NOT come in under 700 words.
- Structure: 4 to 5 sections, each with a short clear heading.
- Each section body should be at least 120 words, so 4 sections x 120 = 480 words of section text, plus intro and conclusion.
- Friendly, practical, written for a complete beginner. Use short paragraphs.
- "body_html" must be simple HTML only: <p>, <ul>, <ol>, <li>, <strong>, <em>, <code>. No <script>, no <style>, no html/body tags, no images.
- "meta_description" is one sentence, under 160 characters, used for SEO.
- "labels" are 3 to 5 short single-word tags.
- "image_keywords" are 2 to 3 simple English search terms that describe what the pictures should show (for example "laptop desk"). They are used to generate images, so keep them visual and generic - never name a brand, a product or a person.
- Never invent statistics, dates or news.

Reply with ONLY this JSON and nothing else:
{
  "title": "",
  "meta_description": "",
  "intro": "",
  "sections": [ { "heading": "", "body_html": "" } ],
  "conclusion": "",
  "labels": [""],
  "image_keywords": [""]
}`;

  let lastProblems = ['no attempt was made'];
  // How many times we tried to fix a too-short / too-long article.
  // After 2 tries we accept it rather than burn the whole retry budget.
  let lengthRetries = 0;

  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`[article] Asking Groq to write the article (attempt ${attempt}/3)...`);

    // On a retry we tell Groq exactly what was wrong with the last draft.
    const feedback = lastProblems.join('; ');
    const userPrompt = attempt === 1 ? basePrompt : `${basePrompt}

IMPORTANT - your previous attempt was rejected. Fix these problems:
- ${feedback}

Rewrite the WHOLE article with those fixes. Do not apologise, just output the JSON.`;

    // A network hiccup or a bad model reply must not kill the run,
    // so a failed call just counts as a failed attempt.
    let raw = '';
    try {
      raw = await chat(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        { json: true }
      );
    } catch (error) {
      lastProblems = [`Groq call failed: ${error.message}`];
      console.warn(`[article] ${lastProblems[0]}`);
      continue;
    }

    const parsed = extractJson(raw);
    lastProblems = validateArticle(parsed);

    if (lastProblems.length === 0) {
      const article = cleanUp(parsed);
      const words = countArticleWords(article);

      console.log(`[article] Title: ${article.title}`);
      console.log(`[article] Sections: ${article.sections.length}, words: ${words}`);

      const lengthOk = words >= 700 && words <= 1000;
      if (lengthOk) return article;

      // Structure is fine, only the length is wrong.
      lengthRetries++;
      lastProblems = [
        words < 700
          ? `the article was only ${words} words, it needs at least 700. Add more detail, examples and explanation.`
          : `the article was ${words} words, it needs at most 1000. Make it tighter.`,
      ];
      console.warn(`[article] ${lastProblems[0]}`);

      if (lengthRetries >= 2) {
        console.warn('[article] Accepting this length after 2 attempts to save time.');
        return article;
      }
      continue;
    }

    console.warn(`[article] Reply rejected: ${lastProblems.join('; ')}`);
  }

  throw new Error(
    `Groq did not return a valid article after 3 tries. Problems: ${lastProblems.join('; ')}`
  );
}