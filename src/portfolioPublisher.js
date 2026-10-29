// ============================================================
// src/portfolioPublisher.js
// Publishes a SECOND, different article on the static portfolio
// website (a separate repository). It runs in its own process
// (src/portfolioEntry.js), never inside the Blogger run.
//
// The portfolio site is plain static HTML. One portfolio publish:
//   - reads the templates and pages from the branch head over the API
//   - writes a fresh reflective article in Chetna's own voice
//   - makes two unique WebP images (cover + card) with Pixabay/wsrv.nl
//   - inserts the card and sitemap entry using plain strings
//   - creates ONE atomic commit with the GitHub Git Data API
//
// Dry mode writes the same files under out/portfolio/ and never calls
// a GitHub write endpoint.
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { chat, extractJson, getOutputTokenBudget, waitForRateLimit, withModel } from './groq.js';
import { escapeHtml } from './html.js';
import { findPortfolioPhotos } from './images.js';
import { getIstDate } from './logger.js';
import { PortfolioGitHub } from './portfolioGitHub.js';

const POST_TEMPLATE_PATH = 'templates/blog-post.template.html';
const CARD_TEMPLATE_PATH = 'templates/blog-card.template.html';
const BLOG_PATH = 'public/blog.html';
const SITEMAP_PATH = 'public/sitemap.xml';
const PUBLISHED_PATH = 'automation/published-posts.json';

const CARD_MARKER = '<!-- BLOG_CARDS_START -->';
const SITEMAP_MARKER = '<!-- BLOG_SITEMAP_INSERT -->';

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** One post may be 4 or 5 sections; each section 1 to 3 paragraphs. */
const MIN_SECTIONS = 4;
const MAX_SECTIONS = 5;
const MIN_FAQ = 3;
const MAX_FAQ = 4;

/**
 * Reflective posts stay shorter than the Blogger SEO guide. The ceiling
 * leaves room for the usual model overshoot, so one long section does not
 * force every section to be rewritten.
 */
const MIN_WORDS = 600;
const MAX_WORDS = 950;
const WORD_COUNT_TOLERANCE = 0.08;

/**
 * The sections are written in small batches. Their combined target leaves
 * room for the lede and takeaway without pushing the article past MAX_WORDS.
 */
const TARGET_ARTICLE_WORDS = 740;
const TAKEAWAY_RESERVE = 35;

/**
 * The portfolio voice and rules. Every small call receives this same
 * system prompt, so the separate pieces keep one voice and one set of
 * honesty rules.
 */
export const PORTFOLIO_PROMPT = `You are writing a blog post for the personal portfolio website of Chetna Ravish, a web developer and digital marketer from Kaithal, Haryana, India. Chetna is the author and the narrator.

VOICE (FIRST PERSON, ALWAYS)
- Write the whole post in the first person as Chetna: use I, my and me naturally, and speak to the reader as you.
- The post is a clear beginner explainer told in Chetna's own voice: what the topic is, how it works, how to get started, what I think matters most and what I recommend.
- Good first-person sentences: I like to explain it this way. In this post I will walk you through it. What I find most useful is... My advice is to start small. If I were starting today, I would...
- Never switch to a detached third-person voice such as Chetna thinks or the author believes.

LANGUAGE QUALITY
- Proper, natural, grammatically correct English. No Hinglish, no broken grammar, no spelling mistakes.
- Short, clear sentences in active voice. Explain every technical word the first time you use it.
- Sound like a friendly expert talking to a beginner, not like an advert or a textbook.
- Avoid filler and hype such as game-changer, unlock the power, delve, dive deep, revolutionize, in today's fast-paced world, in the ever-evolving landscape.
- No emojis. No markdown. No HTML tags. Plain sentences only.

STRICT HONESTY RULES
- Do NOT invent personal experiences, clients, projects, results, numbers, quotes, tests or case studies.
- Never write phrases such as "I built", "I tested", "my client", "my clients", "my project", "I measured", "I surveyed", "in my experience", or "when I ran this". Use I think, I recommend, I would, I like, you can instead.
- You may use well-established general knowledge: definitions, how common tools and platforms work, standard best practices.
- Do not invent statistics, percentages, dates, prices, version numbers, study results or direct quotes. If FACTS are supplied, any specific news claim must come from them.
- Never present an opinion as a fact or a result.

WRITING AND CLEANING RULES
- The publisher joins several small replies into one article. Never mention these instructions, the separate calls or the JSON format.
- Do not use double quotes, angle brackets, backslashes, bullet lists or line breaks inside a text value.
- Each request asks for one part of the article. Return exactly the JSON object that request asks for.`;

/** Formats a short list of real headlines for one call. */
function buildShortFactsBlock(facts, offset = 0, count = 2) {
  const list = Array.isArray(facts) ? facts.filter((item) => item && item.title) : [];
  if (list.length === 0) {
    return (
      'FACTS: this is an evergreen explainer, so no news is supplied.\n' +
      'Use well-established general knowledge about the subject. Do not name a specific news event, date, ' +
      'statistic, percentage, price, quote or test result.'
    );
  }

  const picked = [];
  for (let index = 0; index < Math.min(count, list.length); index++) {
    picked.push(list[(offset + index) % list.length]);
  }

  return (
    'FACTS (the ONLY factual material for this call):\n' +
    picked
      .map((item, index) => {
        const source = item.source ? ` [${item.source}${item.points ? `, ${item.points} points` : ''}]` : '';
        return `${index + 1}. ${item.title}${source}`;
      })
      .join('\n')
  );
}

function buildCategoryBlock(category) {
  return category
    ? `Category: ${category.label} - ${category.description}\nAudience: ${category.audience}`
    : 'Category: general web development and digital marketing.';
}

/** Call 1: metadata, lede and the heading outline. */
function buildPlanPrompt({ topic, category, facts, today, avoidImageQuery = '' }) {
  const imageRule = avoidImageQuery
    ? `- Do not reuse this Blogger image search phrase: "${avoidImageQuery}". Choose a different coverQuery.`
    : '- Choose a coverQuery that is different from a generic SEO headline.';

  return `TOPIC (use exactly this subject): ${topic}
TODAY (Asia/Kolkata): ${today}
${buildCategoryBlock(category)}

${buildShortFactsBlock(facts, 0, 2)}

Write only the outline and metadata for this first-person beginner explainer. Do not write the section paragraphs yet.

PLAN RULES
- title: at most 65 characters, in Title Case, clearly naming the subject so a beginner searching for it would click. A question (What Is ...?) or a How to ... title works well; a short friendly twist is fine. Correct grammar.
- metaDescription: 120 to 150 characters (never below 110), one or two plain sentences that say what the reader will learn.
- keywords: 4 to 6 short English phrases people would search.
- tag: 1 or 2 words for the card label.
- lede: 50 to 70 words, first person (I and you), tells the reader what I will explain and why it matters to them. Do not repeat the title.
- cardExcerpt: one sentence, maximum 140 characters.
- coverQuery: 2 or 3 plain English words describing a real photo scene, such as laptop analytics dashboard or woman working laptop. Never a metaphor word on its own (funnel, leak, rocket).
- coverAlt: one descriptive sentence, maximum 120 characters.
- sectionHeadings: exactly 4 or 5 short, distinct headings in sentence case that walk a beginner through the subject in a logical order, for example what it is, how it works, how to get started, mistakes to avoid, what I recommend. Do not repeat a heading and do not use "Takeaway" or "FAQ" as a heading.
${imageRule}

Reply with ONLY this JSON object:
{"title":"","metaDescription":"","keywords":["","","",""],"tag":"","lede":"","cardExcerpt":"","coverQuery":"","coverAlt":"","sectionHeadings":["","","",""]}`;
}

