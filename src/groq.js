// ============================================================
// src/groq.js
// Thin wrapper around the Groq OpenAI-compatible API.
// Used by topic.js and article.js.
//
// It also handles the "model retired" problem: if the configured
// model no longer exists, we ask Groq which text models ARE
// available right now, pick one, and tell you which one we used.
// ============================================================

// Load .env so this module works on its own, not just via index.js.
// dotenv is safe to load twice - it never overwrites a real env var,
// which is what GitHub Actions needs.
import 'dotenv/config';

const BASE_URL = 'https://api.groq.com/openai/v1';

// Keep track of the model we are actually using. If we auto-switch
// because the old model was retired, we reuse the new one this run.
let activeModel = null;

// qwen/qwen3.8-27b returns strict JSON reliably and is not a "reasoning"
// model. The gpt-oss family burns the token budget on thinking and returns
// an empty answer, which breaks our JSON pipeline.
const DEFAULT_MODEL = 'qwen/qwen3.8-27b';

/** The model to use: from .env if set, otherwise our default. */
export function getActiveModel() {
  const fromEnv = process.env.GROQ_MODEL?.trim();
  activeModel = activeModel || fromEnv || DEFAULT_MODEL;
  return activeModel;
}

function requireApiKey() {
  const key = process.env.GROQ_API_KEY?.trim();
  if (!key) throw new Error('GROQ_API_KEY is missing. Run "npm run check" and fill it in .env');
  return key;
}

/** Sleep helper for retry delays. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Turns a failed fetch into an Error carrying the HTTP status. */
async function toError(response, what) {
  const body = await response.text().catch(() => '');
  const error = new Error(`${what} failed (HTTP ${response.status}): ${body.slice(0, 400)}`);
  error.status = response.status;
  error.body = body;
  return error;
}

/**
 * True when Groq complained about the MODEL itself, not about our
 * prompt. That is the only error we recover from automatically.
 */
function isModelProblem(error) {
  if (error.status !== 400 && error.status !== 404 && error.status !== 422) return false;
  const text = `${error.body || ''} ${error.message}`.toLowerCase();
  return (
    text.includes('model_not_found') ||
    text.includes('deprecat') ||
    text.includes('not available') ||
    text.includes('does not exist') ||
    text.includes('is not found') ||
    text.includes('no such model') ||
    text.includes('invalid model')
  );
}

/**
 * True when Groq rejected the ANSWER because it was not valid JSON.
 * Some models fail this randomly. A retry usually fixes it, so it
 * must not be allowed to kill the whole run.
 */
function isJsonValidationProblem(error) {
  if (error.status !== 400) return false;
  const text = `${error.body || ''} ${error.message}`.toLowerCase();
  return text.includes('json_validate_failed') || text.includes('failed to validate json');
}

/** GET /models - list of every model Groq offers right now. */
export async function listModels() {
  const response = await fetch(`${BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${requireApiKey()}` },
  });
  if (!response.ok) throw await toError(response, 'Groq GET /models');
  const data = await response.json();
  return Array.isArray(data?.data) ? data.data.map((m) => m.id) : [];
}

/**
 * Picks the best CURRENT text/chat model from Groq's list.
 * We throw away models meant for audio, images, video and
 * moderation, then prefer the biggest "versatile" chat model.
 */
