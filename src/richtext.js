'use strict';
// Formatted text (fonts, sizes, bold, lists) in activity reports. The editor in the browser sends HTML;
// only a small set of safe tags and classes is kept, so a report can never carry scripts or tracking.
const sanitizeHtml = require('sanitize-html');

const OPTIONS = {
  allowedTags: ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'ol', 'ul', 'li', 'h2', 'h3', 'blockquote', 'span', 'a'],
  allowedAttributes: { a: ['href'], li: ['data-list'], '*': ['class'] },
  allowedClasses: {
    '*': [/^ql-size-(small|large|huge)$/, /^ql-font-(serif|monospace)$/, /^ql-align-(center|right|justify)$/, /^ql-indent-[1-8]$/],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  transformTags: { a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer', target: '_blank' }) },
  allowedSchemesAppliedToAttributes: ['href'],
};
// target and rel are added by the transform, so they must be allowed too.
OPTIONS.allowedAttributes.a.push('rel', 'target');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const isHtml = (v) => /^\s*<(p|h2|h3|ol|ul|blockquote)[\s>]/i.test(String(v || ''));

/** Text of a value, without tags (for CSV exports and empty checks). */
function toText(value) {
  if (!isHtml(value)) return String(value || '');
  return sanitizeHtml(String(value).replace(/<\/(p|h2|h3|li|blockquote)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n'), { allowedTags: [], allowedAttributes: {} })
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n').trim();
}

/** Clean a submitted value: safe HTML, or plain text as typed. Empty editor content becomes ''. */
function clean(value, max = 60000) {
  const raw = String(value === undefined || value === null ? '' : value).slice(0, max);
  if (!isHtml(raw)) return raw.trim();
  const html = sanitizeHtml(raw, OPTIONS).trim();
  return toText(html).trim() ? html : '';
}

/** HTML to show on a page: formatted reports as they are, older plain-text reports as paragraphs. */
function toHtml(value) {
  if (!value) return '';
  if (isHtml(value)) return sanitizeHtml(String(value), OPTIONS);
  return String(value).split(/\r?\n\s*\r?\n/).map((para) => `<p>${esc(para).replace(/\r?\n/g, '<br>')}</p>`).join('');
}

module.exports = { clean, toHtml, toText, isHtml };