/** Calls 2-N: paragraphs for one or two sections. */
function buildSectionPrompt({
  topic,
  category,
  facts,
  factsOffset,
  title,
  lede,
  headings,
  startIndex,
  count,
  targetWords,
}) {
  const batch = headings.slice(startIndex, startIndex + count);
  const headingList = headings.map((heading, index) => `${index + 1}. ${heading}`).join('\n');
  const { lower, upper } = sectionWordRange(targetWords);
  const sectionNumbers = count > 1 ? `${startIndex + 1} to ${startIndex + count}` : `${startIndex + 1}`;
  const example = JSON.stringify({ sections: batch.map(() => ({ paragraphs: [''] })) });

  return `TOPIC: ${topic}
${buildCategoryBlock(category)}
TITLE: ${title}
LEDE (already written; do not repeat it): ${lede}

ALL SECTION HEADINGS (for context only; write just the requested sections):
${headingList}

${buildShortFactsBlock(facts, factsOffset, 2)}

Write the body paragraphs for section ${sectionNumbers}: ${batch.map((heading) => `"${heading}"`).join(', ')}.

BODY RULES
- Each requested section needs 1 to 3 plain paragraphs, preferably 2.
- Aim for about ${targetWords} words in EACH section. The hard limit is ${lower}-${upper} words; count the words before replying and do not go outside that range.
- Write in the first person as Chetna (I, my, me) and speak to the reader as you. Every section must contain at least one natural first-person sentence.
- Explain clearly for a beginner with correct, natural English. A simple everyday example helps.
- Continue naturally from the lede. Do not restate the lede.
- Do not repeat ideas, sentences or examples between the requested sections.
- Do not write the heading inside the paragraphs.
- Use only the facts above for any factual statement.
- No lists, markdown, HTML, emojis, double quotes, angle brackets or backslashes.

Reply with ONLY this JSON object:
${example}`;
}

/** Last call: the takeaway and FAQ items. */
function buildClosingPrompt({ topic, category, facts, factsOffset, title, lede, headings }) {
  const headingList = headings.map((heading, index) => `${index + 1}. ${heading}`).join('\n');

  return `TOPIC: ${topic}
${buildCategoryBlock(category)}
TITLE: ${title}
LEDE: ${lede}

SECTION HEADINGS (already written):
${headingList}

${buildShortFactsBlock(facts, factsOffset, 2)}

Write the closing pieces for this post.

CLOSING RULES
- takeaway: 1 or 2 plain sentences, about 25 to 50 words, first person, with one clear piece of advice for the reader.
- faq: 3 or 4 items. Each question must be a natural question a reader would ask. Each answer must be 1 or 2 sentences, about 20 to 45 words, and answerable from the facts above or the general subject.
- Do not repeat the lede or a section paragraph word for word.
- No lists, markdown, HTML, emojis, double quotes, angle brackets or backslashes.

Reply with ONLY this JSON object:
{"takeaway":"","faq":[{"q":"","a":""}]}`;
}

/** Decodes the few entities a model might put inside a JSON string. */
function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/** Clean plain text for the article body. HTML and markup are stripped. */
function plainText(value) {
  return decodeEntities(value)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Shorten on a word boundary so a title never ends mid-word. */
export function truncateAtWord(text, maxLength) {
  const value = String(text ?? '');
  if (value.length <= maxLength) return value;

  const cut = value.slice(0, maxLength + 1);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > maxLength * 0.6) return cut.slice(0, lastSpace).trim();
  return value.slice(0, maxLength).trim();
}

/**
 * Values that are used inside HTML attributes and inside JSON-LD get
 * the strict cleaning required by the project: & becomes "and", and
 * quotes, angle brackets, backslashes and newlines are removed.
 */
