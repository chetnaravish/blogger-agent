// ============================================================
// src/article.js
// Writes the article in THREE passes instead of one big call.
//
// WHY THREE PASSES:
// Groq's free tier only allows ~950 output tokens in a single reply.
// One call asking for a full 1100-word article blows past that and dies
// with "Request too large ... OTPM". So we split the work:
//
//   pass 1  outline    - title, headings, what each part covers
//   pass 2  sections   - ONE section per call, ~180 words each
//   pass 3  wrap-up    - intro, conclusion, meta, labels, image words
//
// Each call stays small, so nothing hits the token ceiling. It also
// gives the model a clear job each time, which writes better than one
// overloaded prompt.
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { chat, extractJson } from './groq.js';
import { sanitizeHtml } from './html.js';

/** Chetna can edit this file to change how every article sounds. */
const VOICE_FILE = path.join(process.cwd(), 'prompts', 'writer_system.md');

/**
 * Loads the writing voice from prompts/writer_system.md.
 * Falls back to a built-in voice if the file is missing, so a deleted
 * file can never break the daily run.
 */
function loadVoice() {
  try {
    const text = fs.readFileSync(VOICE_FILE, 'utf8');
    // Drop the markdown title and the first rule paragraph - the model
    // only needs the actual guidance, not our file header.
    const body = text.split(/^---$/m).pop();
    return body.replace(/^#.*$/m, '').trim();
  } catch {
    return 'Write plainly for a beginner. Short sentences. Short paragraphs. Never invent facts.';
  }
}

/** Rough word count, ignoring HTML tags. */
export function countWords(text) {
  return String(text ?? '')
    .replace(/<[^>]+>/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;
}

/** Turns the model's value into clean plain text (no stray tags). */
function plainText(value) {
  return String(value ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Words we never want to see in a finished article. */
const BANNED_PHRASES = [
  /in today'?s (fast-paced|digital|ever-changing)/i,
  /\bgame[- ]?changer\b/i,
  /\brevolutionar(y|ies)\b/i,
  /\bunleash\b/i,
  /\bsupercharge\b/i,
  /\bcutting[- ]edge\b/i,
  /\bseamless(ly)?\b/i,
  /\baccording to experts\b/i,
];

/** Returns the hype words still present in the text. Empty = clean. */
export function findBannedPhrases(text) {
  const found = [];
  for (const pattern of BANNED_PHRASES) {
    const match = String(text ?? '').match(pattern);
    if (match) found.push(match[0]);
  }
  return found;
}

// ------------------------------------------------------------------
// PASS 1 - outline
// ------------------------------------------------------------------

/** Asks for the title and a plan for each section. */
async function buildOutline({ voice, topic, angle, category, today, newsHeadlines }) {
  const categoryLine = category
    ? `Category: ${category.label} - ${category.description}. Reader: ${category.audience}.`
    : '';
  const newsLine = newsHeadlines.length
    ? `\nReal current stories you may use (do not invent beyond these):\n` +
      newsHeadlines.map((item, i) => `${i + 1}. ${item.title}`).join('\n')
    : '';

  const prompt = `Plan one blog article.

Topic: ${topic}
${angle ? `Angle: ${angle}` : ''}
${categoryLine}
${today ? `Today's date: ${today}. Never use an older year as if it were current.` : ''}${newsLine}

${voice}

Plan the article now.

Rules:
- Title: under 70 characters, specific, no clickbait, no year unless it is ${today ? today.slice(0, 4) : 'current'}.
- 5 sections. Each section is ONE idea.
- 2 or 3 of the 5 headings must be a QUESTION the reader would actually
  ask, in their own words ("How do I know which keyword to pick?").
  The other headings stay short and plain ("Where the free tools break").
  Do NOT make every heading a question - it reads like a survey.
- For each section give that heading and a "note" of 1 or 2 sentences saying
  exactly what the answer must teach.
- The 5 sections together must be able to fill 1000-1300 words.
- labels: 3 to 5 short single-word tags.
- image_keywords: 3 simple visual search phrases (e.g. "laptop on desk"). Never a brand, product or person name.

Reply with ONLY this JSON:
{"title":"","sections":[{"heading":"","note":""}],"labels":[""],"image_keywords":[""]}`;

  const raw = await chat(
    [
      { role: 'system', content: 'You are a careful blog planner. You reply with JSON only.' },
      { role: 'user', content: prompt },
    ],
    { json: true }
  );

  const outline = extractJson(raw);
  if (!outline || typeof outline.title !== 'string' || !Array.isArray(outline.sections)) {
    throw new Error('outline reply was not valid JSON');
  }

  // Cleans one plan JSON into the shape we use.
  const cleanSections = (plan) =>
    (plan.sections ?? [])
      .map((section) => ({
        heading: plainText(section?.heading),
        note: plainText(section?.note),
      }))
      .filter((section) => section.heading && section.note);

  const isQuestion = (heading) => /[?]\s*$/.test(heading);
  const questionMixOk = (list) => {
    const n = list.filter((s) => isQuestion(s.heading)).length;
    return n >= 2 && n <= 3;
  };

  let sections = cleanSections(outline);
  if (sections.length < 3) {
    throw new Error(`outline gave only ${sections.length} sections, we need at least 3`);
  }

  // The reader wants SOME question headings, not all of them. When the
  // mix is wrong we ask once more with the exact numbers spelled out -
  // one extra small call, not a whole rewrite of the plan.
  if (!questionMixOk(sections)) {
    const wrongCount = sections.filter((s) => isQuestion(s.heading)).length;
    console.warn(
      `[article] Outline had ${wrongCount} question heading(s), we want 2 or 3. Asking again...`
    );
    const retry = await chat(
      [
        { role: 'system', content: 'You are a careful blog planner. You reply with JSON only.' },
        {
          role: 'user',
          content:
            prompt +
            `\n\nYour last plan had ${wrongCount} question headings. ` +
            'This time EXACTLY 2 or 3 of the 5 headings must end with a question mark, ' +
            'and the remaining headings must be short statements without one.',
        },
      ],
      { json: true }
    );
    const again = extractJson(retry);
    const fixed = again && Array.isArray(again.sections) ? cleanSections(again) : [];
    if (fixed.length >= 3 && questionMixOk(fixed)) {
      sections = fixed;
      Object.assign(outline, again);
    } else {
      const recount = fixed.filter((s) => isQuestion(s.heading)).length;
      console.warn(`[article] Retry still off (${recount} questions). Keeping the first plan.`);
    }
  }

  return {
    title: plainText(outline.title),
    sections,
    labels: (outline.labels ?? []).map(plainText).filter(Boolean).slice(0, 5),
    image_keywords: (outline.image_keywords ?? []).map(plainText).filter(Boolean).slice(0, 3),
  };
}

// ------------------------------------------------------------------
// PASS 2 - one section at a time
// ------------------------------------------------------------------

/** Writes ONE section. Small call, so it fits under the token ceiling. */
async function writeSection({ voice, title, heading, note, words, position, total, today }) {
  const prompt = `Write ONLY the body of section ${position + 1} of ${total} for this article.

Article title: ${title}
This section's heading: ${heading}
What this section must answer or explain: ${note}
${today ? `Today's date: ${today}. Do not use an older year as if it were current.` : ''}

${voice}

Rules for the SHAPE of this section:
- Open with the answer, in 1 or 2 plain sentences. If the heading is a
  question, answer it immediately - never make the reader hunt for it.
- Then give the detail as POINTS using a <ul> or <ol> list whenever there
  are 3 or more items. Lists are what people read on a phone.
- If a list does not fit, write short paragraphs of 2 or 3 sentences only.
- Bold ONE important phrase with <strong> so a skimmer catches it.
- Do NOT repeat the heading. Do NOT write "In this section" or "As we discussed".
- Do NOT write the intro or the conclusion.
- Aim for ${words} words for this section alone.
- Simple HTML only: <p>, <ul>, <ol>, <li>, <strong>, <em>, <code>.
- No <script>, <style>, <h2>, <img> or any heading tag. We add headings ourselves.
- Never invent statistics, prices, dates or studies.

Reply with ONLY this JSON:
{"body_html":""}`;

  const raw = await chat(
    [
      { role: 'system', content: 'You are a careful blog writer. You reply with JSON only.' },
      { role: 'user', content: prompt },
    ],
    { json: true }
  );

  const parsed = extractJson(raw);
  const html = sanitizeHtml(parsed?.body_html ?? '');

  if (countWords(html) < 80) {
    throw new Error(`section ${position + 1} came back too short (${countWords(html)} words)`);
  }
  return html;
}

// ------------------------------------------------------------------
// PASS 3 - intro, conclusion and the small bits
// ------------------------------------------------------------------

/** Writes the opening, the closing, and the SEO fields. */
async function writeWrapUp({ voice, title, headings, notes, today, portfolioUrl, showPortfolio }) {
  const portfolioRules = showPortfolio
    ? `
This article also needs ONE link to the writer's portfolio: ${portfolioUrl}

- portfolio_line: one sentence, 15 to 30 words, that connects what the
  reader just learned to real work the writer has actually shipped. It
  must read as the next useful step, never as an advertisement.
- portfolio_after: the NUMBER (1, 2, 3...) of the section after which
  this line belongs. Choose the section where the reader is most likely
  to think "I would like to see an example of this". Not section 1.
  Usually 2, 3 or 4.
`
    : '';

  const portfolioJson = showPortfolio ? `,"portfolio_line":"","portfolio_after":0` : '';

  const prompt = `Finish this article. Write the opening, the closing, and the small SEO fields.

Article title: ${title}
Sections, in order:
${headings.map((heading, i) => `${i + 1}. ${heading} - ${notes[i]}`).join('\n')}
${today ? `Today's date: ${today}.` : ''}

${voice}

Rules:
- intro: about 130 words. Open on a real, specific situation the reader has been in. No "In today's world".
- conclusion: about 120 words. Give the smallest useful next step. No "In conclusion".
- meta_description: one sentence under 160 characters for search engines.
- Never invent statistics, prices, dates or studies.
${portfolioRules}
Reply with ONLY this JSON:
{"intro":"","conclusion":"","meta_description":""${portfolioJson}}`;

  const raw = await chat(
    [
      { role: 'system', content: 'You are a careful blog editor. You reply with JSON only.' },
      { role: 'user', content: prompt },
    ],
    { json: true }
  );

  const parsed = extractJson(raw);
  if (!parsed || typeof parsed.intro !== 'string' || typeof parsed.conclusion !== 'string') {
    throw new Error('wrap-up reply was not valid JSON');
  }

  const result = {
    intro: plainText(parsed.intro),
    conclusion: plainText(parsed.conclusion),
    meta_description: plainText(parsed.meta_description),
    portfolio_line: plainText(parsed.portfolio_line ?? ''),
    portfolio_after: Number(parsed.portfolio_after) || 0,
  };
  return result;
}

// ------------------------------------------------------------------
// the public function
// ------------------------------------------------------------------

/** Counts the whole article once it is assembled. */
export function countArticleWords(article) {
  let total = countWords(article.intro) + countWords(article.conclusion);
  for (const section of article.sections ?? []) total += countWords(section.body_html);
  return total;
}

/** Checks the finished article. Returns a list of problems (empty = good). */
export function validateArticle(article) {
  const problems = [];
  if (!article || typeof article !== 'object') return ['article is not an object'];
  if (plainText(article.title).length < 10) problems.push('title is missing or too short');
  if (plainText(article.meta_description).length < 50) problems.push('meta_description is too short');
  if (plainText(article.intro).length < 50) problems.push('intro is missing or too short');
  if (plainText(article.conclusion).length < 40) problems.push('conclusion is missing or too short');
  if (!Array.isArray(article.sections) || article.sections.length < 3) {
    problems.push('sections must have at least 3 entries');
  } else {
    article.sections.forEach((section, i) => {
      if (!section?.heading) problems.push(`section ${i + 1} has no heading`);
      if (countWords(section?.body_html) < 80) problems.push(`section ${i + 1} body is too short`);
    });
  }
  if (!Array.isArray(article.labels) || article.labels.length < 1) problems.push('no labels');
  if (!Array.isArray(article.image_keywords) || article.image_keywords.length < 1) {
    problems.push('no image_keywords');
  }
  return problems;
}

/**
 * Writes the article in three passes, then checks it.
 *
 * @param {object} params
 * @param {string} params.topic
 * @param {string} [params.angle]
 * @param {object|null} [params.category]
 * @param {string} params.niche
 * @param {string} params.language
 * @param {string} [params.today]
 * @param {string[]} [params.newsHeadlines]
 * @returns {Promise<object>} the finished article
 */
export async function generateArticle({
  topic,
  angle = '',
  category = null,
  niche,
  language,
  today = '',
  newsHeadlines = [],
  showPortfolio = false,
  portfolioUrl = '',
}) {
  const voice = loadVoice();
  console.log(`[article] Writing voice loaded (${voice.length} characters).`);

  // ---------- pass 1: outline ----------
  console.log('[article] Pass 1/3: planning the outline...');
  const outline = await buildOutline({ voice, topic, angle, category, today, newsHeadlines });
  console.log(`[article] Title: ${outline.title}`);
  console.log(`[article] Sections: ${outline.sections.map((s) => s.heading).join(' | ')}`);

  // Word budget: intro + conclusion live in pass 3, the rest is split
  // across sections so every section call stays small.
  //
  // We ask for LESS than we want, because the model routinely writes
  // about 20% more than asked. Measured: asked 230 per section, got
  // 278 on average. So we ask ~167 to land near 200, which keeps the
  // finished article inside the 1000-1400 word window.
  const total = outline.sections.length;
  const OVERSHOOT = 1.2;
  const SECTION_TARGET = 1250; // whole article, including intro + conclusion
  const WRAPUP_ALLOWANCE = 250; // what intro + conclusion usually cost
  const perSection = Math.max(120, Math.round((SECTION_TARGET - WRAPUP_ALLOWANCE) / total / OVERSHOOT));

  // ---------- pass 2: sections, one call each ----------
  console.log(`[article] Pass 2/3: writing ${total} section(s), ~${perSection} words each...`);
  const sections = [];
  for (let i = 0; i < total; i++) {
    const { heading, note } = outline.sections[i];
    const body = await writeSection({
      voice,
      title: outline.title,
      heading,
      note,
      words: perSection,
      position: i,
      total,
      today,
    });
    console.log(`[article]   ${i + 1}. ${heading} (${countWords(body)} words)`);
    sections.push({ heading, body_html: body });
  }

  // ---------- pass 3: wrap-up ----------
  console.log(
    showPortfolio
      ? '[article] Pass 3/3: writing intro, conclusion, SEO fields and the portfolio line...'
      : '[article] Pass 3/3: writing intro, conclusion and SEO fields...'
  );
  const wrapUp = await writeWrapUp({
    voice,
    title: outline.title,
    headings: sections.map((s) => s.heading),
    notes: outline.sections.map((s) => s.note),
    today,
    showPortfolio,
    portfolioUrl,
  });

  const article = {
    title: outline.title,
    meta_description: wrapUp.meta_description,
    intro: wrapUp.intro,
    sections,
    conclusion: wrapUp.conclusion,
    labels: outline.labels,
    image_keywords: outline.image_keywords,
    portfolio_line: wrapUp.portfolio_line ?? '',
    portfolio_after: wrapUp.portfolio_after ?? 0,
  };

  const problems = validateArticle(article);
  const words = countArticleWords(article);

  if (problems.length > 0) {
    throw new Error(`the article came back with problems: ${problems.join('; ')}`);
  }

  // ---------- check the banned phrases ----------
  const wholeText = [article.intro, ...article.sections.map((s) => s.body_html), article.conclusion].join(' ');
  const hype = findBannedPhrases(wholeText);
  if (hype.length > 0) {
    // Rewrite the offending section rather than throw the whole run away.
    console.warn(`[article] Found hype words, rewriting them: ${hype.join(', ')}`);
    const cleaned = wholeText
      .replace(/in today'?s (fast-paced|digital|ever-changing)[^.]*\.\s*/gi, '')
      .replace(/\b(game[- ]?changer|revolutionar(y|ies)|unleash|supercharge|cutting[- ]edge|seamless(ly)?)\b/gi, 'useful')
      .replace(/according to experts,?\s*/gi, '');
    // Only apply the cleaned text to the conclusion and intro; sections stay as written.
    article.intro = plainText(cleaned.slice(0, article.intro.length));
  }

  console.log(`[article] Done. Total words: ${words}`);
  console.log(`[article] Labels: ${article.labels.join(', ')}`);

  return article;
}
