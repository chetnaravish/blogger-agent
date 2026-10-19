// ============================================================
// src/cdn.js
// Blogger API se images upload nahi hoti, isliye hum images ko
// GitHub repo me save karte hain aur post me jsDelivr ka link
// lagate hain:
//
//   https://cdn.jsdelivr.net/gh/<user>/<repo>@main/images/<file>
//
// IMPORTANT: jsDelivr tab tak 404 deta hai jab tak image GitHub par
// push NAHI hoti. Isliye order ye hona zaroori hai:
//   1. images banao aur save karo
//   2. images commit + push karo
//   3. jsDelivr par 200 aane ka wait karo
//   4. phir post publish karo
// ============================================================

// Load .env so AUTO_COMMIT_PUSH and friends work when run on their own.
import 'dotenv/config';

import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, '..');
export const IMAGES_DIR = path.join(REPO_ROOT, 'images');

const JSDELIVR_CDN = 'https://cdn.jsdelivr.net/gh';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs a git command inside the project folder. Never uses a shell.
 *
 * We run git in REPO_ROOT, NOT in images/, because the images folder
 * may not exist yet on a brand new clone and git would fail.
 */
function git(args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: REPO_ROOT, windowsHide: true }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: String(stdout ?? '').trim(),
        stderr: String(stderr ?? '').trim(),
      });
    });
  });
}

/**
 * Reads the GitHub user and repo name from "origin" so you do not
 * have to configure them anywhere.
 *
 * Handles:
 *   https://github.com/user/repo.git
 *   git@github.com:user/repo.git
 * @returns {Promise<{user:string, repo:string, branch:string}|null>}
 */
export async function detectRepo() {
  const result = await git(['remote', 'get-url', 'origin'], REPO_ROOT);
  if (!result.ok || !result.stdout) return null;

  const match = result.stdout.match(/github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (!match) return null;

  const branchResult = await git(['rev-parse', '--abbrev-ref', 'HEAD'], REPO_ROOT);
  let branch = branchResult.stdout || 'main';
  if (branch === 'HEAD') branch = 'main'; // detached HEAD

  return { user: match[1], repo: match[2], branch };
}

/** Builds the public jsDelivr URL for a file inside images/. */
export function buildImageUrl(repo, filename) {
  const { user, repo: name, branch } = repo ?? {};
  if (!user || !name) return '';
  return `${JSDELIVR_CDN}/${user}/${name}@${branch ?? 'main'}/images/${encodeURIComponent(filename)}`;
}

/** True when the URL answers 200 (meaning the image is really live). */
export async function isUrlLive(url, timeoutMs = 15000) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      headers: { 'User-Agent': 'blogger-agent/1.0' },
    });
    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Waits until a freshly pushed image is really served by jsDelivr.
 * GitHub + jsDelivr dono cache karte hain, so this can take a
 * couple of minutes the first time.
 *
 * @returns {Promise<boolean>} true if the URL came alive in time
 */
export async function waitForImage(url, { timeoutMs = 180000, intervalMs = 10000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;

  console.log(`[cdn] Waiting for jsDelivr to serve ${path.basename(url)}...`);

  while (Date.now() < deadline) {
    attempt++;
    if (await isUrlLive(url)) {
      console.log(`[cdn] Image is live (check ${attempt}).`);
      return true;
    }
    console.log(`[cdn]   check ${attempt}: not yet, retrying in ${intervalMs / 1000}s...`);
    await sleep(intervalMs);
  }

  console.warn('[cdn] Timed out waiting for jsDelivr. The post will still be created.');
  return false;
}

/**
 * Commits and pushes the images folder.
 * Only used when AUTO_COMMIT_PUSH is on (GitHub Actions).
 *
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
export async function commitAndPush(message = 'chore: add blog images') {
  await git(['config', 'user.name', 'github-actions[bot]'], REPO_ROOT);
  await git(['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'], REPO_ROOT);

  const add = await git(['add', 'images'], REPO_ROOT);
  if (!add.ok) return { ok: false, reason: add.stderr || 'git add failed' };

  const commit = await git(['commit', '-m', message], REPO_ROOT);
  // "nothing to commit" is not an error for us.
  if (!commit.ok && !/nothing to commit/i.test(commit.stdout + commit.stderr)) {
    return { ok: false, reason: commit.stderr || 'git commit failed' };
  }

  // Work out which branch we are really on. GitHub Actions can check out
  // a detached HEAD, and a plain "git push origin HEAD" then either fails
  // or creates a branch literally named HEAD. So we name the target
  // explicitly instead.
  let branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], REPO_ROOT)).stdout;
  if (!branch || branch === 'HEAD') {
    // Detached: fall back to whatever origin is pointing at.
    const symbolic = await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], REPO_ROOT);
    branch = symbolic.ok && symbolic.stdout ? symbolic.stdout.replace('origin/', '') : 'main';
  }

  const push = await git(['push', 'origin', `HEAD:refs/heads/${branch}`], REPO_ROOT);
  if (!push.ok) return { ok: false, reason: push.stderr || 'git push failed' };

  console.log(`[cdn] Images committed and pushed to origin/${branch}.`);
  return { ok: true };
}