export function cleanAttributeValue(value, maxLength = 0) {
  let text = plainText(value)
    .replace(/&/g, 'and')
    .replace(/["<>\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (maxLength > 0) text = truncateAtWord(text, maxLength);
  return text;
}

/** Words in plain text, used for read time and the word-count check. */
export function countWords(text) {
  return plainText(text).split(/\s+/).filter(Boolean).length;
}

const PERSONAL_CLAIM_PATTERNS = [
  /\bI\s+(built|tested|measured|surveyed|ran|launched|shipped)\b/i,
  /\bmy\s+(client|clients|project|projects|agency|customers)\b/i,
  /\bwe\s+(built|tested|measured|surveyed|ran|launched|shipped)\b/i,
  /\bin\s+my\s+experience\b/i,
];

function findPersonalClaims(text) {
  const found = [];
  for (const pattern of PERSONAL_CLAIM_PATTERNS) {
    const match = String(text ?? '').match(pattern);
    if (match) found.push(match[0]);
  }
  return found;
}

/**
 * Turns the model JSON into clean values and a list of problems.
 * The caller retries once when the list is not empty.
 */
export function sanitizePortfolioArticle(raw) {
  const problems = [];
  const obj = raw && typeof raw === 'object' ? raw : {};

  const title = cleanAttributeValue(obj.title, 65);
  if (!title) problems.push('title is missing');

  const metaDescription = cleanAttributeValue(obj.metaDescription, 155);
  if (metaDescription.length < 110) {
    problems.push(`metaDescription is ${metaDescription.length} characters (need 110-155)`);
  }

  const keywords = [];
  const seenKeywords = new Set();
  for (const item of Array.isArray(obj.keywords) ? obj.keywords : []) {
    const keyword = cleanAttributeValue(item, 40);
    const key = keyword.toLowerCase();
    if (keyword && !seenKeywords.has(key)) {
      seenKeywords.add(key);
      keywords.push(keyword);
    }
  }
  if (keywords.length < 4 || keywords.length > 6) {
    problems.push(`keywords count is ${keywords.length} (need 4-6)`);
  }

  const tag = cleanAttributeValue(obj.tag, 30).split(/\s+/).filter(Boolean).slice(0, 2).join(' ');
  if (!tag) problems.push('tag is missing');

  const lede = plainText(obj.lede);
  if (!lede) problems.push('lede is missing');

  const sections = (Array.isArray(obj.sections) ? obj.sections : []).map((section) => ({
    heading: plainText(section?.heading),
    paragraphs: (Array.isArray(section?.paragraphs) ? section.paragraphs : [])
      .map(plainText)
      .filter(Boolean),
  }));

  if (sections.length < MIN_SECTIONS || sections.length > MAX_SECTIONS) {
    problems.push(`sections count is ${sections.length} (need ${MIN_SECTIONS}-${MAX_SECTIONS})`);
  }
  sections.forEach((section, index) => {
    if (!section.heading) problems.push(`section ${index + 1} has no heading`);
    if (section.paragraphs.length < 1 || section.paragraphs.length > 3) {
      problems.push(`section ${index + 1} has ${section.paragraphs.length} paragraphs (need 1-3)`);
    }
  });

  const takeaway = plainText(obj.takeaway);
  if (!takeaway) problems.push('takeaway is missing');

  const faq = (Array.isArray(obj.faq) ? obj.faq : []).map((item) => ({
    q: cleanAttributeValue(item?.q),
    a: cleanAttributeValue(item?.a),
  }));
  if (faq.length < MIN_FAQ || faq.length > MAX_FAQ) {
    problems.push(`FAQ count is ${faq.length} (need ${MIN_FAQ}-${MAX_FAQ})`);
  }
  faq.forEach((item, index) => {
    if (!item.q) problems.push(`FAQ ${index + 1} has no question`);
    if (!item.a) problems.push(`FAQ ${index + 1} has no answer`);
  });

  const cardExcerpt = cleanAttributeValue(obj.cardExcerpt, 140);
  if (!cardExcerpt) problems.push('cardExcerpt is missing');

  const coverQuery = cleanAttributeValue(obj.coverQuery, 60)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .join(' ');
  const coverQueryWords = coverQuery.split(/\s+/).filter(Boolean).length;
  if (coverQueryWords < 2) problems.push('coverQuery must be 2-3 English words');

  const coverAlt = cleanAttributeValue(obj.coverAlt, 120);
  if (!coverAlt) problems.push('coverAlt is missing');

  const wordCount =
    countWords(lede) +
    sections.reduce(
      (sum, section) => sum + section.paragraphs.reduce((inner, paragraph) => inner + countWords(paragraph), 0),
      0
    ) +
    countWords(takeaway);

  if (wordCount < MIN_WORDS || wordCount > MAX_WORDS) {
    problems.push(`article is ${wordCount} words (need ${MIN_WORDS}-${MAX_WORDS})`);
  }

  const allText = [
    title,
    metaDescription,
    lede,
    ...sections.flatMap((section) => [section.heading, ...section.paragraphs]),
    takeaway,
    ...faq.flatMap((item) => [item.q, item.a]),
  ].join(' ');
  const claims = findPersonalClaims(allText);
  if (claims.length > 0) {
    problems.push(`invented personal claims found: ${[...new Set(claims)].join(', ')}`);
  }

  return {
    problems,
    article: {
      title,
      metaDescription,
      keywords,
      tag,
      lede,
      sections,
      takeaway,
      faq,
      cardExcerpt,
      coverQuery,
      coverAlt,
      wordCount,
      readMinutes: Math.max(2, Math.ceil(wordCount / 200)),
    },
  };
}

/** Word range for one section; the prompt and the validator share it. */
function sectionWordRange(targetWords) {
  return { lower: Math.max(90, targetWords - 40), upper: targetWords + 60 };
}

/** Filler and hype phrases that make the post sound machine-written. */
const HYPE_PATTERN =
  /\b(game[- ]changer|unlock the power|delve|dive deep|revolutioni[sz]e|fast-paced world|ever-evolving landscape)\b/i;

/** True when the text speaks as Chetna (I, my, me). */
function hasFirstPerson(text) {
  return /\b(I|I'm|I've|I'd|I'll|my|me)\b/.test(String(text ?? ''));
}

function claimProblems(parts) {
  const text = parts.join(' ');
  const problems = [];
  const claims = findPersonalClaims(text);
  if (claims.length > 0) problems.push(`invented personal claims found: ${[...new Set(claims)].join(', ')}`);
  const hype = text.match(HYPE_PATTERN);
  if (hype) problems.push(`remove the filler phrase "${hype[0]}" and write plainly`);
  return problems;
}

/** Validates the outline and metadata reply. */
function validatePlanPart(raw) {
  const problems = [];
  const obj = raw && typeof raw === 'object' ? raw : {};

  const title = cleanAttributeValue(obj.title, 65);
  if (!title) problems.push('title is missing');

  const metaDescription = cleanAttributeValue(obj.metaDescription, 155);
  if (metaDescription.length < 110) {
    problems.push(`metaDescription is ${metaDescription.length} characters (need 110-155)`);
  }

  const keywords = [];
  const seenKeywords = new Set();
  for (const item of Array.isArray(obj.keywords) ? obj.keywords : []) {
    const keyword = cleanAttributeValue(item, 40);
    const key = keyword.toLowerCase();
    if (keyword && !seenKeywords.has(key)) {
      seenKeywords.add(key);
      keywords.push(keyword);
    }
  }
  if (keywords.length < 4) {
    problems.push(`keywords count is ${keywords.length} (need 4-6)`);
  }

  const tag = cleanAttributeValue(obj.tag, 30).split(/\s+/).filter(Boolean).slice(0, 2).join(' ');
  if (!tag) problems.push('tag is missing');

  const lede = plainText(obj.lede);
  const ledeWords = countWords(lede);
  if (!lede) problems.push('lede is missing');
  else if (ledeWords < 40 || ledeWords > 100) {
    problems.push(`lede is ${ledeWords} words (aim for 50-70)`);
  }
  if (lede && !hasFirstPerson(lede)) problems.push('lede must be written in the first person (I, my)');

  const cardExcerpt = cleanAttributeValue(obj.cardExcerpt, 140);
  if (!cardExcerpt) problems.push('cardExcerpt is missing');

  const coverQuery = cleanAttributeValue(obj.coverQuery, 60)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .join(' ');
  if (coverQuery.split(/\s+/).filter(Boolean).length < 2) {
    problems.push('coverQuery must be 2-3 English words');
  }

  const coverAlt = cleanAttributeValue(obj.coverAlt, 120);
  if (!coverAlt) problems.push('coverAlt is missing');

  const headings = [];
  const seenHeadings = new Set();
  for (const item of Array.isArray(obj.sectionHeadings) ? obj.sectionHeadings : []) {
    // Sentence case: the model sometimes returns headings all lowercase.
    const text = plainText(item);
    const heading = text.charAt(0).toUpperCase() + text.slice(1);
    const key = heading.toLowerCase();
    if (heading && !seenHeadings.has(key)) {
      seenHeadings.add(key);
      headings.push(heading);
    }
  }
  const sectionHeadings = headings.slice(0, MAX_SECTIONS);
  if (sectionHeadings.length < MIN_SECTIONS) {
    problems.push(
      `sectionHeadings count is ${sectionHeadings.length} (need ${MIN_SECTIONS}-${MAX_SECTIONS} distinct headings)`
    );
  }
  if (sectionHeadings.some((heading) => /^(takeaway|faq|frequently asked questions)$/i.test(heading))) {
    problems.push('sectionHeadings must not include Takeaway or FAQ');
  }

  problems.push(...claimProblems([title, metaDescription, lede, cardExcerpt, coverAlt, ...sectionHeadings]));

  return {
    problems,
    value: {
      title,
      metaDescription,
      keywords: keywords.slice(0, 6),
      tag,
      lede,
      cardExcerpt,
      coverQuery,
      coverAlt,
      sectionHeadings,
    },
  };
}

/** Validates the paragraphs for one batch of sections. */
function validateSectionPart(raw, { headings, targetWords, offset = 0 }) {
  const problems = [];
  const list = Array.isArray(raw?.sections) ? raw.sections : [];
  if (list.length !== headings.length) {
    problems.push(`expected ${headings.length} section bodies, got ${list.length}`);
  }

  const { lower, upper } = sectionWordRange(targetWords);
  const cleaned = list.slice(0, headings.length).map((section) => ({
    paragraphs: (Array.isArray(section?.paragraphs) ? section.paragraphs : []).map(plainText).filter(Boolean),
  }));

  cleaned.forEach((section, index) => {
    const number = offset + index + 1;
    if (section.paragraphs.length < 1 || section.paragraphs.length > 3) {
      problems.push(`section ${number} has ${section.paragraphs.length} paragraphs (need 1-3)`);
    }

    const words = section.paragraphs.reduce((sum, paragraph) => sum + countWords(paragraph), 0);
    if (words < lower || words > upper) {
      problems.push(`section ${number} is ${words} words (aim for ${targetWords}, stay within ${lower}-${upper})`);
    }
    if (words > 0 && !hasFirstPerson(section.paragraphs.join(' '))) {
      problems.push(`section ${number} has no first-person sentence; write it as Chetna (I, my)`);
    }
  });

  problems.push(...claimProblems(cleaned.flatMap((section) => section.paragraphs)));

  return {
    problems,
    value: cleaned.map((section, index) => ({
      heading: headings[index],
      paragraphs: section.paragraphs,
    })),
  };
}

/** Validates the takeaway and FAQ reply. */
function validateClosingPart(raw) {
  const problems = [];
  const takeaway = plainText(raw?.takeaway);
  const takeawayWords = countWords(takeaway);
  if (!takeaway) problems.push('takeaway is missing');
  else if (takeawayWords < 15 || takeawayWords > 80) {
    problems.push(`takeaway is ${takeawayWords} words (aim for 25-50)`);
  }

  const faq = (Array.isArray(raw?.faq) ? raw.faq : []).slice(0, MAX_FAQ).map((item) => ({
    q: cleanAttributeValue(item?.q),
    a: cleanAttributeValue(item?.a),
  }));

  if (faq.length < MIN_FAQ) {
    problems.push(`FAQ count is ${faq.length} (need ${MIN_FAQ}-${MAX_FAQ})`);
  }
  faq.forEach((item, index) => {
    if (!item.q) problems.push(`FAQ ${index + 1} has no question`);
    if (!item.a) {
      problems.push(`FAQ ${index + 1} has no answer`);
      return;
    }
    const words = countWords(item.a);
    if (words < 8 || words > 80) {
      problems.push(`FAQ ${index + 1} answer is ${words} words (aim for 20-45)`);
    }
  });

  problems.push(...claimProblems([takeaway, ...faq.flatMap((item) => [item.q, item.a])]));

  return { problems, value: { takeaway, faq } };
}

function createCallCounter() {
  let count = 0;
  return () => {
    count += 1;
    return count;
  };
}

function wordCountWithinTolerance(wordCount) {
  const minimum = Math.floor(MIN_WORDS * (1 - WORD_COUNT_TOLERANCE));
  const maximum = Math.ceil(MAX_WORDS * (1 + WORD_COUNT_TOLERANCE));
  return wordCount >= minimum && wordCount <= maximum;
}

function acceptToleratedWordCount(article, problems) {
  if (problems.length !== 1 || !/^article is \d+ words/.test(problems[0])) return false;
  if (!wordCountWithinTolerance(article.wordCount)) return false;

  const minimum = Math.floor(MIN_WORDS * (1 - WORD_COUNT_TOLERANCE));
  const maximum = Math.ceil(MAX_WORDS * (1 + WORD_COUNT_TOLERANCE));
  console.warn(
    `[portfolio] Word count ${article.wordCount} is outside ${MIN_WORDS}-${MAX_WORDS} ` +
      `but within the ${Math.round(WORD_COUNT_TOLERANCE * 100)}% tolerance (${minimum}-${maximum}); ` +
      'accepting it with a warning.'
  );
  return true;
}

/**
 * One small JSON call with its own retry. A rejected piece is rewritten
 * alone instead of regenerating the whole article.
 */
async function requestPortfolioJson({
  label,
  user,
  temperature = 0.7,
  maxTokens,
  validate,
  nextCallNumber,
  maxAttempts = 2,
}) {
  let problems = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const retryNote =
      attempt === 1
        ? ''
        : `\n\nYour previous answer was rejected: ${problems.join('; ')}. ` +
          'Fix these problems and return only the corrected JSON object.';

    const pauseMs = await waitForRateLimit();
    if (pauseMs > 0) {
      console.log(`[portfolio] Paused ${(pauseMs / 1000).toFixed(1)}s between Groq calls for the token window.`);
    }

    const callNumber = nextCallNumber();
    const startedAt = Date.now();
    let usage = null;

    try {
      const raw = await chat(
        [
          { role: 'system', content: PORTFOLIO_PROMPT },
          { role: 'user', content: user + retryNote },
        ],
        {
          json: true,
          temperature,
          maxTokens,
          onUsage: (value) => {
            usage = value;
          },
        }
      );

      const parsed = extractJson(raw);
      if (!parsed) {
        problems = ['reply was not a valid JSON object'];
        console.warn(`[portfolio] ${label} attempt ${attempt}/${maxAttempts}: reply was not valid JSON. Retrying...`);
        continue;
      }

      const result = validate(parsed);
      if (result.problems.length === 0) return result.value;

      problems = result.problems;
      console.warn(`[portfolio] ${label} attempt ${attempt}/${maxAttempts} rejected: ${problems.join('; ')}`);
    } finally {
      const elapsedMs = Date.now() - startedAt;
      const outputTokens = Number.isFinite(usage?.completion_tokens) ? usage.completion_tokens : 'unknown';
      console.log(
        `[portfolio] Groq call #${callNumber} (${label}) finished in ${elapsedMs} ms; ` +
          `output tokens: ${outputTokens}.`
      );
    }
  }

  throw new Error(`${label} failed validation after ${maxAttempts} attempts: ${problems.join('; ')}`);
}

/** Rough output-token request for a planned word count, plus JSON overhead. */
function neededOutputTokens(words, overhead = 100) {
  return Math.ceil(words * 1.4) + overhead + 40;
}

/**
 * One section per call. A 2-section batch is cheaper when the model complies,
 * but in practice it often returns only the first section and fails validation.
 */
function planSectionCallSize({ targetWords, budget }) {
  const one = neededOutputTokens(targetWords, 110);

  if (one > budget * 0.7) {
    throw new Error(
      `Groq allows ${budget} output tokens per reply, which is too small for a ${targetWords}-word section without truncation.`
    );
  }
  return 1;
}

function computeSectionTarget(sectionCount, ledeWords) {
  const available = TARGET_ARTICLE_WORDS - ledeWords - TAKEAWAY_RESERVE;
  return Math.max(140, Math.min(170, Math.round(available / sectionCount)));
}

/** Writes all section bodies in small batches that fit the detected budget. */
async function generateSectionBodies({
  topic,
  category,
  facts,
  title,
  lede,
  headings,
  targetWords,
  nextCallNumber,
  label = 'section',
}) {
  const sections = [];
  let start = 0;
  let batchIndex = 0;

  while (start < headings.length) {
    const liveBudget = await getOutputTokenBudget();
    const batchSize = planSectionCallSize({ targetWords, budget: liveBudget });
    const count = Math.min(batchSize, headings.length - start);
    const batchHeadings = headings.slice(start, start + count);
    const maxTokens = neededOutputTokens(targetWords * count, 110);

    const value = await requestPortfolioJson({
      label: `${label} ${batchIndex + 1}`,
      user: buildSectionPrompt({
        topic,
        category,
        facts,
        factsOffset: batchIndex * 2,
        title,
        lede,
        headings,
        startIndex: start,
        count,
        targetWords,
      }),
      temperature: 0.7,
      maxTokens,
      nextCallNumber,
      maxAttempts: 4,
      validate: (raw) =>
        validateSectionPart(raw, {
          headings: batchHeadings,
          targetWords,
          offset: start,
        }),
    });

    sections.push(...value);
    start += count;
    batchIndex++;
  }

  return sections;
}

/**
 * Asks Groq for the reflective article in several small calls, then merges
 * them into the same object the renderer, image finder and commit code
 * already expect. Never receives the Blogger article.
 *
 * `model` is optional. When set, only this article's Groq calls use it;
 * the Blogger step keeps using GROQ_MODEL.
 */
export async function generatePortfolioArticle({ model, ...options }) {
  const selectedModel = model === undefined ? process.env.PORTFOLIO_GROQ_MODEL : model;
  return withModel(selectedModel, () => writePortfolioArticle(options));
}

async function writePortfolioArticle({ topic, category, facts, today, avoidImageQuery = '' }) {
  const budget = await getOutputTokenBudget();
  const nextCallNumber = createCallCounter();
  const planTokens = neededOutputTokens(200, 120);

  if (planTokens > budget * 0.7) {
    throw new Error(
      `Groq allows ${budget} output tokens per reply, which is too small for the portfolio outline call. ` +
        'Use a model with a larger output limit or lower the article requirements.'
    );
  }

  const plan = await requestPortfolioJson({
    label: 'plan call',
    user: buildPlanPrompt({ topic, category, facts, today, avoidImageQuery }),
    temperature: 0.6,
    maxTokens: planTokens,
    nextCallNumber,
    validate: validatePlanPart,
  });

  const sectionCount = plan.sectionHeadings.length;
  const targetWords = computeSectionTarget(sectionCount, countWords(plan.lede));
  const batchSize = planSectionCallSize({ targetWords, budget });

  console.log(
    `[portfolio] Groq output budget: ${budget} tokens per reply; ` +
      `writing ${sectionCount} sections of about ${targetWords} words in batches of ${batchSize}.`
  );

  let sections = await generateSectionBodies({
    topic,
    category,
    facts,
    title: plan.title,
    lede: plan.lede,
    headings: plan.sectionHeadings,
    targetWords,
    nextCallNumber,
    label: 'section call',
  });

  const closingTokens = neededOutputTokens(220, 100);
  if (closingTokens > budget * 0.7) {
    throw new Error(
      `Groq allows ${budget} output tokens per reply, which is too small for the takeaway and FAQ call.`
    );
  }

  const closing = await requestPortfolioJson({
    label: 'closing call',
    user: buildClosingPrompt({
      topic,
      category,
      facts,
      factsOffset: sectionCount * 2,
      title: plan.title,
      lede: plan.lede,
      headings: plan.sectionHeadings,
    }),
    temperature: 0.6,
    maxTokens: closingTokens,
    nextCallNumber,
    validate: validateClosingPart,
  });

  const raw = {
    title: plan.title,
    metaDescription: plan.metaDescription,
    keywords: plan.keywords,
    tag: plan.tag,
    lede: plan.lede,
    sections,
    takeaway: closing.takeaway,
    faq: closing.faq,
    cardExcerpt: plan.cardExcerpt,
    coverQuery: plan.coverQuery,
    coverAlt: plan.coverAlt,
  };

  const first = sanitizePortfolioArticle(raw);
  if (first.problems.length === 0) return first.article;
  if (acceptToleratedWordCount(first.article, first.problems)) return first.article;

  const onlyWordCount = first.problems.length === 1 && /^article is \d+ words/.test(first.problems[0]);
  if (!onlyWordCount) {
    throw new Error(`Portfolio article failed validation: ${first.problems.join('; ')}`);
  }

  const currentWords = first.article.wordCount;
  const sectionWords = first.article.sections.reduce(
    (total, section) => total + section.paragraphs.reduce((inner, paragraph) => inner + countWords(paragraph), 0),
    0
  );
  const fixedWords = currentWords - sectionWords;
  const requestedSectionWords = targetWords * sectionCount;
  const modelBias =
    requestedSectionWords > 0 && sectionWords > 0
      ? Math.min(1.35, Math.max(0.75, sectionWords / requestedSectionWords))
      : 1;
  const repairedTarget = Math.max(
    100,
    Math.min(190, Math.round((TARGET_ARTICLE_WORDS - fixedWords) / sectionCount / modelBias))
  );

  console.warn(
    `[portfolio] The assembled article is ${currentWords} words (need ${MIN_WORDS}-${MAX_WORDS}). ` +
      `Regenerating the sections at about ${repairedTarget} words each...`
  );

  sections = await generateSectionBodies({
    topic,
    category,
    facts,
    title: plan.title,
    lede: plan.lede,
    headings: plan.sectionHeadings,
    targetWords: repairedTarget,
    nextCallNumber,
    label: 'section repair',
  });

  const second = sanitizePortfolioArticle({ ...raw, sections });
  if (second.problems.length === 0) return second.article;
  if (acceptToleratedWordCount(second.article, second.problems)) return second.article;

  throw new Error(
    `Portfolio article failed validation after the word-count repair: ${second.problems.join('; ')}`
  );
}

/** LEDE_HTML is just the escaped lede; the template supplies its wrapper. */
export function buildLedeHtml(article) {
  return escapeHtml(article.lede);
}

/** CONTENT_HTML: only h2, p, strong, a and the closing div.box. */
export function buildContentHtml(article) {
  const parts = [];

  for (const section of article.sections) {
    parts.push(`<h2>${escapeHtml(section.heading)}</h2>`);
    for (const paragraph of section.paragraphs) {
      parts.push(`<p>${escapeHtml(paragraph)}</p>`);
    }
  }

  parts.push('<h2>Takeaway</h2>');
  parts.push(`<p>${escapeHtml(article.takeaway)}</p>`);
  parts.push(
    '<div class="box">I am <strong>Chetna Ravish</strong>, a web developer and digital marketer from Kaithal. ' +
      'See my work in the <a class="box-link" href="portfolio.html#work">Projects section</a> or ' +
      '<a class="box-link" href="portfolio.html#contact">get in touch</a>.</div>'
  );

  return parts.join('\n');
}

/** FAQ_HTML uses exactly the markup the site's accordion expects. */
export function buildFaqHtml(article) {
  return article.faq
    .map(
      (item, index) =>
        `<div class="faq-item"><button type="button" class="faq-q" id="faq-q-${index}" aria-expanded="false" aria-controls="faq-a-${index}"><span>${escapeHtml(item.q)}</span><span class="faq-ico" aria-hidden="true"></span></button><div class="faq-a" id="faq-a-${index}" role="region" aria-labelledby="faq-q-${index}"><div class="faq-a-inner"><p>${escapeHtml(item.a)}</p></div></div></div>`
    )
    .join('\n');
}

/** FAQ_JSONLD_ITEMS is a comma-separated list of Question objects. */
export function buildFaqJsonLd(article) {
  return article.faq
    .map((item) =>
      JSON.stringify({
        '@type': 'Question',
        name: item.q,
        acceptedAnswer: { '@type': 'Answer', text: item.a },
      })
    )
    .join(',');
}

/** Replaces every {{NAME}} occurrence in one pass, not just the first one. */
export function renderTemplate(template, values) {
  return String(template ?? '').replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name] ?? '') : match
  );
}

