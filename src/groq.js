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

// llama-3.3-70b-versatile was retired by Groq. This is the current
// large text model and it supports JSON output, which we need.
const DEFAULT_MODEL = 'openai/gpt-oss-120b';

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

  const candidates = modelIds.filter((id) => typeof id === 'string' && id && !notTextModels.test(id));
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

/**
 * Sends a chat completion and returns the assistant's text.
 *
 * @param {Array<{role:string, content:string}>} messages
 * @param {{ json?: boolean }} options  json:true asks for a JSON-only answer
 */
export async function chat(messages, options = {}) {
  const body = {
    model: getActiveModel(),
    messages,
    temperature: 0.8,
    max_tokens: 4096,
  };

  // We start in strict JSON mode. If the model keeps failing to produce
  // valid JSON, we drop to plain text on the last attempt and parse it
  // ourselves. extractJson() is good enough for that.
  let useJsonMode = Boolean(options.json);
  let plainModeHinted = false;

  const maxAttempts = useJsonMode ? 4 : 3;

  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (useJsonMode) {
      body.response_format = { type: 'json_object' };
    } else {
      delete body.response_format;
      // Remind the model what to return now that we are not forcing it.
      if (options.json && !plainModeHinted) {
        plainModeHinted = true;
        body.messages = [
          ...messages,
          {
            role: 'system',
            content:
              'IMPORTANT: reply with ONLY a single valid JSON object. ' +
              'No markdown, no code fences, no explanation before or after it.',
          },
        ];
      }
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

      if (!response.ok) {
        const error = await toError(response, 'Groq chat completion');
        if (error.status === 401) {
          throw new Error('Groq rejected GROQ_API_KEY (401). Copy the key again from console.groq.com/keys');
        }
        throw error;
      }

      const data = await response.json();
      return data?.choices?.[0]?.message?.content ?? '';
    } catch (error) {
      lastError = error;

      const canSwitchModel = isModelProblem(error) && attempt < maxAttempts && body.model === getActiveModel();
      if (canSwitchModel) {
        body.model = await resolveModel();
        continue;
      }

      // 429 = too many requests / rate limit: wait and retry.
      if (error.status === 429 && attempt < maxAttempts) {
        const waitSeconds = 15 * attempt;
        console.warn(`[groq] Rate limited. Waiting ${waitSeconds}s and retrying...`);
        await sleep(waitSeconds * 1000);
        continue;
      }

      // The model produced invalid JSON. Usually it fixes itself next time.
      if (isJsonValidationProblem(error) && attempt < maxAttempts) {
        // One before the end: stop forcing JSON mode and parse it ourselves.
        if (attempt === maxAttempts - 1) {
          useJsonMode = false;
          console.warn('[groq] JSON mode keeps failing. Asking for plain JSON text and parsing it here.');
          continue;
        }
        const waitSeconds = 3 * attempt;
        console.warn(`[groq] Model returned invalid JSON. Waiting ${waitSeconds}s and retrying...`);
        await sleep(waitSeconds * 1000);
        continue;
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