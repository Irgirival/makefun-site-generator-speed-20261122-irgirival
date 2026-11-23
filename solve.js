// solve.js — a fast, dependency-free drop-in for makefun-site 1.0.0.
//
// Written from the makefun-site README and the observable behaviour of its
// reference implementation: same answers, byte for byte, on every input.
// Nothing here is copied from the reference implementation; the parsing and
// rendering below are my own, shaped for speed:
//
//   * front matter is scanned line by line without splitting the whole
//     source, and the body is never re-joined;
//   * Markdown is rendered in one cursor pass over the source, with no
//     token objects and no per-line array;
//   * inline rendering works on index ranges (no substring slicing for
//     strong/emphasis/link nesting) and escapes plain runs in bulk instead
//     of one regex call per character;
//   * slugs, long dates and link resolutions are memoised per build;
//   * the template renderer walks a flat node list into one parts array,
//     and never rebuilds a merged scope object per render.
//
// The entry point is run(input), returning the output tree (path -> text).

// ---------------------------------------------------------------- text

/** The HTML escape table. */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** The characters a backslash escapes in Markdown inline text. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** `text` with & < > " and ' escaped. */
function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

const ESC_TEST = /[&<>"']/;

/** `text` escaped, skipping the replace entirely when nothing needs it (the common case for template values). */
function escapeHtmlChecked(text) {
  return ESC_TEST.test(text) ? text.replace(/[&<>"']/g, (c) => ESCAPES[c]) : text;
}

/** The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 *  of characters other than a-z and 0-9 one "-", none at either end, at most
 *  64 characters (a "-" left at the cut dropped), "untitled" when empty. */
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
  out = out.slice(0, 64).replace(/-+$/, '');
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

/** Whether a UTF-16 code unit is whitespace under /\s/ (no `u` flag). */
function isWS(code) {
  if (code >= 33 && code < 127) return false;
  if (code <= 32) return code === 9 || code === 10 || code === 11 || code === 12 || code === 13 || code === 32;
  return (
    code === 160 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

/** Any whitespace other than ' ' and '\n' (see /\s/ without the `u` flag). */
const OTHER_WS = /[\t\r\f\v\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/;

/** The words of `text`: its runs of characters other than whitespace. */
function wordsOf(text) {
  if (!OTHER_WS.test(text)) {
    // Only ' ' and '\n' can be whitespace here: a tight loop.
    let n = 0;
    let inWord = false;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 32 || c === 10) inWord = false;
      else if (!inWord) {
        n++;
        inWord = true;
      }
    }
    return n;
  }
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (!isWS(text.charCodeAt(i))) {
      if (!inWord) {
        n++;
        inWord = true;
      }
    } else inWord = false;
  }
  return n;
}

/** Code-unit order (never the locale's). */
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The directory of `path` ("" at the root). */
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// Per-build memo tables, reset at the start of every run().
let slugCache = new Map();
let dateCache = new Map();

function slugify(text) {
  let s = slugCache.get(text);
  if (s === undefined) {
    s = slugifyRaw(text);
    slugCache.set(text, s);
  }
  return s;
}

function longDate(date) {
  let s = dateCache.get(date);
  if (s === undefined) {
    s = longDateRaw(date);
    dateCache.set(date, s);
  }
  return s;
}

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
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
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
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
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
 * first reason it is refused. `text` has "\n" line ends. Only the front
 * matter region is split into lines; the body is sliced out whole.
 */
function parseFM(text) {
  if (text.length < 3 || text[0] !== '-' || text[1] !== '-' || text[2] !== '-') return { error: 'no front matter' };
  if (text.length > 3 && text[3] !== '\n') return { error: 'no front matter' };
  const fmLines = [];
  let pos = text.length === 3 ? 3 : 4;
  let lineNo = 2;
  let bodyStart = text.length;
  let closed = false;
  while (pos <= text.length) {
    let eol = text.indexOf('\n', pos);
    if (eol === -1) eol = text.length;
    const line = text.slice(pos, eol);
    if (line === '---') {
      closed = true;
      bodyStart = eol < text.length ? eol + 1 : text.length;
      break;
    }
    fmLines.push([lineNo, line]);
    if (eol === text.length) break;
    pos = eol + 1;
    lineNo++;
  }
  if (!closed) return { error: 'the front matter is not closed' };
  const data = {};
  for (const [no, line] of fmLines) {
    if (/^[ \t]*$/.test(line) || line.startsWith('#')) continue;
    const m = LINE.exec(line);
    if (!m) return { error: `line ${no} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
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
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
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
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// Per-build template table, set at the start of every run().
let templates = new Map();

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
 * `nodes` rendered in `scope` ({ vars, parent }) into `parts`. `depth` is the
 * include depth. Identical in effect to a recursive string-building render,
 * but with one shared parts array instead of an intermediate string per node.
 */
function renderNodes(nodes, scope, depth, parts) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case 'text':
        parts.push(n.text);
        break;
      case 'var':
        parts.push(escapeHtmlChecked(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        parts.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, depth, parts);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          renderNodes(n.body, { vars, parent: scope }, depth, parts);
        }
        break;
      }
      case 'include': {
        const t = templates.get(n.name);
        if (t === undefined || depth >= INCLUDE_DEPTH) break;
        // A pure template reads only site/tags/recent (or its own loop
        // variables), so it renders the same in every scope of this build:
        // render it once and reuse the string. An include here renders the
        // template at depth + 1, so the cached depth-0 render is valid only
        // while that render's whole include chain still fits under the cap.
        if (pureSet.has(n.name)) {
          const L = chainLen.get(n.name);
          if (L <= INCLUDE_DEPTH && depth + 1 + L <= INCLUDE_DEPTH) {
            let s = pureCache.get(n.name);
            if (s === undefined) {
              const p2 = [];
              renderNodes(t, rootScope, 0, p2);
              s = p2.join('');
              pureCache.set(n.name, s);
            }
            parts.push(s);
            break;
          }
        }
        renderNodes(t, scope, depth + 1, parts);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- pure templates

// Per-build purity analysis, reset at the start of every run().
let pureSet = new Set(); // names of templates whose render depends only on site/tags/recent
let chainLen = new Map(); // name -> longest include chain (edges), Infinity when cyclic
let pureCache = new Map(); // name -> rendered string under the site-global scope
let rootScope = null; // { vars: { site, tags, recent }, parent: null }, set during layouts

/**
 * Which templates are pure: every name they read from outside their own
 * loops is one of site/tags/recent, and every template they include is pure
 * too (an include renders in the caller's scope, so a pure template may only
 * include pure ones). A template in an include cycle is never pure: its
 * render depends on the depth at which it is entered. `chainLen` is the
 * longest include chain from the template, used to check the depth cap.
 */
function analyzeTemplates() {
  const info = new Map();
  for (const [name, nodes] of templates) {
    const reads = new Set();
    const includes = new Set();
    const walk = (ns, bound) => {
      for (const n of ns) {
        if (n.kind === 'var' || n.kind === 'raw') {
          if (!bound.has(n.path[0])) reads.add(n.path[0]);
        } else if (n.kind === 'if') {
          if (!bound.has(n.path[0])) reads.add(n.path[0]);
          walk(n.then, bound);
          if (n.else !== null) walk(n.else, bound);
        } else if (n.kind === 'for') {
          if (!bound.has(n.path[0])) reads.add(n.path[0]);
          const b2 = new Set(bound);
          b2.add(n.name);
          b2.add('loop');
          walk(n.body, b2);
        } else if (n.kind === 'include') {
          includes.add(n.name);
        }
      }
    };
    walk(nodes, new Set());
    info.set(name, { reads, includes });
  }
  const GLOBAL = new Set(['site', 'tags', 'recent']);
  const state = new Map();
  const dfs = (name) => {
    const st = state.get(name) || 0;
    if (st === 2) return pureSet.has(name);
    if (st === 1) return false;
    state.set(name, 1);
    const inf = info.get(name);
    let pure = true;
    let len = 0;
    if (inf) {
      for (const r of inf.reads) {
        if (!GLOBAL.has(r)) {
          pure = false;
          break;
        }
      }
      if (pure) {
        for (const inc of inf.includes) {
          if (!templates.has(inc)) continue;
          if (!dfs(inc)) {
            pure = false;
            break;
          }
          len = Math.max(len, 1 + (chainLen.get(inc) ?? 0));
        }
      }
    }
    state.set(name, 2);
    if (pure) pureSet.add(name);
    chainLen.set(name, pure ? len : Infinity);
    return pure;
  };
  for (const name of templates.keys()) dfs(name);
}

// ---------------------------------------------------------------- Markdown

/** Whether the line `s[a..b)` is blank (spaces and tabs only). */
function isBlankAt(s, a, b) {
  for (let i = a; i < b; i++) {
    const c = s[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

/** The line `s[a..b)` with spaces and tabs at either end dropped. */
function trimLine(s, a, b) {
  let x = a;
  while (x < b && (s[x] === ' ' || s[x] === '\t')) x++;
  let y = b;
  while (y > x && (s[y - 1] === ' ' || s[y - 1] === '\t')) y--;
  return s.slice(x, y);
}

/** A fence-opening line's language, or null when the line is not one. */
function fenceLangAt(s, a, b) {
  if (b - a < 3 || s[a] !== '`' || s[a + 1] !== '`' || s[a + 2] !== '`') return null;
  let i = a + 3;
  while (i < b) {
    const c = s[i];
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_' || c === '+' || c === '-') i++;
    else break;
  }
  const lang = s.slice(a + 3, i);
  while (i < b && (s[i] === ' ' || s[i] === '\t')) i++;
  return i === b ? lang : null;
}

/** Whether the line `s[a..b)` closes a fence. */
function fenceCloseAt(s, a, b) {
  if (b - a < 3 || s[a] !== '`' || s[a + 1] !== '`' || s[a + 2] !== '`') return false;
  for (let i = a + 3; i < b; i++) {
    if (s[i] !== ' ' && s[i] !== '\t') return false;
  }
  return true;
}

/** A heading line's level and text span, or null (a heading's text is never empty). */
function headingAt(s, a, b) {
  let i = a;
  let depth = 0;
  while (i < b && s[i] === '#' && depth < 6) {
    depth++;
    i++;
  }
  if (depth === 0) return null;
  if (i >= b || (s[i] !== ' ' && s[i] !== '\t')) return null;
  while (i < b && (s[i] === ' ' || s[i] === '\t')) i++;
  let te = b;
  while (te > i && (s[te - 1] === ' ' || s[te - 1] === '\t')) te--;
  if (te === i) return null;
  return { depth, ts: i, te };
}

/** Whether the line `s[a..b)` is a thematic break. */
function hrAt(s, a, b) {
  if (b - a < 3) return false;
  const c0 = s[a];
  if (c0 !== '-' && c0 !== '*') return false;
  if (s[a + 1] !== c0 || s[a + 2] !== c0) return false;
  for (let i = a + 3; i < b; i++) {
    if (s[i] !== ' ' && s[i] !== '\t') return false;
  }
  return true;
}

/** A list marker line: { ordered, start, rest } (rest: index of the item text), or null. */
function listMarkerAt(s, a, b) {
  if (a >= b) return null;
  const c = s[a];
  if ((c === '-' || c === '*') && a + 1 < b && s[a + 1] === ' ') return { ordered: false, start: 1, rest: a + 2 };
  if (c >= '0' && c <= '9') {
    let i = a;
    let digits = 0;
    while (i < b && s[i] >= '0' && s[i] <= '9' && digits < 9) {
      i++;
      digits++;
    }
    if (digits === 0) return null;
    if (i < b && s[i] === '.' && i + 1 < b && s[i + 1] === ' ') {
      return { ordered: true, start: Number(s.slice(a, i)), rest: i + 2 };
    }
    return null;
  }
  return null;
}

/** Whether the line `s[a..b)` continues a list item (two or more spaces, then a non-space). */
function continuedAt(s, a, b) {
  let i = a;
  let spaces = 0;
  while (i < b && s[i] === ' ') {
    i++;
    spaces++;
  }
  if (spaces < 2 || i >= b) return false;
  return !/\s/.test(s[i]);
}

/** Whether the line `s[a..b)` ends a paragraph: blank, a fence, a heading or a thematic break. */
function endsParagraph(s, a, b) {
  return isBlankAt(s, a, b) || fenceLangAt(s, a, b) !== null || headingAt(s, a, b) !== null || hrAt(s, a, b);
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. Bounded by `end`. */
function findUnesc(s, what, from, end) {
  const wlen = what.length;
  for (let j = from; j + wlen <= end; j++) {
    if (s[j] === '\\' && j + 1 < end && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. Bounded by `end`. */
function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < end && ESCAPABLE.has(s[j + 1])) {
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

/** The next character needing attention in inline text: a Markdown mark or an HTML escape. */
const INLINE_NEXT = /[\\`*[\]&<>"']/g;

/**
 * `s[a..b)` rendered inline into `parts`; `link(target)` is a link's href.
 * Works on index ranges, so nested strong/emphasis/link text costs no
 * substring slicing. One regex scan finds the next character needing
 * attention; clean stretches are pushed as-is, and escape characters are
 * replaced inline, so no separate escaping pass runs over the text.
 */
function inlineInto(s, a, b, link, parts) {
  let i = a;
  while (i < b) {
    INLINE_NEXT.lastIndex = i;
    const m = INLINE_NEXT.exec(s);
    const nx = m !== null && m.index < b ? m.index : b;
    if (nx > i) parts.push(s.slice(i, nx));
    if (nx >= b) break;
    const c = s[nx];
    i = nx;
    if (c === '&') {
      parts.push('&amp;');
      i++;
      continue;
    }
    if (c === '<') {
      parts.push('&lt;');
      i++;
      continue;
    }
    if (c === '>') {
      parts.push('&gt;');
      i++;
      continue;
    }
    if (c === '"') {
      parts.push('&quot;');
      i++;
      continue;
    }
    if (c === "'") {
      parts.push('&#39;');
      i++;
      continue;
    }
    if (c === '\\' && i + 1 < b && ESCAPABLE.has(s[i + 1])) {
      const n = s[i + 1];
      parts.push(ESCAPES[n] || n);
      i += 2;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < b && j > i + 1) {
        parts.push('<code>', escapeHtml(s.slice(i + 1, j)), '</code>');
        i = j + 1;
      } else {
        parts.push('`');
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnesc(s, '**', i + 2, b);
        if (j !== -1 && j > i + 2) {
          parts.push('<strong>');
          inlineInto(s, i + 2, j, link, parts);
          parts.push('</strong>');
          i = j + 2;
        } else {
          parts.push('**');
          i += 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1, b);
      if (j !== -1 && j > i + 1) {
        parts.push('<em>');
        inlineInto(s, i + 1, j, link, parts);
        parts.push('</em>');
        i = j + 1;
      } else {
        parts.push('*');
        i++;
      }
      continue;
    }
    if (c === '[') {
      const k = findUnesc(s, ']', i + 1, b);
      let m2 = -1;
      if (k !== -1 && s[k + 1] === '(') {
        m2 = s.indexOf(')', k + 2);
        if (m2 >= b) m2 = -1;
      }
      const target = m2 === -1 ? '' : s.slice(k + 2, m2);
      if (target !== '' && !/\s/.test(target)) {
        parts.push('<a href="', escapeHtml(link(target)), '">');
        inlineInto(s, i + 1, k, link, parts);
        parts.push('</a>');
        i = m2 + 1;
        continue;
      }
      parts.push('[');
      i++;
      continue;
    }
    parts.push(c);
    i++;
  }
}

/** `text` rendered inline. */
function inlineStr(text, link) {
  const parts = [];
  inlineInto(text, 0, text.length, link, parts);
  return parts.join('');
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the
 * last), its table of contents (every level 2 and 3 heading: level, id and
 * its inline HTML) and its excerpt (the first paragraph's inline HTML, or "").
 * One cursor pass over the source; no line array, no token objects.
 */
function renderMD(src, link) {
  const n = src.length;
  let pos = 0;
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  while (pos < n) {
    let ls = pos;
    let le = src.indexOf('\n', ls);
    if (le === -1) le = n;
    if (isBlankAt(src, ls, le)) {
      pos = le + 1;
      continue;
    }
    const lang = fenceLangAt(src, ls, le);
    if (lang !== null) {
      const body = [];
      pos = le + 1;
      while (pos < n) {
        ls = pos;
        le = src.indexOf('\n', ls);
        if (le === -1) le = n;
        if (fenceCloseAt(src, ls, le)) {
          pos = le + 1;
          break;
        }
        body.push(src.slice(ls, le));
        pos = le + 1;
      }
      const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
      const inner = body.length === 0 ? '' : `${escapeHtml(body.join('\n'))}\n`;
      blocks.push(`<pre><code${cls}>${inner}</code></pre>`);
      continue;
    }
    const hd = headingAt(src, ls, le);
    if (hd !== null) {
      const text = src.slice(hd.ts, hd.te);
      const id = uniqueSlug(slugify(text), ids);
      const parts = [];
      inlineInto(src, hd.ts, hd.te, link, parts);
      const html = parts.join('');
      blocks.push(`<h${hd.depth} id="${id}">${html}</h${hd.depth}>`);
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      pos = le + 1;
      continue;
    }
    if (hrAt(src, ls, le)) {
      blocks.push('<hr>');
      pos = le + 1;
      continue;
    }
    if (src[ls] === '>') {
      const lines = [];
      while (pos < n) {
        ls = pos;
        le = src.indexOf('\n', ls);
        if (le === -1) le = n;
        if (src[ls] !== '>') break;
        let st = ls + 1;
        if (st < le && src[st] === ' ') st++;
        const t = trimLine(src, st, le);
        if (t !== '') lines.push(t);
        pos = le + 1;
      }
      blocks.push(lines.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inlineStr(lines.join('\n'), link)}</p>\n</blockquote>`);
      continue;
    }
    const mk = listMarkerAt(src, ls, le);
    if (mk !== null) {
      const items = [];
      const ordered = mk.ordered;
      const start = mk.start;
      while (pos < n) {
        ls = pos;
        le = src.indexOf('\n', ls);
        if (le === -1) le = n;
        const m2 = listMarkerAt(src, ls, le);
        if (m2 !== null && m2.ordered === ordered) {
          items.push([trimLine(src, m2.rest, le)]);
          pos = le + 1;
        } else if (continuedAt(src, ls, le)) {
          items[items.length - 1].push(trimLine(src, ls, le));
          pos = le + 1;
        } else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      const open = ordered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      let out = `${open}\n`;
      for (const parts of items) out += `<li>${inlineStr(parts.join('\n'), link)}</li>\n`;
      out += `</${tag}>`;
      blocks.push(out);
      continue;
    }
    const plines = [trimLine(src, ls, le)];
    pos = le + 1;
    while (pos < n) {
      ls = pos;
      le = src.indexOf('\n', ls);
      if (le === -1) le = n;
      if (endsParagraph(src, ls, le)) break;
      plines.push(trimLine(src, ls, le));
      pos = le + 1;
    }
    const html = inlineStr(plines.join('\n'), link);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.map((b) => `${b}\n`).join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- the build

/** The top-level directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

// Per-build link state, set at the start of every run().
let bySource = new Map();
let staticPaths = new Set();
let base = '';
let broken = new Set();
let linkCache = new Map();
let resolveCache = new Map();

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  let byDir = resolveCache.get(dir);
  if (byDir === undefined) {
    byDir = new Map();
    resolveCache.set(dir, byDir);
  }
  if (byDir.has(rel)) return byDir.get(rel);
  const parts = dir === '' ? [] : dir.split('/');
  let out = null;
  let ok = true;
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) {
        ok = false;
        break;
      }
      parts.pop();
    } else parts.push(seg);
  }
  out = ok ? parts.join('/') : null;
  byDir.set(rel, out);
  return out;
}

/** A link target's href from the source in `dir`, memoised per build.
 *  A broken target is cached as null, but its broken-link line is still
 *  recorded for every source that uses it (the line names the source). */
function linkFor(dir, target, sourcePath) {
  let byDir = linkCache.get(dir);
  if (byDir === undefined) {
    byDir = new Map();
    linkCache.set(dir, byDir);
  }
  if (byDir.has(target)) {
    const href = byDir.get(target);
    if (href === null) {
      broken.add(`broken-link ${sourcePath} -> ${target}`);
      return target;
    }
    return href;
  }
  let href;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) {
    href = target;
  } else {
    const hash = target.indexOf('#');
    const rel = hash === -1 ? target : target.slice(0, hash);
    const frag = hash === -1 ? '' : target.slice(hash);
    const path = rel === '' ? null : resolvePath(dir, rel);
    if (path !== null && bySource.has(path)) href = `${bySource.get(path).url}${frag}`;
    else if (path !== null && staticPaths.has(path)) href = `${base}/${path}${frag}`;
    else {
      broken.add(`broken-link ${sourcePath} -> ${target}`);
      href = null;
    }
  }
  byDir.set(target, href);
  return href === null ? target : href;
}

/** A page's link record as templates read it. */
const linkOf = (s) =>
  s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };

/** A post's card, as lists show it. */
function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it. */
function pageOf(s) {
  return {
    ...s.card,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** One site's output tree: path -> text. */
export function run(input) {
  slugCache = new Map();
  dateCache = new Map();
  linkCache = new Map();
  resolveCache = new Map();
  templates = new Map();
  bySource = new Map();
  staticPaths = new Set();
  broken = new Set();
  pureSet = new Set();
  chainLen = new Map();
  pureCache = new Map();
  rootScope = null;
  const report = [];
  for (const name of Object.keys(input.templates).sort(cmp)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  analyzeTemplates();
  base = input.site.base_url.replace(/\/+$/, '');

  // 1. The sources, in code-unit order of their paths, line ends made "\n".
  const files = [...input.files].sort((x, y) => cmp(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      let text = f.content;
      if (text.indexOf('\r') !== -1) text = text.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text });
    } else statics.push(f);
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFM(s.text);
    if (fm.error) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  staticPaths = new Set(statics.map((f) => f.path));
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => linkFor(dir, target, s.path);
    const md = renderMD(s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => cmp(y.data.date, x.data.date) || cmp(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    return (s.data.tags ?? []).filter((name) => !seen.has(slugify(name)) && seen.add(slugify(name)));
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || cmp(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  for (const s of kept) s.card = cardOf(s);
  const cards = new Map(posts.map((p) => [p, p.card]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const rootVars = { site, tags: allTags, recent };
  rootScope = { vars: rootVars, parent: null };
  const output = {};
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    if (pureSet.has(name) && chainLen.get(name) <= INCLUDE_DEPTH) {
      let s = pureCache.get(name);
      if (s === undefined) {
        const p2 = [];
        renderNodes(nodes, rootScope, 0, p2);
        s = p2.join('');
        pureCache.set(name, s);
      }
      return s;
    }
    const parts = [];
    renderNodes(nodes, { vars, parent: rootScope }, 0, parts);
    return parts.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(cmp);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
