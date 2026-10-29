// ============================================================
// src/portfolioEntry.js
// The portfolio pipeline. It is a SEPARATE process from the Blogger
// run (src/index.js) - the two never share a process or a try/catch.
//
// The portfolio has its OWN topics (prompts/portfolio_topics.json):
// evergreen beginner explainers such as "What is digital marketing"
// or "How to make your own chatbot", written in first person as
// Chetna in the portfolio's own template.
//
//   npm run portfolio:scheduled   what GitHub Actions runs after Blogger.
//                                 Obeys PORTFOLIO_PUBLISH and the 3-day interval.
//   npm run portfolio:dry         always dry, writes out/portfolio/
//   npm run portfolio:publish     real portfolio commit, one atomic push
//
//   --topic="What is SEO"  --category=digital_marketing   force one topic
//
// It NEVER publishes to Blogger and NEVER writes posted.json.
// ============================================================

import 'dotenv/config';

import { getConfig } from './config.js';
import { getIstDate, getIstTime, readPosted } from './logger.js';
import { parseTopicOverride } from './topicSelection.js';
import { loadPortfolioTopics, pickPortfolioTopic } from './portfolioTopics.js';
import { publishPortfolio } from './portfolioPublisher.js';

/** --category=<id> for a forced --topic; defaults to digital_marketing. */
function categoryForOverride(argv) {
  const { categories } = loadPortfolioTopics();
  const flag = argv.map(String).find((arg) => /^--category=/i.test(arg));
  const id = flag ? flag.split('=')[1].trim() : 'digital_marketing';
  const entry = categories[id];
  if (!entry) {
    throw new Error(`Unknown --category "${id}". Use one of: ${Object.keys(categories).join(', ')}`);
  }
  return { id, label: entry.label, description: entry.description, audience: entry.audience };
}

/** Pixabay ids used by today's Blogger post, so the photo is never reused. */
function bloggerImageIdsFor(today) {
  return readPosted()
    .filter((entry) => entry?.date === today && Array.isArray(entry.imageIds))
    .flatMap((entry) => entry.imageIds);
}

async function main() {
  const argv = process.argv.slice(2);
  const scheduled = argv.includes('--scheduled');
  const config = getConfig();
  const today = getIstDate();

  // Scheduled: PORTFOLIO_PUBLISH decides. Manual: the flag decides.
  const publish = scheduled
    ? config.portfolioPublish
    : argv.includes('--publish') && !argv.includes('--dry');

  const forcedTopic = parseTopicOverride(argv);

  console.log('========================================');
  console.log(' Portfolio publisher - separate run');
  console.log(` Date (IST): ${today}  Time: ${getIstTime()} IST`);
  console.log(` Trigger: ${scheduled ? 'scheduled (after Blogger)' : 'manual'}`);
  console.log(` Mode: ${publish ? 'PUBLISH (one atomic commit)' : 'DRY RUN (no GitHub writes)'}`);
  console.log(` Repo: ${config.portfolioRepo} @ ${config.portfolioBranch}`);
  console.log(` Topic: ${forcedTopic ? `forced "${forcedTopic}"` : 'next from prompts/portfolio_topics.json'}`);
  console.log('========================================');

  const result = await publishPortfolio({
    topic: forcedTopic,
    category: forcedTopic ? categoryForOverride(argv) : null,
    pickTopic: pickPortfolioTopic,
    config,
    today,
    publish,
    manual: !scheduled,
    excludeImageIds: bloggerImageIdsFor(today),
  });

  if (result.skipped) return;

  if (result.dryRun) {
    console.log(`\n[portfolio] Dry run complete: ${result.url}`);
    console.log(`[portfolio] Open the folder: ${result.outDir}`);
  } else {
    console.log(`\n[portfolio] Live: ${result.url}`);
    console.log(`[portfolio] Commit: ${result.commitSha}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('\n================ PORTFOLIO FAILED ================');
    console.error(error.message);
    if (error.status) console.error(`HTTP status: ${error.status}`);
    console.error('==================================================\n');
    process.exit(1);
  });
