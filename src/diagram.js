// ============================================================
// src/diagram.js
// Draws ONE simple step diagram as inline SVG when the article
// would genuinely benefit from one.
//
// WHY HAND-BUILT SVG:
// Mermaid would need a new dependency and a browser engine. This
// project is zero-dependency on purpose, so we ask Groq for a tiny
// JSON recipe (boxes + arrows) and turn it into SVG ourselves.
//
// Hard rules:
//   - NEVER throws. A missing diagram never stops a post.
//   - The model only chooses "diagram or no diagram" and the words.
//     Every pixel is drawn by our own code, so the output is safe.
//   - All styling is inline, because Blogger strips <style> blocks.
// ============================================================

import { chat, extractJson } from './groq.js';

/** Colours for the boxes. Fixed values, never taken from the model. */
const COLORS = {
  box: '#eef4ff',
  border: '#4a6cf7',
  text: '#1f2937',
  arrow: '#4a6cf7',
  title: '#111827',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Escapes text for use inside SVG/XML. */
function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Asks the model for a diagram recipe, or for none at all.
 *
 * The model never draws anything. It only answers:
 *   {"use": true, "title": "...", "steps": ["...", "..."]}
 *
 * @returns {Promise<{use:boolean, title:string, steps:string[]}>}
 */
async function requestRecipe({ voice, topic, headings, categoryDescription }) {
  const prompt = `Decide whether this article needs a small diagram.

Topic: ${topic}
Sections: ${headings.join(' | ')}
Category: ${categoryDescription}

${voice}

Rules:
- Say use:true ONLY if a picture of 3 to 6 ordered steps, or a flow,
  would genuinely explain something the words explain slowly.
- Say use:false when the article is opinion, review or simple advice.
- Never force a diagram. Most articles do not need one.
- steps: 3 to 6 items, each under 60 characters, in the order a
  reader follows them. Plain words, no arrows, no punctuation marks
  other than a full stop.
- title: under 60 characters, the name of the flow.

Reply with ONLY this JSON:
{"use":false,"title":"","steps":[]}`;

  const raw = await chat(
    [
      { role: 'system', content: 'You are a careful editor. You reply with JSON only.' },
      { role: 'user', content: prompt },
    ],
    { json: true }
  );

  const recipe = extractJson(raw);
  if (!recipe || typeof recipe.use !== 'boolean') return { use: false, title: '', steps: [] };

  const steps = (Array.isArray(recipe.steps) ? recipe.steps : [])
    .map((step) => String(step ?? '').trim())
    .filter(Boolean)
    .slice(0, 6);

  return {
    use: recipe.use && steps.length >= 3,
    title: String(recipe.title ?? '').trim().slice(0, 70),
    steps,
  };
}

/**
 * Draws the recipe as an inline SVG.
 *
 * Layout: a vertical stack of rounded boxes with arrows between them.
 * Vertical keeps it readable on a phone, which is where most of the
 * readers of this blog will see it.
 *
 * @param {{title:string, steps:string[]}} recipe
 * @returns {string} an <svg> element with only inline attributes
 */
export function renderStepsSvg(recipe) {
  const steps = (recipe?.steps ?? []).filter(Boolean).slice(0, 6);
  if (steps.length < 2) return '';

  const BOX_W = 440;
  const BOX_H = 62;
  const GAP = 46;
  const SIDE = 60; // margin on each side
  const TITLE_H = recipe.title ? 54 : 18;
  const ARROW_W = 3;

  const width = BOX_W + SIDE * 2;
  const height = TITLE_H + steps.length * BOX_H + (steps.length - 1) * GAP + 24;
  const boxX = (width - BOX_W) / 2;

  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" ` +
      `width="${width}" height="${height}" role="img" ` +
      `aria-label="${escapeXml(recipe.title || 'Steps diagram')}" ` +
      `style="max-width:100%;height:auto;display:block;margin:1em auto;">`
  );

  // The SVG <title> is what screen readers read out.
  parts.push(`<title>${escapeXml(recipe.title || 'Steps in this article')}</title>`);

  if (recipe.title) {
    parts.push(
      `<text x="${width / 2}" y="34" text-anchor="middle" ` +
        `font-family="Segoe UI, Arial, sans-serif" font-size="22" font-weight="600" ` +
        `fill="${COLORS.title}">${escapeXml(recipe.title)}</text>`
    );
  }

  steps.forEach((step, index) => {
    const y = TITLE_H + index * (BOX_H + GAP);

    // The box itself.
    parts.push(
      `<rect x="${boxX}" y="${y}" width="${BOX_W}" height="${BOX_H}" rx="10" ` +
        `fill="${COLORS.box}" stroke="${COLORS.border}" stroke-width="2"/>`
    );

    // Step number, in a small circle on the left.
    parts.push(
      `<circle cx="${boxX + 34}" cy="${y + BOX_H / 2}" r="17" fill="${COLORS.border}"/>`
    );
    parts.push(
      `<text x="${boxX + 34}" y="${y + BOX_H / 2 + 6}" text-anchor="middle" ` +
        `font-family="Segoe UI, Arial, sans-serif" font-size="17" font-weight="700" ` +
        `fill="#ffffff">${index + 1}</text>`
    );

    // The label. Two lines at most, so a long step does not overflow.
    const words = step.split(/\s+/);
    let line1 = step;
    let line2 = '';
    if (step.length > 44) {
      const cut = Math.ceil(words.length / 2);
      line1 = words.slice(0, cut).join(' ');
      line2 = words.slice(cut).join(' ');
    }
    const midY = y + BOX_H / 2;
    const textX = boxX + 62;

    parts.push(
      `<text x="${textX}" y="${line2 ? midY - 5 : midY + 6}" ` +
        `font-family="Segoe UI, Arial, sans-serif" font-size="17" fill="${COLORS.text}">` +
        `${escapeXml(line1)}</text>`
    );
    if (line2) {
      parts.push(
        `<text x="${textX}" y="${midY + 17}" ` +
          `font-family="Segoe UI, Arial, sans-serif" font-size="17" fill="${COLORS.text}">` +
          `${escapeXml(line2)}</text>`
      );
    }

    // Arrow down to the next box.
    if (index < steps.length - 1) {
      const from = y + BOX_H;
      const to = y + BOX_H + GAP;
      const cx = width / 2;
      parts.push(
        `<line x1="${cx}" y1="${from + 6}" x2="${cx}" y2="${to - 12}" ` +
          `stroke="${COLORS.arrow}" stroke-width="${ARROW_W}"/>`
      );
      parts.push(
        `<polygon points="${cx - 8},${to - 14} ${cx + 8},${to - 14} ${cx},${to}" ` +
          `fill="${COLORS.arrow}"/>`
      );
    }
  });

  parts.push('</svg>');
  return parts.join('\n');
}

