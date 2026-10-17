// ============================================================
// scripts/auth.js
// ONE-TIME Google login that produces your GOOGLE_REFRESH_TOKEN
// and shows your BLOGGER_BLOG_ID.
//
// Flow (OAuth 2.0 loopback, for a Desktop app):
//   1. this script starts a tiny local web server
//   2. your browser opens Google's consent screen
//   3. you click Allow
//   4. Google sends the code back to localhost
//   5. we swap the code for tokens and PRINT the refresh token
//
// SECURITY: the refresh token is printed in your terminal only.
// This script never writes it to any file, so it can never end up
// in a git commit.
//
// Run with: npm run auth
// ============================================================

import 'dotenv/config';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';

const SCOPE = 'https://www.googleapis.com/auth/blogger';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const START_PORT = 3000;
const GIVE_UP_AFTER_MS = 5 * 60 * 1000; // 5 minutes

// ---- Small helpers --------------------------------------------

/** Checks if a port is free. Desktop apps may use any localhost port. */
function isPortFree(port) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => tester.close(() => resolve(true)));
    tester.listen(port, '127.0.0.1');
  });
}

/** Finds the first free port starting at START_PORT. */
async function findFreePort() {
  for (let port = START_PORT; port < START_PORT + 20; port++) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port between ${START_PORT} and ${START_PORT + 19}.`);
}

/** Opens a URL in the default browser on Windows / macOS / Linux. */
function openBrowser(url) {
  const platform = process.platform;
  let command;
  let args;

  if (platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '""', url]; // start is a built-in, not an exe
  } else if (platform === 'darwin') {
    command = 'open';
    args = [url];
  } else {
    command = 'xdg-open';
    args = [url];
  }

  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // If the browser will not open, the printed URL still works.
  }
}

/** Reads one variable out of .env. */
function env(name) {
  return process.env[name]?.trim() ?? '';
}

/** A plain HTML page so the browser shows something friendly. */
function htmlPage(title, lines) {
  return `<!doctype html><html><head><meta charset="utf-8">
<title>${title}</title>
<style>body{font-family:system-ui,Segoe UI,sans-serif;max-width:600px;margin:80px auto;padding:0 20px;line-height:1.7}
pre{background:#f4f4f5;padding:14px;border-radius:8px;overflow:auto;font-size:13px}
h1{font-size:22px}</style></head><body>
<h1>${title}</h1>
${lines.map((line) => `<p>${line}</p>`).join('\n')}
<p>You can close this tab and go back to the terminal.</p>
</body></html>`;
}

// ---- The script ------------------------------------------------

const clientId = env('GOOGLE_CLIENT_ID');
const clientSecret = env('GOOGLE_CLIENT_SECRET');

if (!clientId || !clientSecret) {
  console.error('\n[auth] GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET is missing from .env.');
  console.error('[auth] Open .env and paste both values from your Google OAuth Desktop client,');
  console.error('[auth] then run "npm run auth" again.\n');
  process.exit(1);
}

const port = await findFreePort();
const redirectUri = `http://localhost:${port}`;

const consentUrl =
  `${AUTH_URL}` +
  `?client_id=${encodeURIComponent(clientId)}` +
  `&redirect_uri=${encodeURIComponent(redirectUri)}` +
  `&response_type=code` +
  `&scope=${encodeURIComponent(SCOPE)}` +
  // offline  -> we get a refresh token (a long-lived one)
  // consent   -> force the consent screen every time, so we always get one
  `&access_type=offline` +
  `&prompt=consent` +
  `&state=blogger-agent`;

/** Resolves once the browser sends us a code (or an error). */
const codeReceived = new Promise((resolve, reject) => {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, redirectUri);

    // Google may send the "state" check as a query param on any path.
    if (!url.searchParams.has('code') && !url.searchParams.has('error')) {
      response.writeHead(404, { 'Content-Type': 'text/html' });
      response.end('<p>Nothing here. You can close this tab.</p>');
      return;
    }

    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    const state = url.searchParams.get('state');

    if (state && state !== 'blogger-agent') {
      response.writeHead(400, { 'Content-Type': 'text/html' });
      response.end('<p>state mismatch</p>');
      reject(new Error('state mismatch - possible CSRF, stopping.'));
      return;
    }

    if (error) {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end(htmlPage('Login was not completed', [`Google said: ${error}`]));
      reject(new Error(`Google returned error "${error}". Nothing was saved.`));
      return;
    }

    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(htmlPage('Login successful', ['You can copy the refresh token from the terminal now.']));

    server.close();
    resolve(code);
  });

  server.on('error', reject);
  server.listen(port, '127.0.0.1');
});

console.log('\n=== Blogger Agent : one-time Google login ===\n');
console.log(`Local callback server started on ${redirectUri}`);
console.log('Opening your browser now...\n');
console.log('--- Hinglish note -------------------------------------------------');
console.log('Browser mein "Google hasn\'t verified this app" warning aayega. Ye NORMAL hai.');
console.log('Aapke app ko Google ne verify nahi kiya hai, lekin personal use ke liye theek hai.');
console.log('  -> "Advanced" click karein');
console.log('  -> phir "Go to ... (unsafe)" click karein');
console.log('  -> phir "Allow" click karein');
console.log('-------------------------------------------------------------------\n');
console.log('Agar browser na khule, ye POORI line copy karke Chrome me kholiye.');
console.log('Dhyan rahe: URL poori copy ho, beech me se kuch na toote.\n');
// Printed flush-left on purpose, so there is no leading whitespace to
// copy along with it. Copying a wrapped URL is what causes
// "Required parameter is missing: response_type".
console.log(consentUrl);