export function pickSuitableModel(modelIds) {
  // Audio, image, video, moderation and "terms acceptance" models are
  // useless for writing blog posts (and some cannot be called at all).
  const notTextModels =
    /whisper|barge|guard|safeguard|orpheus|vision|tts|audio|embed|moderation|clip|ocr|speech|image|compound-beta|nn-comp|pdb/i;

  // "gpt-oss" models are excluded too: they are reasoning models, so they
  // burn the whole token budget thinking and come back with an empty or
  // invalid-JSON answer. They are the biggest models on the list, so
  // without this line our scoring would always pick one.
  const reasoningModels = /gpt-oss/i;

  const candidates = modelIds.filter(
    (id) => typeof id === 'string' && id && !notTextModels.test(id) && !reasoningModels.test(id)
  );
  if (candidates.length === 0) return null;

  // Higher score = better pick.
  const score = (id) => {
    let points = 0;
    if (/versatile/i.test(id)) points += 50;
    if (/instant/i.test(id)) points += 25;
    if (/chat/i.test(id)) points += 15;
    // Model names end with the size, e.g. "llama-3.3-70b" -> 70
    const size = id.match(/(\d+)b/i);
    if (size) points += Math.min(Number(size[1]), 100);
    return points;
  };

  return candidates
    .slice()
    .sort((a, b) => score(b) - score(a))[0];
}

/** Finds a working model and remembers it for the rest of the run. */
async function resolveModel() {
  const current = getActiveModel();
  const available = await listModels();
  if (available.includes(current)) return current; // still fine, keep using it

  const better = pickSuitableModel(available);
  if (!better) {
    throw new Error(
      `Model "${current}" is not available on Groq and no replacement text model was found. ` +
        `Check your GROQ_API_KEY or set GROQ_MODEL to one of: ${available.slice(0, 5).join(', ')}`
    );
  }
  activeModel = better;
  console.log(`[groq] Model "${current}" is retired. Switched to "${better}".`);
  return better;
}

// Article generations are long, but 2500 tokens is plenty for ~1000 words.
// Keeping this low matters: Groq allows only ~8000 tokens PER MINUTE, and a
// too-high max_tokens makes us hit that ceiling and get the connection
// dropped mid-request.
const MAX_TOKENS = 2500;

// Remembers when we last called Groq, and how long the token budget needs.
let nextGroqCallNotBefore = 0;

/**
 * Reads the rate-limit headers so we can wait instead of hammering.
 * Returns milliseconds to wait before the next call (0 = go now).
 */
function rateLimitWaitMs(response) {
  const resetTokens = Number(response.headers.get('x-ratelimit-reset-tokens'));
  const remainingTokens = Number(response.headers.get('x-ratelimit-remaining-tokens'));

  if (!Number.isFinite(resetTokens)) return 0;
  // If the budget is nearly gone, wait for it to refill.
  if (Number.isFinite(remainingTokens) && remainingTokens < MAX_TOKENS) {
    return Math.max(1000, Math.ceil(resetTokens * 1000) + 500);
  }
  return 0;
}

/** Waits out the token budget so the next call is not dropped. */
async function respectRateLimit() {
  const wait = nextGroqCallNotBefore - Date.now();
  if (wait > 0) await sleep(wait);
}

// Takes a fetch error and explains it properly. Node hides the real reason
// in error.cause, which is why "fetch failed" is such a useless message.
function describeNetworkError(error) {
  const cause = error?.cause;
  const code = cause?.code ?? '';
  const details = {
    ECONNRESET: 'the connection was reset (very often the per-minute token limit was hit)',
    ETIMEDOUT: 'the request timed out',
    ENOTFOUND: 'the internet or DNS could not reach api.groq.com',
    ECONNREFUSED: 'the connection was refused',
    EAI_AGAIN: 'the internet connection dropped (Wi-Fi blip)',
    UND_ERR_SOCKET: 'the socket closed unexpectedly',
  };
  const because = details[code] ?? cause?.message ?? 'unknown network problem';
  return `${error.message} (${code || 'no code'}) - ${because}`;
}

/**
 * Sends a chat completion and returns the assistant's text.
 *
 * Retry plan (deliberately short, because every retry costs tokens):
 *   1. strict JSON mode
 *   2. strict JSON mode again, but only after the token budget refills
 *   3. plain text - we parse the JSON ourselves with extractJson()
 *
 * @param {Array<{role:string, content:string}>} messages
 * @param {{ json?: boolean }} options  json:true asks for a JSON-only answer
 */
