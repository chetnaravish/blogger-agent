// ============================================================
// scripts/check-env.js
// Checks your .env BEFORE a run.
//
// SAFETY: this script prints only the NAMES of missing variables.
// It never prints a value, never prints a secret, and works the same
// in PowerShell and in GitHub Actions.
//
// Run with: npm run check
// ============================================================

import 'dotenv/config';

// The first 4 are needed for a run to work at all.
// The rest have sensible defaults, so being blank is fine.
const REQUIRED = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'BLOGGER_BLOG_ID', 'GROQ_API_KEY'];

const OPTIONAL = [
  'GROQ_MODEL',
  'BLOG_NICHE',
  'BLOG_LANGUAGE',
  'PUBLISH_AS_DRAFT',
  'PUBLISH_LIVE_DAILY',
  'AUTO_COMMIT_PUSH',
  'IMAGE_TIMEOUT_SEC',
];

// Where each key comes from, so this output doubles as a checklist.
const SOURCES = {
  GOOGLE_CLIENT_ID: 'Google Cloud Console > Credentials > your Desktop OAuth client',
  GOOGLE_CLIENT_SECRET: 'Google Cloud Console > Credentials > your Desktop OAuth client',
  GOOGLE_REFRESH_TOKEN: 'run "npm run auth" and copy the printed value',
  BLOGGER_BLOG_ID: 'run "npm run auth" - it prints the id next to your blog name',
  GROQ_API_KEY: 'https://console.groq.com/keys',
};

/** True when the variable is unset or contains only spaces/quotes. */
function isEmpty(name) {
  const value = process.env[name];
  if (value === undefined || value === null) return true;
  return value.trim().replace(/^["']|["']$/g, '').trim() === '';
}

console.log('\n=== Blogger Agent : .env check ===\n');

let missingRequired = 0;

console.log('REQUIRED');
for (const name of REQUIRED) {
  const empty = isEmpty(name);
  if (empty) {
    missingRequired++;
    console.log(`  [ MISSING ] ${name}`);
    console.log(`             -> get it from: ${SOURCES[name]}`);
  } else {
    console.log(`  [   OK   ] ${name}  (value hidden on purpose)`);
  }
}

console.log('OPTIONAL (blank = built-in default is used)');
for (const name of OPTIONAL) {
  const empty = isEmpty(name);
  const label = empty ? 'default in use' : 'custom value set (hidden)';
  console.log(`  [ ${empty ? 'DEFAULT' : '  SET  '} ] ${name}  -> ${label}`);
}

console.log('IMAGES');
console.log('  No API key needed. Pollinations first, Openverse as backup,');
console.log('  images saved into images/ and served via jsDelivr.');

// Tell the user plainly whether this run will be a draft or live.
const draft = (process.env.PUBLISH_AS_DRAFT ?? '').trim().toLowerCase();
const liveDaily = (process.env.PUBLISH_LIVE_DAILY ?? '').trim().toLowerCase();
const willBeDraft = draft === '' ? true : draft === 'auto' ? liveDaily !== 'true' : draft !== 'false';

console.log('\nPUBLISH MODE');
console.log(
  `  ${willBeDraft
    ? 'DRAFT - readers will NOT see this post. Safe.'
    : 'LIVE  - the post will be published publicly and visible to readers!'}`
);
if (draft === 'auto') {
  console.log(`  (PUBLISH_AS_DRAFT="auto" and PUBLISH_LIVE_DAILY="${liveDaily || '(not set)'}")`);
}

console.log('');

if (missingRequired > 0) {
  console.log(`RESULT: ${missingRequired} required key(s) still missing. Fill them in .env, then run "npm run check" again.\n`);
  process.exit(1);
}

console.log('RESULT: all required keys are present. You can run "npm run auth" or "npm run post".\n');
process.exit(0);