// Static-site speed entry — a faster drop-in for makefun-site 1.0.0.
// Written from scratch from the vendor README + reference code semantics.
// Single file, dependency-free ES module. run(input) returns the output tree
// (path -> text) for one case, byte-identical to makefun-site 1.0.0's build.
//
// Speed strategy: the reference spends ~39% of its CPU calling escapeHtml once
// per character inside inline(), and materialises token objects for every
// Markdown block. This implementation fuses lex+render into one pass, scans
// inline text with one native regexp and appends plain runs verbatim (they
// hold no escapable character by construction), builds strings in chunk
// arrays joined once, and keeps every cache inside the per-run context
// (nothing is cached across run() calls).

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The report file every build writes. */
export const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

// ---------------------------------------------------------------- text

/** The HTML escape table, in this order: & < > " ' */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** `text` with & < > " and ' escaped. Fast path: most strings hold none of them. */
function escapeHtml(text) {
  if (!/[&<>"']/.test(text)) return text;
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of
 * characters other than a-z and 0-9 one "-", none at either end, at most
 * SLUG_MAX characters (a "-" left at the cut dropped), "untitled" when
 * nothing is left. Verbatim semantics of the reference (text.js).
 */
function slugifyRaw(text) {
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDateRaw(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/**
 * The words of a body: its runs of characters other than whitespace. Counted
 * with an exec loop instead of match(): the reference's match() builds an
 * array of every word (hundreds of strings per body) just to count them.
 */
function wordsOf(text) {
  const re = /\S+/g;
  let n = 0;
  while (re.exec(text) !== null) n++;
  return n;
}

/** `rel` (a link's path, "/"-separated) from the directory `dir`, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends. Unlike the
 * reference's split/join, this scans with indexOf: the body is one slice of
 * the original string, never re-joined.
 */
function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  let closeStart = -1;
  let closeEnd = -1;
  const idx = text.indexOf('\n---\n', 3);
  if (idx !== -1) {
    closeStart = idx + 1;
    closeEnd = idx + 5;
  } else if (text.endsWith('\n---')) {
    closeStart = text.length - 3;
    closeEnd = text.length;
  } else {
    return { error: 'the front matter is not closed' };
  }
  const data = {};
  let pos = 4; // just after the opening "---\n"
  let lineNo = 2; // 1-based number of the line starting at pos
  while (pos < closeStart) {
    let eol = text.indexOf('\n', pos);
    if (eol === -1 || eol > closeStart) eol = closeStart;
    const line = text.slice(pos, eol);
    if (!/^[ \t]*$/.test(line) && !line.startsWith('#')) {
      const m = LINE.exec(line);
      if (!m) return { error: `line ${lineNo} is not "key: value"` };
      const key = m[1];
      const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
      if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    pos = eol + 1;
    lineNo++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeEnd) };
}

// ---------------------------------------------------------------- markdown

const BLANK = /^[ \t]*$/;
const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const QUOTE = /^>/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;
const WS = /\s/;

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

/**
 * Whether `line` ends a paragraph: a blank line, a fence, a heading or a
 * thematic break. Dispatched on the first character: only `, # and -/* can
 * start a fence, heading or break, and only a space/tab-first line can be
 * blank, so most lines skip every regex.
 */
function endsParagraph(line) {
  if (line.length === 0) return true;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return BLANK.test(line);
  if (c === 96) return FENCE_OPEN.test(line);
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return HR.test(line);
  return false;
}

/**
 * A paragraph line as it is rendered: spaces and tabs at either end dropped.
 * Fast path: most lines have neither, so return the line itself.
 */
const trimLine = (line) => {
  const n = line.length;
  if (n === 0) return line;
  if (line.charCodeAt(0) !== 32 && line.charCodeAt(0) !== 9 && line.charCodeAt(n - 1) !== 32 && line.charCodeAt(n - 1) !== 9) return line;
  let a = 0;
  let b = n;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
};

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s` rendered inline. The reference calls escapeHtml once per character;
 * this scans for the next interesting character with one native regexp and
 * appends each plain run verbatim — a plain run holds no escapable character
 * by construction, so the output is identical. Recursion (strong/em/link
 * text) uses a fresh regexp per call, so nested scans never share state.
 */
function inline(s, C) {
  const out = [];
  const re = /[\\`*\[&<>"']/g;
  let last = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    const i = m.index;
    if (i > last) out.push(s.slice(last, i));
    const c = s[i];
    if (c === '&') { out.push('&amp;'); last = i + 1; }
    else if (c === '<') { out.push('&lt;'); last = i + 1; }
    else if (c === '>') { out.push('&gt;'); last = i + 1; }
    else if (c === '"') { out.push('&quot;'); last = i + 1; }
    else if (c === "'") { out.push('&#39;'); last = i + 1; }
    else if (c === '\\') {
      const n = s[i + 1];
      if (i + 1 < s.length && ESCAPABLE.has(n)) {
        out.push(n === '>' ? '&gt;' : n);
        last = i + 2;
      } else {
        out.push('\\');
        last = i + 1;
      }
    } else if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        out.push('<code>', escapeHtml(s.slice(i + 1, j)), '</code>');
        last = j + 1;
      } else {
        out.push('`');
        last = i + 1;
      }
    } else if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          out.push('<strong>', inline(s.slice(i + 2, j), C), '</strong>');
          last = j + 2;
        } else {
          out.push('**');
          last = i + 2;
        }
      } else {
        const j = findSingleStar(s, i + 1);
        if (j > i + 1) {
          out.push('<em>', inline(s.slice(i + 1, j), C), '</em>');
          last = j + 1;
        } else {
          out.push('*');
          last = i + 1;
        }
      }
    } else if (c === '[') {
      const k = findUnescaped(s, ']', i + 1);
      const mm = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = mm === -1 ? '' : s.slice(k + 2, mm);
      if (target !== '' && !WS.test(target)) {
        out.push('<a href="', escapeHtml(linkOf(C, target)), '">', inline(s.slice(i + 1, k), C), '</a>');
        last = mm + 1;
      } else {
        out.push('[');
        last = i + 1;
      }
    }
    re.lastIndex = last;
  }
  if (last < s.length) out.push(s.slice(last));
  return out.join('');
}

