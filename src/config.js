// ============================================================
// src/config.js
// All settings live in .env. This file gives every module the
// same defaults, so a blank value in .env never breaks the run.
//
// Images come from Pixabay and need PIXABAY_API_KEY in .env.
// ============================================================

const DEFAULT_NICHE = 'AI tools, web development, and digital marketing for beginners';
const DEFAULT_LANGUAGE = 'English';
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

export function getConfig() {
  return {
    niche: str('BLOG_NICHE', DEFAULT_NICHE),
    language: str('BLOG_LANGUAGE', DEFAULT_LANGUAGE),
    model: str('GROQ_MODEL', DEFAULT_MODEL),

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