export async function chat(messages, options = {}) {
  const wantsJson = Boolean(options.json);

  // We start in strict JSON mode. If the model will not produce valid JSON,
  // we drop to plain text and parse it ourselves. extractJson() handles
  // code fences and surrounding prose well enough.
  let useJsonMode = wantsJson;
  let plainModeHinted = false;
  let attemptsLeft = wantsJson ? 3 : 2;

  let lastError = null;

  while (attemptsLeft > 0) {
    attemptsLeft--;

    await respectRateLimit();

    const body = {
      model: getActiveModel(),
      messages: useJsonMode ? messages : messages,
      temperature: 0.8,
      max_tokens: MAX_TOKENS,
    };

    if (useJsonMode) {
      body.response_format = { type: 'json_object' };
    } else if (wantsJson && !plainModeHinted) {
      // Remind the model what to return now that we stopped forcing it.
      plainModeHinted = true;
      body.messages = [
        ...messages,
        {
          role: 'system',
          content:
            'IMPORTANT: reply with ONLY a single valid JSON object. ' +
            'No markdown, no code fences, no text before or after it.',
        },
      ];
    }

    try {
      const response = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${requireApiKey()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      // Remember when we may call again.
      nextGroqCallNotBefore = Date.now() + rateLimitWaitMs(response);

      if (!response.ok) {
        const error = await toError(response, 'Groq chat completion');

        if (error.status === 401) {
          throw new Error('Groq rejected GROQ_API_KEY (401). Copy the key again from console.groq.com/keys');
        }

        // A retired model is the one error we recover from automatically.
        if (isModelProblem(error) && attemptsLeft > 0) {
          body.model = await resolveModel();
          continue;
        }

        // Rate limited: wait for the server to tell us how long, then retry.
        if ((error.status === 429 || error.status === 503) && attemptsLeft > 0) {
          const waitSeconds = 20;
          console.warn(`[groq] ${error.status} from Groq. Waiting ${waitSeconds}s so the token limit resets...`);
          nextGroqCallNotBefore = Date.now() + waitSeconds * 1000;
          continue;
        }

        // The model produced invalid JSON. Stop forcing JSON mode.
        if (isJsonValidationProblem(error) && attemptsLeft > 0) {
          if (useJsonMode) {
            useJsonMode = false;
            console.warn('[groq] Model would not produce valid JSON. Asking for plain JSON text and parsing it here.');
            nextGroqCallNotBefore = Date.now() + 12000;
            continue;
          }
        }

        throw error;
      }

      const data = await response.json();
      return data?.choices?.[0]?.message?.content ?? '';
    } catch (error) {
      lastError = error;

      // Never retry these, they will always fail.
      if (error.status === 401 || !error.status) {
        const isNetwork = !error.status;
        if (isNetwork && attemptsLeft > 0) {
          // fetch failed / socket hang up / timeout. Usually a dropped
          // connection, often from the per-minute token limit.
          const waitSeconds = 20;
          console.warn(`[groq] ${describeNetworkError(error)}. Waiting ${waitSeconds}s and retrying...`);
          nextGroqCallNotBefore = Date.now() + waitSeconds * 1000;
          continue;
        }
        if (isNetwork) {
          throw new Error(describeNetworkError(error));
        }
      }

      throw error;
    }
  }

  throw lastError ?? new Error('Groq chat completion failed for an unknown reason');
}

/**
 * Models answer JSON in three ways: clean, wrapped in ```json fences,
 * or buried in a sentence. This gets the JSON object out of all three.
 */
export function extractJson(text) {
  if (!text) return null;

  // Remove markdown fences if present.
  const withoutFences = text.replace(/```(?:json)?/gi, '').replace(/```/g, '');

  const start = withoutFences.indexOf('{');
  const end = withoutFences.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;

  try {
    return JSON.parse(withoutFences.slice(start, end + 1));
  } catch {
    return null;
  }
}