/** "blog-" + ascii slug, lowercase a-z/0-9/hyphens, max 60 chars. */
export function asciiSlug(text, maxLength = 60) {
  let slug = String(text ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!slug) slug = 'post';
  if (maxLength > 0 && slug.length > maxLength) {
    slug = slug.slice(0, maxLength).replace(/-+$/g, '');
  }
  return slug;
}

/**
 * The output file name. A date suffix is used when the plain slug is
 * already taken; the whole result still stays within 60 characters.
 */
export function buildPostSlug(title, { suffix = '' } = {}) {
  const baseMax = suffix ? Math.max(10, 60 - 5 - 1 - suffix.length) : 55;
  const base = asciiSlug(title, baseMax);
  return `blog-${base}${suffix ? `-${suffix}` : ''}`;
}

/** "2026-10-22" -> "Oct 22, 2026". */
export function formatDisplayDate(dateIso) {
  const [year, month, day] = String(dateIso ?? '').split('-').map(Number);
  if (!year || !month || !day || !MONTHS[month - 1]) return String(dateIso ?? '');
  return `${MONTHS[month - 1]} ${day}, ${year}`;
}

function newlineOf(text) {
  return String(text).includes('\r\n') ? '\r\n' : '\n';
}

function dedent(text) {
  const lines = String(text).split(/\r?\n/);
  const indents = lines
    .filter((line) => line.trim())
    .map((line) => (line.match(/^[ \t]*/) ?? [''])[0].length);
  const minimum = indents.length > 0 ? Math.min(...indents) : 0;
  return lines.map((line) => (line.trim() ? line.slice(minimum) : line)).join('\n');
}