/**
 * A link target resolved for the source whose directory is C.dir: the same
 * href the reference's env.link returns, with the same broken-link report.
 * Resolutions are cached per run (keyed by directory + target); the broken
 * side effect is re-applied on a cache hit, exactly as the reference does
 * per occurrence (the set dedups).
 */
function linkOf(C, target) {
  const key = C.dir + '\n' + target;
  const hit = C.links.get(key);
  if (hit !== undefined) {
    if (hit.broken) C.broken.add(`broken-link ${C.path} -> ${target}`);
    return hit.href;
  }
  let href = target;
  let broken = false;
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) && !target.startsWith('/') && !target.startsWith('#')) {
    const hash = target.indexOf('#');
    const rel = hash === -1 ? target : target.slice(0, hash);
    const frag = hash === -1 ? '' : target.slice(hash);
    const path = rel === '' ? null : resolvePath(C.dir, rel);
    if (path !== null && C.bySource.has(path)) href = `${C.bySource.get(path).url}${frag}`;
    else if (path !== null && C.staticPaths.has(path)) href = `${C.base}/${path}${frag}`;
    else broken = true;
  }
  C.links.set(key, { href, broken });
  if (broken) C.broken.add(`broken-link ${C.path} -> ${target}`);
  return href;
}

/**
 * `src` rendered in one fused pass: blocks are classified and rendered
 * directly into a chunk array — no token objects, no second pass. Returns
 * { html, toc, excerpt } exactly as the reference's renderMarkdown.
 * C is the per-source context ({ dir, path, links, broken, bySource,
 * staticPaths, base, slugify }).
 */