/**
 * The public entry point. Returns an SVG string, or an empty string.
 * Never throws - a failed diagram just means the article has none.
 *
 * @param {object} params
 * @param {object} params.article   the article from article.js
 * @param {object} params.category  the category entry (has diagram_usage)
 * @returns {Promise<{svg:string, title:string}>}
 */
export async function makeDiagram({ article, category, voice = '' }) {
  const svgFallback = { svg: '', title: '' };

  // Categories that never want a diagram do not even get an API call.
  const usage = String(category?.diagram_usage ?? '').toLowerCase();
  if (!usage || usage.startsWith('only when the news explains')) {
    return svgFallback;
  }

  const headings = (article?.sections ?? []).map((section) => section.heading).filter(Boolean);
  if (headings.length < 3) return svgFallback;

  try {
    const recipe = await requestRecipe({
      voice,
      topic: article.title,
      headings,
      categoryDescription: category?.description ?? '',
    });

    if (!recipe.use || recipe.steps.length < 3) {
      console.log('[diagram] No diagram needed for this article.');
      return svgFallback;
    }

    const svg = renderStepsSvg(recipe);
    if (!svg) return svgFallback;

    console.log(`[diagram] Drawing "${recipe.title}" with ${recipe.steps.length} steps.`);
    return { svg, title: recipe.title };
  } catch (error) {
    console.warn(`[diagram] Skipping the diagram: ${error.message}`);
    return svgFallback;
  }
}