/**
 * Inserts a rendered card immediately after the marker line, using the
 * indentation of the first existing card. The marker itself is kept.
 */
export function insertCard(blogHtml, cardHtml) {
  const newline = newlineOf(blogHtml);
  const lines = String(blogHtml).split(/\r?\n/);
  const markerIndex = lines.findIndex((line) => line.includes(CARD_MARKER));

  if (markerIndex === -1) {
    throw new Error(`public/blog.html is missing the required ${CARD_MARKER} marker.`);
  }

  const nextCardLine = lines.slice(markerIndex + 1).find((line) => line.trim()) ?? '';
  const indent =
    (nextCardLine.match(/^[ \t]*/) ?? [''])[0] ||
    (lines[markerIndex].match(/^[ \t]*/) ?? [''])[0];
  const cardLines = dedent(String(cardHtml).trim())
    .split(/\r?\n/)
    .map((line) => (line ? indent + line : line));

  lines.splice(markerIndex + 1, 0, ...cardLines);
  return lines.join(newline);
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Inserts the new <url> block before the sitemap marker, matching the
 * marker's indentation and keeping the marker line.
 */
export function insertSitemapEntry(xml, canonicalUrl, dateIso) {
  const source = String(xml);
  const newline = newlineOf(source);
  const markerPattern = /^([ \t]*)<!-- BLOG_SITEMAP_INSERT -->[ \t]*(?=\r?$)/m;
  const match = source.match(markerPattern);

  if (!match) {
    throw new Error(`public/sitemap.xml is missing the required ${SITEMAP_MARKER} marker.`);
  }

  const markerIndent = match[1];
  const firstUrl = source.match(/^([ \t]*)<url>([\s\S]*?)<\/url>/m);
  const entryIndent = firstUrl ? firstUrl[1] : markerIndent;
  const multiline = Boolean(firstUrl && /[\r\n]/.test(firstUrl[2]));
  const childMatch = firstUrl ? firstUrl[2].match(/\r?\n([ \t]*)</) : null;
  const childIndent = childMatch ? childMatch[1] : `${entryIndent}  `;

  const loc = escapeXml(canonicalUrl);
  const block = multiline
    ? [
        `${entryIndent}<url>`,
        `${childIndent}<loc>${loc}</loc>`,
        `${childIndent}<lastmod>${dateIso}</lastmod>`,
        `${childIndent}<changefreq>monthly</changefreq>`,
        `${childIndent}<priority>0.8</priority>`,
        `${entryIndent}</url>`,
      ].join(newline)
    : `${entryIndent}<url><loc>${loc}</loc><lastmod>${dateIso}</lastmod>` +
      '<changefreq>monthly</changefreq><priority>0.8</priority></url>';

  return source.replace(
    markerPattern,
    () => `${block}${newline}${markerIndent}<!-- BLOG_SITEMAP_INSERT -->`
  );
}

/** Best effort: update /blog.html's own lastmod, if it has one. */
export function updateBlogLastmod(xml, dateIso) {
  try {
    return String(xml).replace(/<url\b[\s\S]*?<\/url>/g, (block) => {
      if (/<loc>\s*[^<]*\/blog\.html\s*<\/loc>/.test(block)) {
        return block.replace(/<lastmod>[^<]*<\/lastmod>/, `<lastmod>${dateIso}</lastmod>`);
      }
      return block;
    });
  } catch (error) {
    console.warn(`[portfolio] Could not update blog.html lastmod: ${error.message}`);
    return String(xml);
  }
}

function setAllPresent(object, keys, value) {
  let changed = false;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(object, key)) {
      object[key] = value;
      changed = true;
    }
  }
  return changed;
}

