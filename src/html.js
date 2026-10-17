// ============================================================
// src/html.js
// Turns the article JSON into safe, clean, Blogger-ready HTML.
//
// Two jobs:
//  1. sanitizeHtml() - throws away anything the model should not
//     put in your blog (scripts, styles, weird attributes).
//  2. buildArticleHtml() - assembles hero image, intro, sections,
//     conclusion and the image credit footer.
// ============================================================

// Tags we are willing to publish.
const ALLOWED_TAGS = new Set([
  'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's',
  'ul', 'ol', 'li', 'h2', 'h3', 'h4',
  'blockquote', 'code', 'pre', 'a', 'hr',
  'span', 'div', 'figure', 'figcaption', 'img',
  'table', 'thead', 'tbody', 'tr', 'td', 'th',
]);

// Attributes we allow per tag. Everything else is removed.
const ALLOWED_ATTRS = {
  a: ['href', 'title'],
  img: ['src', 'alt', 'width', 'height'],
};

/** Turns & < > " ' into HTML entities so text can never become a tag. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Only http(s) and mailto links are safe to keep. */
function isSafeUrl(url) {
  return /^(https?:\/\/|mailto:)/i.test(url.trim());
}

/** Rebuilds one tag with only the attributes we allow. */
function cleanTag(tagName, attrsString, isClosing) {
  const name = tagName.toLowerCase();
  if (!ALLOWED_TAGS.has(name)) return ''; // drop the tag, keep the words inside

  if (isClosing) return `</${name}>`;

  const allowed = ALLOWED_ATTRS[name] ?? [];
  if (allowed.length === 0) return `<${name}>`;

  const kept = [];
  // Read attributes in the form name="value".
  const attrPattern = /([a-zA-Z-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let match;

  while ((match = attrPattern.exec(attrsString)) !== null) {
    const attrName = match[1].toLowerCase();
    const value = match[3] ?? match[4] ?? match[5] ?? '';
    if (!allowed.includes(attrName)) continue;
    if ((attrName === 'href' || attrName === 'src') && !isSafeUrl(value)) continue;
    kept.push(`${attrName}="${escapeHtml(value)}"`);
  }

  return `<${name}${kept.length ? ' ' + kept.join(' ') : ''}>`;
}

/**
 * Removes scripts, styles and unsafe tags/attributes from an HTML
 * string produced by an AI model.
 */
export function sanitizeHtml(dirtyHtml) {
  if (!dirtyHtml) return '';

  let html = String(dirtyHtml);

  // 1. Delete dangerous blocks INCLUDING what is inside them.
  html = html.replace(/<\s*(script|style|iframe|object|embed|noscript)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
  // Unclosed dangerous tags, e.g. a lonely <script ...>
  html = html.replace(/<\s*(script|style|iframe|object|embed|noscript)\b[^>]*>/gi, '');

  // 2. Delete HTML comments (Blogger treats some of them specially).
  html = html.replace(/<!--[\s\S]*?-->/g, '');

  // 3. Go tag by tag: keep allowed ones, drop the rest.
  html = html.replace(/<\s*(\/?)\s*([a-zA-Z0-9]+)([^>]*)>/g, (_full, slash, tagName, attrs) =>
    cleanTag(tagName, attrs, slash === '/')
  );

  // 4. Any leftover "<" is plain text, so escape it.
  html = html.replace(/<(?!\/?[a-zA-Z])/g, '&lt;');

  return html.trim();
}

/** Wraps a paragraph safely. */
const para = (text) => `<p>${escapeHtml(text)}</p>`;

/**
 * One image + its credit line.
 *
 * Pollinations pictures have no photographer to credit.
 * Openverse photos may need one (CC BY always does), so we show the
 * photographer name and the license link underneath.
 */
function figure(image, alt) {
  if (!image) return '';

  const altText = image.alt || alt || 'Article image';
  const parts = [
    '<figure style="margin:0 0 1em 0;">',
    `<img src="${escapeHtml(image.url)}" alt="${escapeHtml(altText)}"`,
    ' style="max-width:100%;height:auto;border-radius:6px;" loading="lazy" />',
  ];

  // Credit line, only when there is someone or something to credit.
  if (image.credit) {
    const { creator, license, licenseVersion, licenseUrl, pageUrl } = image.credit;
    const licenseLabel = `CC ${String(license ?? '').toUpperCase()} ${licenseVersion ?? ''}`.trim();

    parts.push('<figcaption style="font-size:0.85em;color:#666;">');
    parts.push(`Photo by ${escapeHtml(creator)}`);

    if (licenseUrl) {
      parts.push(` / <a href="${escapeHtml(licenseUrl)}" target="_blank" rel="noopener nofollow">${escapeHtml(licenseLabel)}</a>`);
    } else {
      parts.push(` / ${escapeHtml(licenseLabel)}`);
    }

    if (pageUrl) {
      parts.push(` / <a href="${escapeHtml(pageUrl)}" target="_blank" rel="noopener nofollow">Source</a>`);
    }

    parts.push('</figcaption>');
  }

  parts.push('</figure>');
  return parts.join('');
}

/**
 * Builds the final post content.
 *
 * @param {object} article  the JSON produced by article.js
 * @param {{hero?:object, sections?:object[]}} images  from images.js
 *        Each image needs: { url, alt, credit? }
 * @returns {string} HTML
 */
export function buildArticleHtml(article, images = {}) {
  const sectionImages = Array.isArray(images.sections) ? images.sections : [];
  const parts = [];

  // 1. Hero image at the very top.
  if (images.hero) parts.push(figure(images.hero, article.title));

  // 2. Intro.
  if (article.intro) parts.push(para(article.intro));

  // 3. Sections, each h2 + body, with an image after it where we have one.
  (article.sections ?? []).forEach((section, index) => {
    if (section?.heading) parts.push(`<h2>${escapeHtml(section.heading)}</h2>`);
    if (section?.body_html) parts.push(sanitizeHtml(section.body_html));
    const image = sectionImages[index];
    if (image) {
      parts.push(figure(image, section?.heading || article.title));
    }
  });

  // 4. Conclusion.
  if (article.conclusion) {
    parts.push('<h2>Conclusion</h2>');
    parts.push(para(article.conclusion));
  }

  // 5. Small credit footer. We list every source we actually used.
  const used = [images.hero, ...sectionImages].filter(Boolean);
  if (used.length > 0) {
    const fromOpenverse = used.some((image) => image.credit);
    const note = fromOpenverse
      ? 'Some images are from <a href="https://openverse.org/" target="_blank" rel="noopener">Openverse</a>. Credits are shown under each image.'
      : 'Images were created with <a href="https://pollinations.ai/" target="_blank" rel="noopener">Pollinations</a>.';

    parts.push(
      '<hr />' +
        `<p style="font-size:0.85em;color:#666;">${note}</p>`
    );
  }

  return parts.filter(Boolean).join('\n');
}