// ============================================================
// src/index.js
// The whole daily pipeline in one run, then it exits.
//
//   1. guard   - never post twice on the same day
//   2. topic   - pick something new
//   3. article - write it
//   4. images  - make them, save into images/
//   5. push    - commit + push images, wait for jsDelivr (HTTP 200)
//   6. html    - build the post
//   7. post    - send it to Blogger, then log it
//
// WHY IMAGES ARE PUSHED BEFORE THE POST:
// jsDelivr answers 404 until an image is actually on GitHub. So we
// push first, wait for a real 200, and only then publish. That way
// your readers never see a broken picture.
//
// Run with: npm run post
// ============================================================

// Load .env FIRST. dotenv never overwrites a variable that GitHub
// Actions already gave us, so the same code works locally and in CI.
import 'dotenv/config';

import { getConfig } from './config.js';
import { loadCategories, chooseCategory, parseCategoryOverride, describeRotation } from './categories.js';
import { getIstDate, getIstTime, readPosted, hasLivePostForDate, addEntry, getRecentTitles, getTitlesForCategory } from './logger.js';
import { getNewsHeadlines } from './news.js';
import { generateTopic } from './topic.js';
import { generateArticle } from './article.js';
import { findImages } from './images.js';
import { buildArticleHtml } from './html.js';
import { detectRepo, buildImageUrl, waitForImage, commitAndPush, IMAGES_DIR } from './cdn.js';
import { getAccessToken, publishPost } from './blogger.js';

const TOTAL_STEPS = 8;

/** Pretty step header in the terminal. */
function step(number, message) {
  console.log(`\n[${number}/${TOTAL_STEPS}] ${message}`);
}

/** Box that tells you what happened. */
function done(message) {
  console.log(`\n================ DONE ================\n${message}\n========================================\n`);
}

/**
 * Should today's post carry the portfolio link?
 *
 * Chetna asked for it on ALTERNATE days: one day with the link, the
 * next day without, and so on. The day number decides it, so the
 * pattern is stable and does not depend on how many posts exist.
 *
 *   2026-10-21 -> 21 is odd  -> link
 *   2026-10-22 -> 22 is even -> no link
 *
 * It is a pure function of the date, so a re-run on the same day
 * always makes the same choice.
 */
export function shouldShowPortfolio(dateString) {
  const day = Number(String(dateString).slice(8, 10));
  if (!Number.isFinite(day)) return false;
  return day % 2 === 1;
}

/**
 * Reads --topic="Some subject" from the command line.
 *
 *   npm run post -- --topic="What is vibe coding"
 *   npm run post -- --topic What is vibe coding   (space form)
 *
 * When it is given, Step 2 skips the topic picker and the judge and
 * writes about exactly this. Useful for testing one idea on demand.
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
 * Reads --portfolio=on | --portfolio=off from the command line.
 *
 * The daily rule (odd date = on, even = off) still applies when this
 * flag is missing. The flag only exists so one test run can show the
 * portfolio box on a day the rule would have skipped it.
 *
 * @param {string[]} [argv]
 * @returns {boolean|null} null = no flag, use the date rule
 */
export function parsePortfolioOverride(argv = process.argv.slice(2)) {
  const args = argv.map(String);
  for (let i = 0; i < args.length; i++) {
    const raw =
      args[i].match(/^--portfolio=(.*)$/i)?.[1] ??
      (/^--portfolio$/i.test(args[i]) ? args[i + 1] : '');
    const value = String(raw ?? '').toLowerCase().trim();
    if (value === 'on' || value === 'true' || value === '1') return true;
    if (value === 'off' || value === 'false' || value === '0') return false;
  }
  return null;
}

/** Everything is optional except the secrets, so check the essentials. */
function requireKeys(config) {
  const required = [
    ['GROQ_API_KEY', config.groqApiKey],
    ['GOOGLE_CLIENT_ID', config.googleClientId],
    ['GOOGLE_CLIENT_SECRET', config.googleClientSecret],
    ['GOOGLE_REFRESH_TOKEN', config.googleRefreshToken],
    ['BLOGGER_BLOG_ID', config.bloggerBlogId],
  ];
  const missing = required.filter(([, value]) => !value).map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(
      `Missing in .env: ${missing.join(', ')}\n` +
        `Fill them in and run "npm run check" to confirm.`
    );
  }
}