/** Fills a sample value's shape with the new image URL. */
function shapeImageValue(value, imageUrl) {
  if (typeof value === 'string') return imageUrl;
  if (Array.isArray(value)) return value.length > 0 ? [shapeImageValue(value[0], imageUrl)] : [imageUrl];
  if (value && typeof value === 'object') {
    const copy = JSON.parse(JSON.stringify(value));
    const changed = setAllPresent(copy, ['url', 'contentUrl', '@id'], imageUrl);
    if (!changed) copy.url = imageUrl;
    return copy;
  }
  return imageUrl;
}

/**
 * Best-effort JSON-LD update for public/blog.html.
 *
 * It clones the first existing blogPost entry (so the field shape is
 * identical), overwrites the obvious fields, prepends the new entry,
 * and re-parses every JSON-LD block afterwards. Any problem returns the
 * original HTML untouched and a warning for the caller to log.
 */
export function updateBlogJsonLd(blogHtml, data) {
  const blockPattern = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const newline = newlineOf(blogHtml);
  let updated = false;
  let warning = '';
  let lastError = '';

  const changed = String(blogHtml).replace(blockPattern, (whole, inner) => {
    if (updated) return whole;

    let parsed;
    try {
      parsed = JSON.parse(inner.trim());
    } catch {
      return whole; // leave unrelated/broken blocks exactly as they were
    }

    const blog = Array.isArray(parsed)
      ? parsed.find(
          (entry) =>
            entry &&
            (entry['@type'] === 'Blog' ||
              (Array.isArray(entry['@type']) && entry['@type'].includes('Blog')))
        )
      : parsed;

    if (!blog || !Array.isArray(blog.blogPost)) return whole;

    try {
      const sample = blog.blogPost[0];
      const entry = sample
        ? JSON.parse(JSON.stringify(sample))
        : {
            '@type': 'BlogPosting',
            headline: data.title,
            description: data.metaDescription,
            url: data.canonicalUrl,
            datePublished: data.dateIso,
          };

      if (!entry['@type']) entry['@type'] = 'BlogPosting';
      setAllPresent(entry, ['headline', 'name'], data.title);
      setAllPresent(entry, ['description'], data.metaDescription);
      setAllPresent(entry, ['url', '@id'], data.canonicalUrl);
      setAllPresent(entry, ['datePublished', 'dateModified'], data.dateIso);
      setAllPresent(entry, ['keywords'], data.keywords);
      setAllPresent(entry, ['articleSection'], data.tag);

      if (Object.prototype.hasOwnProperty.call(entry, 'image')) {
        entry.image = shapeImageValue(entry.image, data.coverImageUrl);
      }
      if (Object.prototype.hasOwnProperty.call(entry, 'mainEntityOfPage')) {
        entry.mainEntityOfPage =
          entry.mainEntityOfPage && typeof entry.mainEntityOfPage === 'object'
            ? { ...entry.mainEntityOfPage, '@id': data.canonicalUrl }
            : data.canonicalUrl;
      }

      blog.blogPost.unshift(entry);

      const opening = whole.slice(0, whole.indexOf(inner));
      const closing = whole.slice(whole.indexOf(inner) + inner.length);
      updated = true;
      return (
        `${opening}${newline}${JSON.stringify(parsed, null, 2).replace(/\n/g, newline)}` +
        `${newline}${closing}`
      );
    } catch (error) {
      lastError = error.message;
      return whole;
    }
  });

  if (!updated) {
    return {
      html: blogHtml,
      warning: warning || lastError || 'no Blog JSON-LD block with a blogPost array was found',
    };
  }

  // Re-validate every JSON-LD block. If one now fails, keep the original.
  const checkPattern = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = checkPattern.exec(changed)) !== null) {
    try {
      JSON.parse(match[1].trim());
    } catch (error) {
      return {
        html: blogHtml,
        warning: `JSON-LD validation failed after the update, so the block was left untouched: ${error.message}`,
      };
    }
  }

  return { html: changed, warning };
}

/**
 * Checks the finished post before anything is committed. Returns a list
 * of problems; an empty list means it is safe to publish.
 */