function renderMarkdown(src, C) {
  const lines = src.split('\n');
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    // First-character dispatch: a line can only be a fence (`), heading (#),
    // break or bullet (-/*), quote (>), or ordered list (digit); anything
    // else is a paragraph line, and a space/tab-first line is blank or a
    // paragraph line. This skips the per-line regexes for most lines.
    const c0 = line.length === 0 ? -1 : line.charCodeAt(0);
    if (c0 === -1 || ((c0 === 32 || c0 === 9) && BLANK.test(line))) {
      i++;
      continue;
    }
    const fence = c0 === 96 ? FENCE_OPEN.exec(line) : null;
    if (fence !== null) {
      const lang = fence[1];
      const parts = ['<pre><code'];
      if (lang !== '') parts.push(' class="language-', lang, '"');
      parts.push('>');
      i++;
      while (i < n && !FENCE_CLOSE.test(lines[i])) {
        parts.push(escapeHtml(lines[i]), '\n');
        i++;
      }
      i++;
      parts.push('</code></pre>');
      blocks.push(parts.join(''));
      continue;
    }
    const heading = c0 === 35 ? headingOf(line) : null;
    if (heading !== null) {
      const id = uniqueSlug(C.slugify(heading.text), ids);
      const html = inline(heading.text, C);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if ((c0 === 45 || c0 === 42) && HR.test(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (c0 === 62) {
      const body = [];
      while (i < n && QUOTE.test(lines[i])) body.push(lines[i++].replace(/^> ?/, ''));
      const q = body.map(trimLine).filter((l) => l !== '');
      blocks.push(q.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(q.join('\n'), C)}</p>\n</blockquote>`);
      continue;
    }
    const bullet = (c0 === 45 || c0 === 42) ? BULLET.exec(line) : null;
    const ordered = bullet === null && c0 >= 48 && c0 <= 57 ? ORDERED.exec(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const marker = isOrdered ? ORDERED : BULLET;
      const items = [];
      while (i < n) {
        const mm = marker.exec(lines[i]);
        if (mm !== null) {
          items.push([trimLine(isOrdered ? mm[2] : mm[1])]);
          i++;
        } else if (CONTINUED.test(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && Number(ordered[1]) !== 1 ? `<ol start="${Number(ordered[1])}">` : `<${tag}>`;
      const parts = [open, '\n'];
      for (const item of items) {
        parts.push('<li>', inline(item.join('\n'), C), '</li>\n');
      }
      parts.push(`</${tag}>`);
      blocks.push(parts.join(''));
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), C);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.map((b) => `${b}\n`).join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered into the chunk array `out`, in `scope` ({ vars, parent }).
 * The reference concatenates strings per node; this pushes chunks and joins
 * once per top-level render. A `for` reuses one scope object per execution
 * (mutated per iteration) instead of allocating one per item — safe because
 * rendering is synchronous and nothing retains the scope. The one exception
 * to a plain assignment is `for loop in …`: the literal-construction order
 * of the reference makes the loop object win over the bound element, so the
 * element is not assigned when the loop variable is literally named `loop`.
 */
function renderInto(nodes, scope, ctx, depth, out) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(escapeHtml(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderInto(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        const len = xs.length;
        const vars = { [n.name]: undefined, loop: { index: 0, first: false, last: false, length: len } };
        const sub = { vars, parent: scope };
        const bind = n.name !== 'loop';
        for (let k = 0; k < len; k++) {
          if (bind) vars[n.name] = xs[k];
          const lp = vars.loop;
          lp.index = k + 1;
          lp.first = k === 0;
          lp.last = k === len - 1;
          renderInto(n.body, sub, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderInto(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- build

/** A page's link record as templates read it. */
function linkOfPage(C, s) {
  if (s === null) return null;
  return { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : C.longDate(s.data.date) };
}

/** One site's output tree: path -> text. */
export function run(input) {
  // Per-run context: every cache lives here, never across run() calls.
  const C = {
    base: input.site.base_url.replace(/\/+$/, ''),
    templates: new Map(),
    report: [],
    sources: [],
    statics: [],
    bySource: new Map(),
    staticPaths: new Set(),
    broken: new Set(),
    links: new Map(),
    slugCache: new Map(),
    dateCache: new Map(),
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
    slugify: (text) => {
      let s = C.slugCache.get(text);
      if (s === undefined) {
        s = slugifyRaw(text);
        C.slugCache.set(text, s);
      }
      return s;
    },
    longDate: (date) => {
      let s = C.dateCache.get(date);
      if (s === undefined) {
        s = longDateRaw(date);
        C.dateCache.set(date, s);
      }
      return s;
    },
  };

  // Templates first, in code-unit order of name; a TemplateError is reported
  // and the template is absent everywhere afterwards. Each parsed template
  // is compiled to a render function; a template that fails to compile
  // falls back to the tree walker (same semantics).
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      C.templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      C.report.push(err.message);
    }
  }
  // 1. The sources, in code-unit order of their paths; a source that is not
  // .md is static. Line ends made "\n" only when a "\r" is present.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content;
      C.sources.push({ path: f.path, text });
    } else {
      C.statics.push({ path: f.path, content: f.content });
    }
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of C.sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      C.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      C.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      C.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!C.templates.has(layout)) {
      C.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      C.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  C.sources = kept;

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  for (const s of C.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? C.slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${C.base}/${s.outDir}/`;
    C.bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  C.staticPaths = new Set(C.statics.map((f) => f.path));
  for (const s of C.sources) {
    C.dir = dirOf(s.path);
    C.path = s.path;
    const md = renderMarkdown(s.body, C);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = C.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  C.posts = posts;
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    return (s.data.tags ?? []).filter((name) => {
      const slug = C.slugify(name);
      if (seen.has(slug)) return false;
      seen.add(slug);
      return true;
    });
  };
  for (const p of C.posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = C.slugify(name);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${C.base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of C.sources) {
    if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(C.slugify(name)) ?? { name, slug: C.slugify(name), url: '', posts: [] });
  }
  C.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  // A post's card is computed once here (the reference computes it twice per
  // post: once for the card map, once inside pageOf) and reused.
  const cardOf = (s) => {
    let card = C.cards.get(s);
    if (card === undefined) {
      card = {
        title: s.data.title,
        url: s.url,
        date: s.data.date ?? '',
        date_long: s.data.date === undefined ? '' : C.longDate(s.data.date),
        summary: s.data.summary ?? '',
        excerpt: s.excerpt,
        reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
        tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
      };
      C.cards.set(s, card);
    }
    return card;
  };
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOfPage(C, s.newer ?? null),
    older: linkOfPage(C, s.older ?? null),
    is_post: s.post,
  });
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cardOf(p)) });

  const site = { title: input.site.title, base_url: C.base };
  const allTags = C.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = C.posts.slice(0, input.site.recent).map((p) => cardOf(p));
  const ctx = { templates: C.templates };
  const render = (name, vars) => {
    const nodes = C.templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderInto(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, out);
    return out.join('');
  };
  for (const s of C.sources) C.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(C.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${C.base}/` : `${C.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: C.posts.slice((k - 1) * per, k * per).map((p) => cardOf(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) C.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of C.tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) C.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) C.output['tags/index.html'] = tagsHtml;
  for (const f of C.statics) {
    if (Object.hasOwn(C.output, f.path)) C.report.push(`shadowed ${f.path}: a built page has its path`);
    else C.output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...C.report, ...C.broken].sort(byCodeUnits);
  const pageCount = C.sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${C.posts.length} posts, ${C.tags.length} tags and ${C.statics.length} static files`);
  C.output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return C.output;
}
