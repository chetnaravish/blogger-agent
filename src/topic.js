// ============================================================
// src/topic.js
// Asks Groq for ONE fresh article topic that matches your niche
// and does not repeat anything from posted.json.
// ============================================================

import { chat, extractJson } from './groq.js';

/** Groq wraps JSON in prose more often than you would like, so we check it. */
function isValidTopic(value) {
  return (
    value &&
    typeof value.topic === 'string' &&
    value.topic.trim().length >= 15
  );
}

/**
 * @param {{ recentTitles?: string[], niche: string, language: string }} params
 * @returns {Promise<{topic: string, angle: string}>}
 */
export async function generateTopic({ recentTitles = [], niche, language }) {
  // Showing old titles is what stops the model from repeating itself.
  const history = recentTitles.length
    ? `These titles are ALREADY PUBLISHED - do not repeat or rewrite them:\n` +
      recentTitles.map((title, i) => `${i + 1}. ${title}`).join('\n')
    : 'No articles have been published yet.';

  const systemPrompt =
    `You choose topics for a blog. Niche: ${niche}. Language: ${language}.`;

  const userPrompt = `${history}

Pick ONE new topic for today's article.

Rules:
- It must be a specific question or problem a beginner has, not a broad subject.
- It must be genuinely useful and something you can explain well in 700-1000 words.
- It must be different from every title above.
- No fake statistics, no invented news, no claims about numbers you cannot verify.

Reply with ONLY this JSON, no other text:
{"topic":"the topic as a short phrase","angle":"one sentence on what the article will cover"}`;

  let lastReason = 'no reason';

  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`[topic] Asking Groq for a topic (attempt ${attempt}/3)...`);
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
      lastReason = `Groq call failed: ${error.message}`;
      console.warn(`[topic] ${lastReason}`);
      continue;
    }

    const parsed = extractJson(raw);

    if (isValidTopic(parsed)) {
      console.log(`[topic] Topic chosen: ${parsed.topic.trim()}`);
      return { topic: parsed.topic.trim(), angle: String(parsed.angle ?? '').trim() };
    }

    lastReason = 'the reply was not valid topic JSON';
    console.warn(`[topic] Bad reply (${lastReason}). Trying again...`);
  }

  throw new Error(`Could not get a valid topic from Groq after 3 tries (${lastReason}).`);
}