export function validateRenderedPost(html) {
  const problems = [];
  const value = String(html ?? '');

  if (value.includes('{{')) problems.push('an unreplaced {{PLACEHOLDER}} remains');
  if (/(?:>|=["'])\s*(?:undefined|null)\s*(?:<|["'])/i.test(value)) {
    problems.push('the rendered HTML contains undefined or null');
  }

  const jsonLdPattern = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let block = 0;
  let match;
  while ((match = jsonLdPattern.exec(value)) !== null) {
    block++;
    try {
      JSON.parse(match[1].trim());
    } catch (error) {
      problems.push(`JSON-LD block ${block} does not parse: ${error.message}`);
    }
  }
  if (block === 0) problems.push('no JSON-LD block was found');

  const title = value.match(/<title>([\s\S]*?)<\/title>/i);
  if (!title || !title[1].trim()) problems.push('the <title> is missing or empty');

  const canonical =
    /<link\b[^>]*rel=["']canonical["'][^>]*href=["'][^"']+["'][^>]*>/i.test(value) ||
    /<link\b[^>]*href=["'][^"']+["'][^>]*rel=["']canonical["'][^>]*>/i.test(value);
  if (!canonical) problems.push('the canonical link is missing');

  const ogTitle =
    /<meta\b[^>]*(?:property|name)=["']og:title["'][^>]*content=["'][^"']+["'][^>]*>/i.test(value) ||
    /<meta\b[^>]*content=["'][^"']+["'][^>]*(?:property|name)=["']og:title["'][^>]*>/i.test(value);
  if (!ogTitle) problems.push('og:title is missing');

  const ogImage =
    /<meta\b[^>]*(?:property|name)=["']og:image["'][^>]*content=["'][^"']+["'][^>]*>/i.test(value) ||
    /<meta\b[^>]*content=["'][^"']+["'][^>]*(?:property|name)=["']og:image["'][^>]*>/i.test(value);
  if (!ogImage) problems.push('og:image is missing');

  return problems;
}

/** Reads the branch head, the tree and every file the publish needs. */
async function readState(client) {
  const commitSha = await client.getHeadCommit();
  const { treeSha } = await client.getCommit(commitSha);
  const { paths, truncated } = await client.getTreePaths(treeSha);

  const readRequired = async (filePath) => {
    const text = await client.readOptionalTextFile(filePath, commitSha);
    if (text === null) {
      throw new Error(`The portfolio repo is missing ${filePath} on branch "${client.branch}".`);
    }
    return text;
  };

  const [postTemplate, cardTemplate, blogHtml, sitemap, publishedRaw] = await Promise.all([
    readRequired(POST_TEMPLATE_PATH),
    readRequired(CARD_TEMPLATE_PATH),
    readRequired(BLOG_PATH),
    readRequired(SITEMAP_PATH),
    client.readOptionalTextFile(PUBLISHED_PATH, commitSha),
  ]);

  if (!String(blogHtml).split(/\r?\n/).some((line) => line.includes(CARD_MARKER))) {
    throw new Error(`public/blog.html has no ${CARD_MARKER} marker. Portfolio publish aborted.`);
  }
  if (!String(sitemap).includes(SITEMAP_MARKER)) {
    throw new Error(`public/sitemap.xml has no ${SITEMAP_MARKER} marker. Portfolio publish aborted.`);
  }

  let publishedEntries = [];
  if (publishedRaw && publishedRaw.trim()) {
    try {
      const parsed = JSON.parse(publishedRaw);
      if (!Array.isArray(parsed)) throw new Error('the file is not an array');
      publishedEntries = parsed;
    } catch (error) {
      throw new Error(`automation/published-posts.json is not a valid JSON array: ${error.message}`);
    }
  }

  return {
    commitSha,
    treeSha,
    paths,
    truncated,
    postTemplate,
    cardTemplate,
    blogHtml,
    sitemap,
    publishedEntries,
  };
}

async function pathExists(client, state, filePath) {
  if (state.paths.has(filePath)) return true;
  if (!state.truncated) return false;
  return client.fileExists(filePath, state.commitSha);
}

/** Returns a skip reason, or '' when the publish may continue. */
function duplicateReason(entries, { today, topicKey, force }) {
  if (!force && entries.some((entry) => entry?.date === today)) {
    return `a portfolio post for ${today} already exists (set PORTFOLIO_FORCE=true to override)`;
  }
  if (topicKey && entries.some((entry) => String(entry?.topicKey ?? '') === topicKey)) {
    return `the topic was already published to the portfolio ("${topicKey}")`;
  }
  return '';
}

/** Parses a YYYY-MM-DD date as UTC midnight, or null when invalid. */
function parseIsoDate(value) {
  const text = String(value ?? '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const time = Date.UTC(year, month - 1, day);
  const date = new Date(time);

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return time;
}

/** Calendar days between two IST dates, or null when either is invalid. */
function daysBetweenIso(fromIso, toIso) {
  const from = parseIsoDate(fromIso);
  const to = parseIsoDate(toIso);
  if (from === null || to === null) return null;
  return Math.round((to - from) / 86400000);
}

/** Adds whole days to a YYYY-MM-DD date. */
function addDaysIso(dateIso, days) {
  const time = parseIsoDate(dateIso);
  if (time === null) return '';
  return new Date(time + days * 86400000).toISOString().slice(0, 10);
}

/** Newest valid date in published-posts.json, or '' when there is none. */
function newestPublishedDate(entries) {
  if (!Array.isArray(entries)) return '';
  let newest = '';
  for (const entry of entries) {
    const date = String(entry?.date ?? '').trim();
    if (parseIsoDate(date) === null) continue;
    if (!newest || date > newest) newest = date;
  }
  return newest;
}

/**
 * Decides whether the portfolio interval allows another post.
 *
 * The newest date in published-posts.json is the source of truth. Dates are
 * IST calendar dates, so a simple UTC date-only difference is exact.
 *
 * - PORTFOLIO_FORCE=true bypasses the interval.
 * - A manual publish (npm run portfolio:publish) bypasses the interval.
 * - A manual dry run (npm run portfolio:dry) warns but never blocks.
 * - Scheduled runs, including scheduled dry runs, block when it is too soon.
 */
export function checkPortfolioInterval(
  entries,
  { today, intervalDays = 3, force = false, manual = false, dryRun = false } = {}
) {
  const interval = Number.isInteger(intervalDays) && intervalDays > 0 ? intervalDays : 3;
  const lastDate = newestPublishedDate(entries);
  const nextAllowedDate = lastDate ? addDaysIso(lastDate, interval) : '';
  const daysSinceLast = lastDate ? daysBetweenIso(lastDate, today) : null;

  if (force) {
    return {
      allowed: true,
      reason: 'force',
      lastDate,
      nextAllowedDate,
      daysSinceLast,
      message: '',
      warning: '',
    };
  }

  if (manual && !dryRun) {
    return {
      allowed: true,
      reason: 'manual',
      lastDate,
      nextAllowedDate,
      daysSinceLast,
      message: '',
      warning: '',
    };
  }

  if (!lastDate) {
    return {
      allowed: true,
      reason: 'first-post',
      lastDate: '',
      nextAllowedDate: '',
      daysSinceLast: null,
      message: '',
      warning: '',
    };
  }

  if (daysSinceLast === null) {
    return {
      allowed: true,
      reason: 'invalid-date',
      lastDate,
      nextAllowedDate,
      daysSinceLast: null,
      message: '',
      warning: '',
    };
  }

  if (daysSinceLast >= interval) {
    return {
      allowed: true,
      reason: 'allowed',
      lastDate,
      nextAllowedDate,
      daysSinceLast,
      message: '',
      warning: '',
    };
  }

  const message = `last post was on ${lastDate}, next allowed on ${nextAllowedDate}`;

  if (manual && dryRun) {
    return {
      allowed: true,
      reason: 'dry-run-warning',
      lastDate,
      nextAllowedDate,
      daysSinceLast,
      message,
      warning: `${message}; dry run, continuing anyway`,
    };
  }

  return {
    allowed: false,
    reason: 'too-soon',
    lastDate,
    nextAllowedDate,
    daysSinceLast,
    message,
    warning: '',
  };
}

/**
 * Builds every file for one publish. Re-run on a branch-moved retry so
 * blog.html, the sitemap and published-posts.json are based on the
 * newest branch state.
 */
async function prepareUpdates({ client, state, article, photos, config, today, topicKey, category }) {
  const baseSlug = buildPostSlug(article.title);
  let slug = baseSlug;

  if (await pathExists(client, state, `public/${slug}.html`)) {
    slug = buildPostSlug(article.title, { suffix: today.replace(/-/g, '') });
    if (await pathExists(client, state, `public/${slug}.html`)) {
      throw new Error(
        `Both public/${baseSlug}.html and public/${slug}.html already exist. Refusing to overwrite a portfolio post.`
      );
    }
  }

  const coverRelative = `assets/blog/${slug}-cover.webp`;
  const cardRelative = `assets/blog/${slug}-card.webp`;
  const coverRepoPath = `public/${coverRelative}`;
  const cardRepoPath = `public/${cardRelative}`;

  for (const assetPath of [coverRepoPath, cardRepoPath]) {
    if (await pathExists(client, state, assetPath)) {
      throw new Error(`Portfolio asset already exists: ${assetPath}. Refusing to overwrite it.`);
    }
  }

  const siteUrl = config.portfolioSiteUrl.replace(/\/+$/, '');
  const canonicalUrl = `${siteUrl}/${slug}.html`;
  const coverImageUrl = `${siteUrl}/${coverRelative}`;
  const dateDisplay = formatDisplayDate(today);

  const postValues = {
    TITLE: article.title,
    META_DESCRIPTION: article.metaDescription,
    KEYWORDS: article.keywords.join(', '),
    CANONICAL_URL: canonicalUrl,
    COVER_IMAGE_URL: coverImageUrl,
    DATE_ISO: today,
    DATE_MODIFIED: today,
    TAG: article.tag,
    DATE_DISPLAY: dateDisplay,
    READ_MINUTES: String(article.readMinutes),
    COVER_IMAGE_PATH: coverRelative,
    COVER_ALT: article.coverAlt,
    LEDE_HTML: buildLedeHtml(article),
    CONTENT_HTML: buildContentHtml(article),
    FAQ_HTML: buildFaqHtml(article),
    FAQ_JSONLD_ITEMS: buildFaqJsonLd(article),
  };

  const postHtml = renderTemplate(state.postTemplate, postValues);
  const postProblems = validateRenderedPost(postHtml);
  if (postProblems.length > 0) {
    throw new Error(`Rendered portfolio post failed checks: ${postProblems.join('; ')}`);
  }

  const cardValues = {
    SLUG: slug,
    TAG: article.tag,
    TITLE: article.title,
    EXCERPT: article.cardExcerpt,
    DATE_DISPLAY: dateDisplay,
    READ_MINUTES: String(article.readMinutes),
    CARD_IMAGE_PATH: cardRelative,
    CARD_ALT: article.coverAlt,
  };

  const cardHtml = renderTemplate(state.cardTemplate, cardValues);
  if (cardHtml.includes('{{')) {
    throw new Error('The portfolio card template still has an unknown {{PLACEHOLDER}}.');
  }
  if (!cardHtml.includes(`${slug}.html`)) {
    throw new Error(
      `The portfolio card template does not link to "${slug}.html". The card must include the post file name with .html.`
    );
  }

  let blogHtml = insertCard(state.blogHtml, cardHtml);
  const jsonLd = updateBlogJsonLd(blogHtml, {
    title: article.title,
    metaDescription: article.metaDescription,
    canonicalUrl,
    coverImageUrl,
    dateIso: today,
    tag: article.tag,
    keywords: article.keywords.join(', '),
  });
  if (jsonLd.warning) console.warn(`[portfolio] Blog JSON-LD update skipped: ${jsonLd.warning}`);
  blogHtml = jsonLd.html;

  let sitemap = insertSitemapEntry(state.sitemap, canonicalUrl, today);
  sitemap = updateBlogLastmod(sitemap, today);

  const publishedEntries = [
    ...state.publishedEntries,
    { date: today, topicKey, category: category?.id ?? '', slug, title: article.title },
  ];
  const publishedJson = `${JSON.stringify(publishedEntries, null, 2)}\n`;

  const files = [
    { path: `public/${slug}.html`, content: postHtml, encoding: 'utf-8', binary: false },
    { path: BLOG_PATH, content: blogHtml, encoding: 'utf-8', binary: false },
    { path: SITEMAP_PATH, content: sitemap, encoding: 'utf-8', binary: false },
    { path: PUBLISHED_PATH, content: publishedJson, encoding: 'utf-8', binary: false },
    { path: coverRepoPath, content: photos.cover, encoding: 'base64', binary: true },
    { path: cardRepoPath, content: photos.card, encoding: 'base64', binary: true },
  ];

  return { slug, canonicalUrl, files };
}

/** Writes the would-be commit to out/portfolio/ without touching GitHub. */
function writeDryRun(files, outDir) {
  for (const file of files) {
    const target = path.join(outDir, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (file.binary) {
      fs.writeFileSync(target, file.content);
    } else {
      fs.writeFileSync(target, file.content, 'utf8');
    }
  }
}

/** Creates blobs, a tree, a commit, then moves the branch (no force). */
async function commitFiles({ client, state, files, title }) {
  const treeEntries = [];

  for (const file of files) {
    const content = file.binary ? file.content.toString('base64') : file.content;
    const sha = await client.createBlob(content, file.encoding);
    treeEntries.push({ path: file.path, mode: '100644', type: 'blob', sha });
  }

  const treeSha = await client.createTree(state.treeSha, treeEntries);
  const commitSha = await client.createCommit({
    message: `Add blog post: ${title}`,
    tree: treeSha,
    parent: state.commitSha,
  });
  await client.updateRef(commitSha);
  return commitSha;
}

/**
 * The public entry point, called only by portfolioEntry.js.
 *
 * @param {object} params
 * @param {string} [params.topic] a fixed topic (e.g. --topic); otherwise pickTopic is used
 * @param {(entries:Array, slugs:string[]) => Promise<{topic:string, category:object}>} [params.pickTopic]
 *        called only after the interval check passed, with the repo's published-posts.json
 * @param {object|null} [params.category]
 * @param {Array} [params.facts] real headlines already collected
 * @param {object} params.config getConfig()
 * @param {string} [params.today]
 * @param {boolean} [params.publish] true = real commit, false = out/portfolio
 * @param {boolean} [params.manual] true for the manual portfolio:dry/publish commands
 * @param {string[]} [params.excludeImageIds] Pixabay ids used by Blogger
 * @param {string} [params.avoidImageQuery] Blogger image keyword to avoid
 * @param {string} [params.outDir]
 */
export async function publishPortfolio({
  topic = '',
  pickTopic = null,
  category = null,
  facts = [],
  config,
  today = getIstDate(),
  publish = false,
  manual = false,
  excludeImageIds = [],
  avoidImageQuery = '',
  outDir = path.join(process.cwd(), 'out', 'portfolio'),
}) {
  if (!config) throw new Error('publishPortfolio needs the app config.');
  if (!topic && typeof pickTopic !== 'function') {
    throw new Error('publishPortfolio needs a topic or a pickTopic function.');
  }
  if (!/^https?:\/\/[^\s"'<>]+$/i.test(String(config.portfolioSiteUrl ?? ''))) {
    throw new Error('PORTFOLIO_SITE_URL must be a plain http(s) URL with no quotes or spaces.');
  }

  const client = new PortfolioGitHub({
    token: config.portfolioToken,
    repo: config.portfolioRepo,
    branch: config.portfolioBranch,
  });

  let state = await readState(client);

  // Same-date check first; the topic check follows once the topic is known.
  const dateSkip = duplicateReason(state.publishedEntries, {
    today,
    topicKey: topic ? asciiSlug(topic, 80) : '',
    force: config.portfolioForce,
  });
  if (dateSkip) {
    console.log(`[portfolio] Skipped: ${dateSkip}.`);
    return { skipped: true, reason: dateSkip };
  }

  const interval = checkPortfolioInterval(state.publishedEntries, {
    today,
    intervalDays: config.portfolioIntervalDays,
    force: config.portfolioForce,
    manual,
    dryRun: !publish,
  });

  if (!interval.allowed) {
    console.log(`Portfolio: ${interval.message}, skipping.`);
    return { skipped: true, reason: interval.message };
  }

  if (interval.warning) {
    console.warn(`Portfolio: ${interval.warning}.`);
  } else if (interval.reason === 'force') {
    console.log('Portfolio: PORTFOLIO_FORCE=true, interval check bypassed.');
  } else if (interval.reason === 'manual') {
    console.log('Portfolio: manual publish, interval check bypassed.');
  }

  // Picked only now, so a too-soon day costs no Groq call.
  if (!topic) {
    const existingSlugs = [...state.paths]
      .map((filePath) => filePath.match(/^public\/(blog-[^/]+)\.html$/)?.[1])
      .filter(Boolean);
    const picked = await pickTopic(state.publishedEntries, existingSlugs);
    topic = picked.topic;
    category = picked.category ?? category;
    console.log(`[portfolio] Topic (${picked.source ?? 'picker'}): ${topic}`);
  }

  const topicKey = asciiSlug(topic, 80);
  const topicSkip = duplicateReason(state.publishedEntries, { today, topicKey, force: true });
  if (topicSkip) {
    console.log(`[portfolio] Skipped: ${topicSkip}.`);
    return { skipped: true, reason: topicSkip };
  }

  console.log(`[portfolio] Writing a fresh portfolio article for: ${topic}`);
  const article = await generatePortfolioArticle({
    topic,
    category,
    facts,
    today,
    avoidImageQuery,
    model: config.portfolioGroqModel,
  });
  // The card label follows the topic's category (Digital Marketing, AI,
  // Vibe Coding) so the blog page stays consistent.
  if (category?.label) article.tag = cleanAttributeValue(category.label, 30);
  console.log(`[portfolio] Title: ${article.title}`);
  console.log(`[portfolio] ${article.wordCount} words, ${article.readMinutes} min read`);

  const photos = await findPortfolioPhotos({
    query: article.coverQuery,
    excludeIds: excludeImageIds,
    timeoutMs: config.imageTimeoutSec * 1000,
  });

  let prepared = await prepareUpdates({
    client,
    state,
    article,
    photos,
    config,
    today,
    category,
    topicKey,
  });

  if (!publish) {
    writeDryRun(prepared.files, outDir);
    console.log('[portfolio] DRY RUN - no GitHub write calls were made.');
    console.log(`[portfolio] Would-be commit files under ${outDir}:`);
    for (const file of prepared.files) console.log(`  ${file.path}`);
    return {
      skipped: false,
      dryRun: true,
      slug: prepared.slug,
      url: prepared.canonicalUrl,
      files: prepared.files.map((file) => file.path),
      outDir,
    };
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) {
      state = await readState(client);

      const retrySkip = duplicateReason(state.publishedEntries, {
        today,
        topicKey,
        force: config.portfolioForce,
      });
      if (retrySkip) {
        console.log(`[portfolio] Skipped on retry: ${retrySkip}.`);
        return { skipped: true, reason: retrySkip };
      }

      const retryInterval = checkPortfolioInterval(state.publishedEntries, {
        today,
        intervalDays: config.portfolioIntervalDays,
        force: config.portfolioForce,
        manual,
        dryRun: !publish,
      });
      if (!retryInterval.allowed) {
        console.log(`Portfolio: ${retryInterval.message}, skipping.`);
        return { skipped: true, reason: retryInterval.message };
      }

      prepared = await prepareUpdates({
        client,
        state,
        article,
        photos,
        config,
        today,
        category,
        topicKey,
      });
    }

    try {
      const commitSha = await commitFiles({
        client,
        state,
        files: prepared.files,
        title: article.title,
      });

      console.log(`[portfolio] Published: ${prepared.canonicalUrl}`);
      console.log(`[portfolio] Commit: ${commitSha}`);
      return {
        skipped: false,
        dryRun: false,
        slug: prepared.slug,
        url: prepared.canonicalUrl,
        commitSha,
        files: prepared.files.map((file) => file.path),
      };
    } catch (error) {
      const branchMoved = error.status === 409 || error.status === 422;
      if (branchMoved && attempt < 3) {
        console.warn(
          `[portfolio] The branch moved while committing (attempt ${attempt}/3). Re-reading and retrying...`
        );
        continue;
      }
      throw error;
    }
  }

  throw new Error('Portfolio commit failed after 3 attempts because the branch kept moving.');
}
