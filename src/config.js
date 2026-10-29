// ============================================================
// src/config.js
// All settings live in .env. This file gives every module the
// same defaults, so a blank value in .env never breaks the run.
//
// Images come from Pixabay and need PIXABAY_API_KEY in .env.
// ============================================================

const DEFAULT_NICHE = 'AI tools, web development, and digital marketing for beginners';
const DEFAULT_LANGUAGE = 'English';

// Chetna's portfolio. Public URL, not a secret, so it has a default
// here and works in GitHub Actions with no extra setup.
// Override it in .env if the address ever changes.
const DEFAULT_PORTFOLIO_URL = 'https://chetnaportflio.vercel.app/';

// The portfolio website is a SEPARATE repository. The agent reads its
// templates and files at runtime and (only when allowed) pushes one
// atomic commit back to it.
const DEFAULT_PORTFOLIO_REPO = 'chetnaravish/portfolio';
const DEFAULT_PORTFOLIO_BRANCH = 'main';
const DEFAULT_PORTFOLIO_SITE_URL = 'https://chetnaportflio.vercel.app';

// We use qwen/qwen3.8-27b because it returns strict JSON reliably.
//
// WHY NOT the gpt-oss models (openai/gpt-oss-120b / 20b)?
// They are "reasoning" models: they burn most of the token budget on
// thinking and then return an EMPTY answer, and they fail Groq's strict
// JSON mode with "Failed to validate JSON". Tested and rejected.
// qwen also gives us a much friendlier per-minute token limit.
const DEFAULT_MODEL = 'qwen/qwen3.8-27b';

/** Reads a string value, falling back to a default when it is blank. */
function str(name, fallback) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

/**
 * PUBLISH_AS_DRAFT: we treat ANYTHING other than a clear "false"
 * as draft. That way an empty or typo'd value can never publish live.
 *
 * The special value "auto" means "let PUBLISH_LIVE_DAILY decide".
 * GitHub Actions uses that, so a scheduled run can go live just by
 * setting a GitHub variable, without editing the workflow file.
 */
function bool(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === null || value.trim() === '') return fallback;
  if (value.trim().toLowerCase() === 'auto') {
    const live = (process.env.PUBLISH_LIVE_DAILY ?? '').trim().toLowerCase();
    return live !== 'true';
  }
  return value.trim().toLowerCase() !== 'false';
}

/** Reads a whole number, e.g. a timeout in seconds. */
function num(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Reads a positive whole number, e.g. a number of days. */
function int(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function getConfig() {
  return {
    niche: str('BLOG_NICHE', DEFAULT_NICHE),
    language: str('BLOG_LANGUAGE', DEFAULT_LANGUAGE),
    model: str('GROQ_MODEL', DEFAULT_MODEL),

    // Optional: only the portfolio article uses this model.
    // Blogger keeps using GROQ_MODEL above.
    portfolioGroqModel: str('PORTFOLIO_GROQ_MODEL', ''),

    // Where readers can see Chetna's own work. Added to posts on
    // alternate days (see shouldShowPortfolio in index.js).
    portfolioUrl: str('PORTFOLIO_URL', DEFAULT_PORTFOLIO_URL),

    // The separate static portfolio repository. PORTFOLIO_PUBLISH is
    // only true for the exact value "true" - anything else means dry
    // run, so a typo can never push a post live by accident.
    portfolioToken: str('PORTFOLIO_GH_TOKEN', ''),
    portfolioRepo: str('PORTFOLIO_REPO', DEFAULT_PORTFOLIO_REPO),
    portfolioBranch: str('PORTFOLIO_BRANCH', DEFAULT_PORTFOLIO_BRANCH),
    portfolioSiteUrl: str('PORTFOLIO_SITE_URL', DEFAULT_PORTFOLIO_SITE_URL).replace(/\/+$/, ''),
    portfolioPublish: str('PORTFOLIO_PUBLISH', 'false') === 'true',
    portfolioForce: str('PORTFOLIO_FORCE', '') === 'true',

    // Minimum IST calendar days between portfolio posts. The newest date
    // in the portfolio repo's published-posts.json is the source of truth.
    portfolioIntervalDays: int('PORTFOLIO_INTERVAL_DAYS', 3),

    isDraft: bool('PUBLISH_AS_DRAFT', true),

    // Images. AUTO_COMMIT_PUSH is for GitHub Actions; locally you push
    // images yourself so we never push without being asked.
    autoCommitPush: bool('AUTO_COMMIT_PUSH', false),
    imageTimeoutSec: num('IMAGE_TIMEOUT_SEC', 60),

    // Secrets. Never logged, only sent to the APIs.
    groqApiKey: str('GROQ_API_KEY', ''),
    pixabayApiKey: str('PIXABAY_API_KEY', ''),
    googleClientId: str('GOOGLE_CLIENT_ID', ''),
    googleClientSecret: str('GOOGLE_CLIENT_SECRET', ''),
    googleRefreshToken: str('GOOGLE_REFRESH_TOKEN', ''),
    bloggerBlogId: str('BLOGGER_BLOG_ID', ''),
  };
}