async function main() {
  const config = getConfig();
  const today = getIstDate();

  console.log('========================================');
  console.log(' Blogger Agent - daily run');
  console.log(` Date (IST): ${today}  Time: ${getIstTime()} IST`);
  console.log(` Mode: ${config.isDraft ? 'DRAFT (not visible to readers)' : 'LIVE PUBLISH'}`);
  console.log(` Auto push images: ${config.autoCommitPush ? 'yes' : 'no (you push them)'}`);
  console.log('========================================');

  // ---- Step 0: which category are we writing about today? ----
  const categories = loadCategories();
  const override = parseCategoryOverride();

  if (process.argv.includes('--show-rotation')) {
    console.log('\nCategory rotation right now:');
    console.log(describeRotation(categories, readPosted()));
    console.log('');
  }

  const { category, reason: categoryReason } = chooseCategory({
    posted: readPosted(),
    categories,
    override,
    today,
  });

  console.log(`Category today : ${category.id} (${category.label})`);
  console.log(`  why          : ${categoryReason}`);
  console.log(`  audience     : ${category.audience}`);
  if (override) console.log(`  override     : forced with --category=${override}`);

  // ---- Step 1: duplicate guard --------------------------------
  step(1, 'Checking whether today\'s post already exists');

  requireKeys(config);
  const posted = readPosted();

  if (hasLivePostForDate(today, posted)) {
    done(
      `A post for ${today} is already LIVE. Nothing to do.\n` +
        `Exiting normally so the daily schedule stays happy.`
    );
    return;
  }
  console.log(`      No live post for ${today}. Safe to continue.`);
  console.log(`      (already in log: ${posted.length} post(s))`);

  // ---- Step 2: topic -------------------------------------------
  step(2, 'Choosing a fresh topic');

  const recentTitles = getRecentTitles(40, posted);
  const sameCategoryTitles = getTitlesForCategory(category.id, posted);

  console.log(`      Sending the last ${recentTitles.length} title(s) so we do not repeat`);

  // News-based categories (AI Updates) get real headlines so the topic
  // is grounded in what actually happened, not the model's old memory.
  const news = await getNewsHeadlines({ category, count: 8 });

  // --topic="..." writes about exactly that subject, skipping the
  // picker and the judge. No flag = normal daily behaviour.
  const topicOverride = parseTopicOverride();
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

  // ---- Step 3: article -----------------------------------------
  step(3, 'Writing the article');

  // The portfolio link goes in on alternate days only. --portfolio=on/off
  // lets one test run show it on a day the rule would skip.
  const portfolioOverride = parsePortfolioOverride();
  const showPortfolio =
    (portfolioOverride !== null ? portfolioOverride : shouldShowPortfolio(today)) &&
    Boolean(config.portfolioUrl);
  console.log(
    showPortfolio
      ? `      Portfolio link: ON for ${today}`
      : `      Portfolio link: OFF for ${today} (alternate-day rule)`
  );
  if (portfolioOverride !== null) {
    console.log(`      (forced with --portfolio=${portfolioOverride ? 'on' : 'off'})`);
  }

  const article = await generateArticle({
    topic,
    angle,
    category,
    niche: config.niche,
    language: config.language,
    today,
    newsHeadlines: news.headlines,
    showPortfolio,
    portfolioUrl: config.portfolioUrl,
  });

  // ---- Step 4: images ------------------------------------------
  step(4, 'Finding topic photos on Pixabay');

  // Only 2 pictures in the whole post: a hero and one section image.
  // More than that turns the article into a slideshow.
  const sectionHeadings = article.sections.slice(0, 1).map((section) => section.heading);

  const saved = await findImages({
    article,
    sectionHeadings,
    date: today,
    imagesDir: IMAGES_DIR,
    timeoutMs: config.imageTimeoutSec * 1000,
  });

  // ---- Step 5: push images, then wait for jsDelivr -------------
  step(5, 'Making the images reachable on the web');

  const repo = await detectRepo();
  let hosted = { hero: null, sections: [] };

  if (!repo) {
    console.warn('[cdn] Could not read the GitHub remote, so images will not be hosted.');
    console.warn('[cdn] The post will go out without images.');
  } else {
    console.log(`[cdn] Repo detected: ${repo.user}/${repo.repo} (branch ${repo.branch})`);

    // Turn saved files into public URLs.
    const toHosted = (image) =>
      image && {
        url: buildImageUrl(repo, image.file),
        alt: image.alt,
        credit: image.credit,
        source: image.source,
        file: image.file,
      };

    hosted = {
      hero: toHosted(saved.hero),
      sections: saved.sections.map(toHosted),
    };

    const anyImage = hosted.hero || hosted.sections.length > 0;

    if (anyImage) {
      if (config.autoCommitPush) {
        // GitHub Actions: we are allowed to push.
        const pushResult = await commitAndPush(`chore: images for ${today}`);
        if (!pushResult.ok) console.warn(`[cdn] Push failed: ${pushResult.reason}`);
      } else {
        // Locally we never push without being asked. We just tell you.
        console.log('[cdn] AUTO_COMMIT_PUSH is off, so images are NOT pushed for you.');
        console.log('[cdn] Push them now in another terminal:');
        console.log('[cdn]     git add images && git commit -m "images" && git push');
        console.log('[cdn] Then come back here - the code below waits a few minutes.');
      }

      // Poll jsDelivr until the image really serves a 200.
      for (const image of [hosted.hero, ...hosted.sections].filter(Boolean)) {
        const live = await waitForImage(image.url);
        image.live = live;
        if (!live) {
          console.warn(`[cdn] ${image.file} is not reachable yet. The post will still be created.`);
        }
      }
    } else {
      console.log('[cdn] No images were made, skipping the hosting step.');
    }
  }

  // ---- Step 6: html --------------------------------------------
  step(6, 'Building the Blogger HTML');

  const content = buildArticleHtml(article, hosted, { portfolioUrl: showPortfolio ? config.portfolioUrl : '' });
  console.log(`      HTML size: ${(content.length / 1024).toFixed(1)} KB`);
  console.log(`      SEO description: ${article.meta_description}`);
  console.log(`      Labels: ${article.labels.join(', ')}`);
  if (showPortfolio) console.log('      Portfolio link: included');

  // ---- Step 7: publish -----------------------------------------
  step(7, config.isDraft ? 'Saving the post as a DRAFT' : 'Publishing the post LIVE');

  const google = {
    clientId: config.googleClientId,
    clientSecret: config.googleClientSecret,
    refreshToken: config.googleRefreshToken,
  };

  let accessToken = await getAccessToken(google);
  const result = await publishPost({
    accessToken,
    // Used only if the token expires mid-run.
    refreshAccessToken: async () => {
      const fresh = await getAccessToken(google);
      return fresh;
    },
    blogId: config.bloggerBlogId,
    title: article.title,
    content,
    labels: article.labels,
    isDraft: config.isDraft,
  });

  console.log(`      Blogger post id: ${result.id}`);

  // ---- Step 8: log it ------------------------------------------
  step(8, 'Saving the entry to posted.json');

  addEntry({
    date: today,
    category: category.id,
    categoryLabel: category.label,
    title: article.title,
    topic,
    url: result.url,
    draft: config.isDraft,
  });

  console.log(`      Remembered: "${article.title}"`);

  const categoryLine = `\nCategory: ${category.id} (${category.label})`;
  const imageNote = hosted.hero || hosted.sections.length > 0
    ? `\nImages: ${1 + hosted.sections.length} hosted on jsDelivr from the images/ folder.`
    : '\nImages: none this time.';

  done(
    (config.isDraft ? 'DRAFT saved. ' : 'POST PUBLISHED. ') +
      `Topic: ${topic}${categoryLine}\n` +
      `URL: ${result.url || '(draft has no public URL yet)'}${imageNote}\n\n` +
      (config.isDraft
        ? 'Open Blogger > Posts > Drafts to read it.'
        : 'Open your blog to see it live.')
  );
}

// ---- Run it -----------------------------------------------------
main()
  .then(() => {
    // Exit code 0 = success. GitHub Actions shows this as a green tick.
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n================ FAILED ================');
    console.error(error.message);
    if (error.status) console.error(`HTTP status: ${error.status}`);
    console.error('=======================================\n');
    // Exit code 1 = failure, so GitHub Actions marks the run red.
    process.exit(1);
  });