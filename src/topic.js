// ============================================================
// src/topic.js
// Picks ONE new topic for today, and makes sure it really belongs to
// the chosen category.
//
// Two AI calls per attempt:
//   1. propose a topic
//   2. judge it - "is this strictly about <category>? yes/no"
// If the judge says no, we ask for a different one. Up to 3 tries.
// ============================================================

import { chat, extractJson } from './groq.js';

/** How many posted titles we send so the AI avoids repeating them. */
const HISTORY_LIMIT = 40;

/** Builds the numbered list of old titles. */
function buildHistory(recentTitles) {
  if (!recentTitles.length) return 'No articles have been published yet.';
  return (
    `These titles are ALREADY PUBLISHED - do not repeat, reword or closely rewrite any of them:\n` +
    recentTitles.map((title, i) => `${i + 1}. ${title}`).join('\n')
  );
}

/**
 * Turns real fetched headlines into a block the model must ground
 * itself in. Without this, a news-based category invents topics from
 * its old training data - it once suggested a 2024 topic in 2026.
 */
function buildNewsBlock(headlines, today) {
  if (!Array.isArray(headlines) || headlines.length === 0) {
    return '';
  }
  return (
    `Today's date is ${today}. These are REAL, current stories we fetched just now:\n` +
    headlines
      .map((item, i) => `${i + 1}. ${item.title}${item.points ? ` (${item.points} points on Hacker News)` : ''}`)
      .join('\n') +
    `\n\nPick a topic that grows out of ONE of these real stories. ` +
    `You may explain, compare or give practical advice around it. ` +
    `Do NOT invent newer events, version numbers, prices or statistics - ` +
    `only reason about what the headlines above actually say. ` +
    `Never mention a year before ${today.slice(0, 4)}; the current year is ${today.slice(0, 4)}.`
  );
}

/**
 * The prompt that asks for one idea.
 *
 * `newsBlock` is empty for evergreen categories, and filled with real
 * headlines for news-based ones such as AI Updates.
 */
function buildProposalPrompt({ category, history, audience, language, avoidNews, newsBlock, today }) {
  const freshness = avoidNews
    ? `- Today is ${today}. Never present something as new if it is from an older year.
- Never state a date, price, version number or statistic you cannot see in the source material you were given.
${newsBlock ? '- Your topic MUST be tied to one of the real stories listed below.\n' : ''}`
    : '- Write evergreen, practical content that is not tied to any date. Never invent statistics, studies, quotes, prices or version numbers.\n';

  return `${history}

${newsBlock ? `${newsBlock}\n\n` : ''}Pick ONE new topic for today's article.

Category: ${category.label}
What this category covers: ${category.description}
Who it is for: ${audience}

Rules:
- The topic must be strictly inside the category above. Nothing else.
- Make it a specific question or problem the reader actually has, not a broad subject.
- It must be explainable well in 1000-1400 words without inventing facts.
${freshness}- Do not use any of the already published titles above.

Reply with ONLY this JSON and nothing else:
{"topic":"the topic as a short phrase","angle":"one sentence on what the article will cover"}`;
}

/** The prompt that judges whether a topic is really on-topic. */
function buildJudgePrompt({ topic, category }) {
  return `You are a strict editor for a blog that only covers one topic at a time.

The blog's category is: ${category.label}
Category meaning: ${category.description}

A proposed topic is: "${topic}"

Answer YES only if a reader would clearly say "yes, that is exactly ${category.label}".
Answer NO if it is even partly about something else, or if it is vague.

Reply with ONLY this JSON and nothing else:
{"on_topic":true,"reason":"5 words or fewer"}`;
}

/** Checks the JSON we asked the judge for. */
function isVerdict(value) {
  return Boolean(value) && typeof value.on_topic === 'boolean' && value.reason !== undefined;
}

/** Checks the JSON we asked for from the proposer. */
function isProposal(value) {
  return Boolean(value) && typeof value.topic === 'string' && value.topic.trim().length >= 15;
}

/**
 * @param {object} params
 * @param {object} params.category      one entry from categories.json
 * @param {string[]} params.recentTitles
 * @param {string} params.language
 * @param {boolean} [params.isNewsBased] true for ai_updates
 * @param {string[]} [params.newsHeadlines] real headlines from src/news.js
 * @param {string} params.today         today's date in IST (YYYY-MM-DD)
 * @returns {Promise<{topic:string, angle:string, judgedOnTopic:boolean, judgeReason:string, attempts:number}>}
 */
export async function generateTopic({
  category,
  recentTitles = [],
  language,
  isNewsBased = false,
  newsHeadlines = [],
  today = new Date().toISOString().slice(0, 10),
}) {
  if (!category) throw new Error('generateTopic needs a category object.');

  const history = buildHistory(recentTitles.slice(0, HISTORY_LIMIT));
  const newsBlock = buildNewsBlock(newsHeadlines, today);
  const baseSystem =
    `You choose topics for a blog. Niche: ${category.description}. Language: ${language}. Today's date: ${today}.`;

  let lastReason = 'no attempt was made';

  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`[topic] Category: ${category.id} | asking for a topic (attempt ${attempt}/3)...`);

    // ---------- 1. propose ----------
    let proposal = null;
    try {
      const raw = await chat(
        [
          { role: 'system', content: baseSystem },
          {
            role: 'user',
            content: buildProposalPrompt({
              category,
              history,
              audience: category.audience,
              language,
              avoidNews: isNewsBased,
              newsBlock,
              today,
            }),
          },
        ],
        { json: true }
      );
      proposal = extractJson(raw);
    } catch (error) {
      lastReason = `the proposal call failed: ${error.message}`;
      console.warn(`[topic] ${lastReason}`);
      continue;
    }

    if (!isProposal(proposal)) {
      lastReason = 'the reply was not a valid topic';
      console.warn(`[topic] Bad proposal (${lastReason}).`);
      continue;
    }

    const topic = proposal.topic.trim();
    const angle = String(proposal.angle ?? '').trim();

    // ---------- 2. judge ----------
    let onTopic = true;
    let judgeReason = 'accepted';
    try {
      const raw = await chat(
        [
          { role: 'system', content: 'You are a strict editor. You answer with JSON only.' },
          { role: 'user', content: buildJudgePrompt({ topic, category }) },
        ],
        { json: true }
      );
      const verdict = extractJson(raw);

      if (!isVerdict(verdict)) {
        // Judge did not behave. Better to reject than to let a bad topic through.
        onTopic = false;
        judgeReason = 'judge gave no usable answer, so we rejected it to be safe';
      } else {
        onTopic = verdict.on_topic;
        judgeReason = String(verdict.reason ?? '').slice(0, 60);
      }
    } catch (error) {
      onTopic = false;
      judgeReason = `judge call failed: ${error.message}`;
    }

    if (onTopic) {
      console.log(`[topic] Accepted: ${topic}`);
      console.log(`[topic] Judge: ${judgeReason}`);
      return { topic, angle, judgedOnTopic: true, judgeReason, attempts: attempt };
    }

    lastReason = `rejected as off-topic ("${judgeReason}")`;
    console.warn(`[topic] "${topic}" was REJECTED: ${judgeReason}`);
  }

  throw new Error(
    `Could not get a clearly on-topic idea for "${category.id}" after 3 tries. Last problem: ${lastReason}. ` +
      `Try forcing a different category: npm run post -- --category=${category.id}`
  );
}