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

/**
 * Splits one long paragraph into readable pieces of about 55 words.
 *
 * The writer sometimes returns the intro as a single 150-word block.
 * On a phone that is a wall of grey nobody finishes. We cut it on
 * sentence boundaries only - never mid-sentence - so it still reads
 * like a person wrote it.
 *
 * @param {string} text
 * @returns {string[]} 1 or more paragraphs
 */
function splitParagraphs(text) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  if (words.length <= 70) return [String(text ?? '').trim()].filter(Boolean);

  // Split into sentences, keeping the punctuation with each one.
  const sentences = String(text)
    .split(/(?<=[.!?])\s+(?=[A-Z"'0-9])/)
    .map((s) => s.trim())
    .filter(Boolean);

  const out = [];
  let current = [];
  let count = 0;
  for (const sentence of sentences) {
    const n = sentence.split(/\s+/).length;
    // Start a new paragraph when this one would pass 70 words.
    if (current.length > 0 && count + n > 70) {
      out.push(current.join(' '));
      current = [];
      count = 0;
    }
    current.push(sentence);
    count += n;
  }
  if (current.length > 0) out.push(current.join(' '));

  // Safety: if the sentences refused to split, fall back to one block.
  return out.length > 0 ? out : [String(text ?? '').trim()];
}

/** Wraps a paragraph safely, splitting long ones so nothing becomes a wall. */
const para = (text) =>
  splitParagraphs(text)
    .map((p) => `<p>${escapeHtml(p)}</p>`)
    .join('\n');

/**
 * Finds <p> blocks over 70 words inside already-built HTML and splits
 * them into shorter paragraphs. The section writer sometimes returns one
 * 169-word paragraph; we cut it so the page never shows a wall of grey.
 *
 * The split happens ONLY at a sentence end that sits at the top level -
 * never inside a <strong> or any other tag - so inline markup survives.
 *
 * @param {string} html
 * @returns {string}
 */
export function splitLongParagraphsInHtml(html) {
  return String(html).replace(
    /<p(\s[^>]*)?>([\s\S]*?)<\/p>/g,
    (whole, attrs = '', inner) => {
      const plain = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (plain.split(/\s+/).filter(Boolean).length <= 70) return whole;

      const pieces = splitTopLevelSentences(inner);
      if (pieces.length <= 1) return whole;
      const attrsStr = attrs ?? '';
      return pieces.map((piece) => `<p${attrsStr}>${piece}</p>`).join('\n');
    }
  );
}

/** Void elements never have a </close>, so they must not change depth. */
const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link']);

/** One tag token, or null when this is plain text. */
const TAG_RE = /<[^>]*>/;
const OPEN_RE = /^<(?!\/)([a-z0-9]+)/i;
const CLOSE_RE = /^<\/([a-z0-9]+)/i;

/** How many words one paragraph may hold before we cut it. */
const MAX_PARA_WORDS = 70;

/**
 * A buffer shorter than this is not worth closing on its own - it would
 * turn one paragraph into a column of three-word stubs.
 */
const MIN_PARA_WORDS = 30;

/** Words in an HTML fragment, tags ignored. */
const wordCount = (html) =>
  html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').trim().split(/\s+/).filter(Boolean).length;

/**
 * Splits an HTML fragment into chunks that end only at sentence ends
 * sitting OUTSIDE every tag, then groups those chunks into paragraphs
 * of at most MAX_PARA_WORDS.
 *
 * Two guarantees:
 *  - a full stop inside <strong> or an href never breaks the markup,
 *    because cuts happen only where the tag depth is 0;
 *  - a piece is never longer than the limit (unless a single sentence
 *    itself is longer, which we cannot cut without breaking it).
 *
 * @param {string} html
 * @returns {string[]} the paragraphs, HTML balanced in each one
 */
function splitTopLevelSentences(html) {
  // ---- step 1: cut at every top-level sentence end ----
  const chunks = [];
  let depth = 0;
  let current = '';
  let rest = String(html);

  const pushChunk = () => {
    if (current.trim()) chunks.push(current);
    current = '';
  };

  while (rest.length > 0) {
    const match = rest.match(TAG_RE);

    if (match && match.index === 0) {
      // Tags join the current chunk and only change the depth.
      const tag = match[0];
      current += tag;
      rest = rest.slice(tag.length);
      const open = tag.match(OPEN_RE);
      const close = tag.match(CLOSE_RE);
      if (open && !VOID_TAGS.has(open[1].toLowerCase()) && !/\/>$/.test(tag)) depth += 1;
      else if (close) depth = Math.max(0, depth - 1);
      continue;
    }

    const take = match ? match.index : rest.length;
    const text = rest.slice(0, take);
    rest = rest.slice(take);

    if (depth > 0) {
      current += text; // inside a tag: never a cut point
      continue;
    }
    // Top level: every sentence end closes a chunk.
    const parts = text.split(/(?<=[.!?])\s+/);
    parts.forEach((part, i) => {
      current += part;
      if (i < parts.length - 1) pushChunk();
    });
  }
  pushChunk();

  // ---- step 2: group chunks so no paragraph passes the limit ----
  const grouped = [];
  let buffer = '';
  let bufferWords = 0;
  for (const chunk of chunks) {
    const words = wordCount(chunk);
    // Cut before this chunk only when the buffer already reads like a
    // paragraph of its own - that keeps pieces in the 30-70 word range.
    if (buffer && bufferWords + words > MAX_PARA_WORDS && bufferWords >= MIN_PARA_WORDS) {
      grouped.push(buffer.trim());
      buffer = '';
      bufferWords = 0;
    }
    buffer += (buffer && !/\s$/.test(buffer) ? ' ' : '') + chunk;
    bufferWords += words;
  }
  if (buffer.trim()) grouped.push(buffer.trim());

  return grouped;
}

/**
 * One image + its credit line.
 *
 * Pixabay's Content License does not force a credit, but we show one
 * anyway so the reader always knows where a picture came from.
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
    const { creator, license, licenseVersion, licenseUrl, pageUrl, licenseLabel } = image.credit;
    // The credit module can give us a ready-made label (Pixabay does
    // not use a Creative Commons licence), otherwise we build one.
    const label = licenseLabel || `CC ${String(license ?? '').toUpperCase()} ${licenseVersion ?? ''}`.trim();

    parts.push('<figcaption style="font-size:0.85em;color:#666;">');
    parts.push(`Photo by ${escapeHtml(creator)}`);

    if (licenseUrl) {
      parts.push(` / <a href="${escapeHtml(licenseUrl)}" target="_blank" rel="noopener nofollow">${escapeHtml(label)}</a>`);
    } else {
      parts.push(` / ${escapeHtml(label)}`);
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
 * The portfolio call-to-action.
 *
 * A small, quiet box placed mid-article where the reader has just seen
 * something useful and is most likely to want a real example. Only the
 * words the writer chose are used here - the link itself is ours.
 *
 * @param {string} line     one sentence written for this article
 * @param {string} url      the portfolio address
 */
function portfolioBox(line, url) {
  if (!line || !url) return '';

  return (
    '<div style="margin:1.6em 0;padding:1em 1.1em;background:#f1f5ff;border-left:4px solid #4a6cf7;border-radius:6px;">' +
    `<p style="margin:0 0 .5em 0;font-size:1.02em;">${escapeHtml(line)} ` +
    `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">See it in my portfolio</a>` +
    '<span style="color:#666;font-size:.9em;">.</span></p>' +
    '</div>'
  );
}

/**
 * Builds the final post content.
 *
 * @param {object} article  the JSON produced by article.js
 * @param {{hero?:object, sections?:object[]}} images  from images.js
 *        Each image needs: { url, alt, credit? }
 * @param {object} [options]
 * @param {string} [options.portfolioUrl] when set (and the article has a
 *        portfolio_line) the link is inserted at the chosen spot.
 * @returns {string} HTML
 */
export function buildArticleHtml(article, images = {}, options = {}) {
  const sectionImages = Array.isArray(images.sections) ? images.sections : [];
  const parts = [];

  // Where the portfolio line goes. The model picks the section number;
  // we clamp it so a bad answer can never place it outside the article.
  const sectionsCount = (article.sections ?? []).length;
  const portfolioIndex = Math.min(
    Math.max(Number(article.portfolio_after) || 2, 1),
    Math.max(sectionsCount - 1, 1)
  );
  const portfolioHtml = options.portfolioUrl
    ? portfolioBox(article.portfolio_line, options.portfolioUrl)
    : '';

  // 1. Hero image at the very top.
  if (images.hero) parts.push(figure(images.hero, article.title));

  // 2. Intro.
  if (article.intro) parts.push(para(article.intro));

  // 3. Sections, each h2 + body, with an image after it where we have one.
  (article.sections ?? []).forEach((section, index) => {
    if (section?.heading) parts.push(`<h2>${escapeHtml(section.heading)}</h2>`);
    if (section?.body_html) {
      // The writer sometimes hands back one 169-word paragraph - cut it
      // down to readable pieces before it reaches the page.
      parts.push(splitLongParagraphsInHtml(sanitizeHtml(section.body_html)));
    }
    const image = sectionImages[index];
    if (image) {
      parts.push(figure(image, section?.heading || article.title));
    }
    // The portfolio line lands after the section the writer chose,
    // so it reads as a natural next step rather than an ad.
    if (portfolioHtml && index + 1 === portfolioIndex) parts.push(portfolioHtml);
  });

  // 4. Conclusion.
  if (article.conclusion) {
    parts.push('<h2>Conclusion</h2>');
    parts.push(para(article.conclusion));
  }

  // 5. Small credit footer. One line naming the single source we use now.
  const used = [images.hero, ...sectionImages].filter(Boolean);
  if (used.length > 0) {
    parts.push(
      '<hr />' +
        '<p style="font-size:0.85em;color:#666;">' +
        'Images from <a href="https://pixabay.com/" target="_blank" rel="noopener">Pixabay</a>, ' +
        'used under the Pixabay Content License.' +
        '</p>'
    );
  }

  return parts.filter(Boolean).join('\n');
}