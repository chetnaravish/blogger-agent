// ============================================================
// src/topicSelection.js
// The topic + source-facts part of the pipeline, pulled out of
// index.js so the portfolio-only entry point can reuse it without
// touching Blogger, posted.json or any other state.
//
// It only reads. It never writes posted.json and never publishes.
// ============================================================

import { getNewsHeadlines } from './news.js';
import { generateTopic } from './topic.js';
import { getRecentTitles } from './logger.js';

/**
 * Reads --topic="Some subject" from the command line.
 *
 *   npm run post -- --topic="What is vibe coding"
 *   npm run post -- --topic What is vibe coding   (space form)
 *
 * When it is given, the topic picker and the judge are skipped and
 * the article is written about exactly this subject.
 *
 * @param {string[]} [argv]
 * @returns {string} '' when the flag was not used
 */
export function parseTopicOverride(argv = process.argv.slice(2)) {
  const args = argv.map(String);
  for (let i = 0; i < args.length; i++) {
    const equals = args[i].match(/^--topic=(.*)$/i);
    if (equals && equals[1].trim()) return equals[1].trim();
    if (/^--topic$/i.test(args[i]) && args[i + 1] && !args[i + 1].startsWith('--')) {
      return args[i + 1].trim();
    }
  }
  return '';
}

/**
 * Picks today's topic and collects the real source facts for it.
 *
 * The Blogger run and the portfolio-only run both call this, so the
 * portfolio article is grounded in exactly the same material as the
 * Blogger article - and no news is fetched a second time.
 *
 * @param {object} params
 * @param {object} params.category   entry from prompts/categories.json
 * @param {object} params.config     getConfig() result
 * @param {string} params.today      today's date in IST (YYYY-MM-DD)
 * @param {Array}  [params.posted]   entries from posted.json (read only)
 * @param {string[]} [params.argv]
 * @returns {Promise<{topic:string, angle:string, judgeReason:string, attempts:number,
 *   news:object, recentTitles:string[], topicOverride:string}>}
 */
export async function selectTopicAndFacts({
  category,
  config,
  today,
  posted = [],
  argv = process.argv.slice(2),
}) {
  const recentTitles = getRecentTitles(40, posted);

  console.log(`      Sending the last ${recentTitles.length} title(s) so we do not repeat`);

  // News-based categories get real headlines so the topic is grounded
  // in what actually happened, not the model's old memory.
  const news = await getNewsHeadlines({ category, count: 8 });

  // --topic="..." writes about exactly that subject, skipping the
  // picker and the judge. No flag = normal daily behaviour.
  const topicOverride = parseTopicOverride(argv);
  let topic;
  let angle = '';
  let judgeReason = 'forced with --topic';
  let attempts = 0;

  if (topicOverride) {
    topic = topicOverride;
    console.log(`      Topic forced: "${topic}" (topic picker skipped)`);
  } else {
    ({ topic, angle, judgeReason, attempts } = await generateTopic({
      category,
      recentTitles,
      language: config.language,
      isNewsBased: category.news_based === true,
      newsHeadlines: news.headlines,
      today,
    }));
    console.log(`      Category used ${attempts} attempt(s), judge said: "${judgeReason}"`);
  }

  return { topic, angle, judgeReason, attempts, news, recentTitles, topicOverride };
}