openBrowser(consentUrl);

const code = await Promise.race([
  codeReceived,
  new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Timed out after 5 minutes. Nothing was saved.')), GIVE_UP_AFTER_MS)
  ),
]);

// ---- Swap the code for tokens ---------------------------------
const tokenResponse = await fetch(TOKEN_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  }),
});

const tokenBody = await tokenResponse.json().catch(() => ({}));

if (!tokenResponse.ok) {
  console.error('\n[auth] Google refused to exchange the code.');
  console.error(`[auth] Reason: ${tokenBody.error ?? tokenResponse.status}`);
  if (tokenBody.error_description) console.error(`[auth] ${tokenBody.error_description}`);
  console.error('\nHinglish: ye tabhi hota hai jab redirect_uri galat ho ya same browser');
  console.error('session mein login nahi hua. Dobara "npm run auth" chalao.\n');
  process.exit(1);
}

// ---- Print the refresh token ONCE -----------------------------
if (!tokenBody.refresh_token) {
  console.error('\n[auth] Google did NOT send a refresh token.');
  console.error('[auth] Ye tab hota hai jab Google ne purana consent na diya ho.');
  console.error('[auth] Fix: browser se logout, phir "npm run auth" dobara chalao.\n');
  process.exit(1);
}

const scopeGranted = String(tokenBody.scope ?? '');
const scopeOk = scopeGranted.includes('blogger');

console.log('\n================= STEP 1 OF 2 =================\n');
console.log('Ye line poora copy karke .env me paste kar dijiye:\n');
console.log('GOOGLE_REFRESH_TOKEN="' + tokenBody.refresh_token + '"');
console.log('\n----------------------------------------------');
console.log('Ye sirf ek baar dikhega aur kisi file me likha nahi gaya.');
console.log('Apne terminal ka scrollback mat bhejiye - wo public ho sakta hai.');
console.log('----------------------------------------------');
console.log(`\nPermission check: ${scopeOk ? 'Blogger scope GRANTED (sahi hai)' : 'BLOGGER SCOPE NAHI MILI - kuch gadbad hai'}`);
console.log(`Google ne jo permissions di: ${scopeGranted || '(khali)'}`);

// ---- Which Google account are we? -----------------------------
try {
  const whoResponse = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${tokenBody.access_token}` },
  });
  if (whoResponse.ok) {
    const who = await whoResponse.json();
    console.log(`Logged in as: ${who.email}`);
    if (scopeGranted && !/blogger/i.test(scopeGranted)) {
      console.log('\nNote: Blogger permission approve nahi hui. Is project ka OAuth');
      console.log('screen mein https://www.googleapis.com/auth/blogger add karke');
      console.log('"npm run auth" dobara chalao.\n');
    }
  }
} catch {
  // Not important enough to stop for.
}

// ---- Show the blog ids ----------------------------------------
console.log('\n================= STEP 2 OF 2 =================\n');
console.log('Aapke Blogger blogs (name | URL | id):\n');

try {
  const blogsResponse = await fetch('https://www.googleapis.com/blogger/v3/users/self/blogs', {
    headers: { Authorization: `Bearer ${tokenBody.access_token}` },
  });

  if (!blogsResponse.ok) {
    throw new Error(`HTTP ${blogsResponse.status}: ${await blogsResponse.text().catch(() => '')}`);
  }

  const blogs = (await blogsResponse.json()).items ?? [];

  if (blogs.length === 0) {
    console.log('  (koi blog nahi mila)');
  }

  for (const blog of blogs) {
    console.log(`  Name : ${blog.name}`);
    console.log(`  URL  : ${blog.url}`);
    console.log(`  Id   : ${blog.id}`);
    console.log(`  ---- .env me likhiye: BLOGGER_BLOG_ID="${blog.id}"\n`);
  }

  const target = blogs.find((blog) => blog.url?.includes('chetnatechblog'));
  if (target) {
    console.log('>>> Aapke blog (chetnatechblog.blogspot.com) ka id upar mil gaya hai.');
    console.log('>>> Bas wo line .env me paste kar dijiye.');
  } else {
    console.log('>>> "chetnatechblog.blogspot.com" is list me NAHI mila.');
    console.log('>>> Verify karein:');
    console.log('>>>   1. Browser mein wahi Google account se login hai?');
    console.log('>>>   2. Blog ka URL bilkul same hai?');
    console.log('>>>   3. Blog aapka hi hai (ya aap usmein editor ho)?');
  }
} catch (error) {
  console.error(`  Blogs list nahi mil payi: ${error.message}`);
  console.error('  Token phir bhi valid hai. Blogger > Settings mein blog id dikh jayega.');
}

console.log('\n=============================================\n');
console.log('Agle step: npm run post   (pehle DRAFT banega, live nahi)');
console.log('=============================================\n');
process.exit(0);