/* SQL Viewer - live bracket-depth formatter + highlighter. No build step, no deps.
   node-sql-parser (loaded from CDN) is used for the live validity readout. */

/* ------------------------------------------------------------------ keywords */

const KEYWORDS = new Set(`
SELECT DISTINCT ALL FROM WHERE GROUP BY ORDER HAVING LIMIT OFFSET AS ON AND OR NOT IN IS NULL
LIKE ILIKE RLIKE REGEXP BETWEEN EXISTS ANY SOME UNION INTERSECT EXCEPT MINUS INSERT INTO VALUES
UPDATE SET DELETE CREATE TABLE VIEW INDEX DROP ALTER ADD COLUMN PRIMARY KEY FOREIGN REFERENCES
UNIQUE DEFAULT CHECK CONSTRAINT CASCADE RESTRICT JOIN INNER LEFT RIGHT FULL OUTER CROSS NATURAL
USING WITH RECURSIVE CASE WHEN THEN ELSE END TOP ASC DESC NULLS FIRST LAST OVER PARTITION ROWS
RANGE PRECEDING FOLLOWING CURRENT ROW UNBOUNDED CAST TRUE FALSE UNKNOWN IF ELSEIF INTERVAL
RETURNING CONFLICT DO NOTHING WINDOW QUALIFY FETCH NEXT ONLY LATERAL GRANT REVOKE BEGIN COMMIT
ROLLBACK EXPLAIN ANALYZE DESCRIBE SHOW USE TRUNCATE REPLACE IGNORE STRAIGHT_JOIN COLLATE ESCAPE
`.trim().split(/\s+/));

/* Function names are deliberately allow-listed. An arbitrary identifier
   followed by "(" is not automatically a function: it is either a known
   T-SQL/Access function or an error reported by unknownFunctionDiagnostics().
   Keep the two source dialects separate so adding a name is easy to review. */
const TSQL_FUNCTIONS = new Set(`
ABS ACOS ASIN ATAN ATN2 APP_NAME APPROX_COUNT_DISTINCT ASCII AVG BIT_COUNT
BINARY_CHECKSUM CEILING CHAR CHARINDEX CHECKSUM CHECKSUM_AGG CHOOSE COALESCE
COL_LENGTH COL_NAME COLUMNPROPERTY CONCAT CONCAT_WS CONNECTIONPROPERTY
CONTAINSTABLE CONTEXT_INFO COS COT COUNT COUNT_BIG CUME_DIST
CURRENT_REQUEST_ID CURRENT_TRANSACTION_ID DATABASE_PRINCIPAL_ID DATALENGTH
DATEADD DATEDIFF DATEDIFF_BIG DATENAME DATEFROMPARTS DATEPART DAY DB_ID DB_NAME
DEGREES DIFFERENCE DENSE_RANK EOMONTH ERROR_LINE ERROR_MESSAGE ERROR_NUMBER
ERROR_PROCEDURE ERROR_SEVERITY ERROR_STATE EXP FILE_ID FILE_IDEX FILE_NAME
FILEGROUP_ID FILEGROUP_NAME FILEPROPERTY FIRST_VALUE FLOOR FORMAT FORMATMESSAGE
FREETEXT FREETEXTTABLE GETANSINULL GET_BIT GET_BYTE GETDATE GET_FILESTREAM_TRANSACTION_CONTEXT GETUTCDATE
GREATEST GROUPING GROUPING_ID HAS_PERMS_BY_NAME HASHBYTES HOST_ID HOST_NAME
IDENT_CURRENT IDENT_INCR IDENT_SEED INDEX_COL INDEXKEY_PROPERTY INDEXPROPERTY
ISDATE ISJSON ISNULL IS_MEMBER ISNUMERIC IS_ROLEMEMBER IS_SRVROLEMEMBER
JSON_ARRAY JSON_MODIFY JSON_OBJECT JSON_QUERY JSON_VALUE LAG LAST_VALUE LEAD
LEAST LEFT LEN LOG LOG10 LOWER LTRIM MAX MIN MIN_ACTIVE_ROWVERSION MONTH
NCHAR NEWID NEWSEQUENTIALID NTILE NULLIF OBJECT_DEFINITION OBJECT_ID OBJECT_NAME
OBJECT_SCHEMA_NAME OBJECTPROPERTY OBJECTPROPERTYEX OPENJSON ORIGINAL_DB_NAME
ORIGINAL_LOGIN PARSE PARSENAME PATINDEX PERCENTILE_CONT PERCENTILE_DISC
PERCENT_RANK PI POWER QUOTENAME RADIANS RANK RAND REPLACE REPLICATE REVERSE
RIGHT ROUND ROWCOUNT_BIG ROW_NUMBER RTRIM SCHEMA_ID SCHEMA_NAME SCOPE_IDENTITY
SESSION_CONTEXT SESSION_ID SESSIONPROPERTY SIGN SIN SOUNDEX SPACE SQL_VARIANT_PROPERTY
SQRT SQUARE STDEV STDEVP STATS_DATE STRING_AGG STRING_ESCAPE STRING_SPLIT
STUFF SUBSTRING SUM SUSER_ID SUSER_NAME SUSER_SNAME SWITCHOFFSET SYSTEM_USER
TAN TIMEFROMPARTS TODATETIMEOFFSET TRANSLATE TRIM TRY_CAST TRY_CONVERT TRY_PARSE
TYPE_ID TYPE_NAME TYPEPROPERTY UNICODE UPPER USER_ID USER_NAME VAR VARP XACT_STATE
COMPRESS DECOMPRESS LEFT_SHIFT RIGHT_SHIFT SET_BIT SET_BYTE YEAR
`.trim().split(/\s+/));

const ACCESS_FUNCTIONS = new Set(`
ABS ASC ATN AVG ARRAY CALLBYNAME CBOOL CBYTE CCUR CDATE CDBL CDEC CHOOSE
CHR CINT CLNG COMMAND CONCAT COS COUNT CREATEOBJECT CSTR CSNG CVAR CVDATE
DATE DATEADD DATEDIFF DATEPART DATESERIAL DATEVALUE DAVG DCOUNT DDE DDEINITIATE
DDEREQUEST DDESEND DDB DFIRST DLAST DLOOKUP DMAX DMIN DSTDEV DSTDEVP DSUM DVAR
DVARP ENVIRON EVAL ERROR EUROCONVERT EXP FILTER FIX FORMAT FORMATCURRENCY
FORMATDATETIME FORMATNUMBER FORMATPERCENT FV GETOBJECT GUIDFROMSTRING HEX HOUR
IIF INPUTBOX INSTR INSTRREV INT IPMT IRR ISARRAY ISDATE ISEMPTY ISERROR
ISMISSING ISNULL ISNUMERIC ISOBJECT JOIN LBOUND LCASE LAST LTRIM LEFT LEN LOG
MAX MID MIN MINUTE MIRR MONTH MONTHNAME MSGBOX NOW NZ OCT NPER NPV PARTITION
PMT PPMT PV RATE REPLACE RIGHT RND ROUND RTRIM SECOND SGN SHELL SIN SLN SPACE
SPLIT SQR STR STRCOMP STRCONV STRING SUM SWITCH SYD TAN TIME TIMESERIAL
TIMEVALUE TIMER TRIM TYPENAME UBOUND UCASE VAL VAR VARP WEEKDAY WEEKDAYNAME
YEAR FIRST STDEV STDEVP
`.trim().split(/\s+/));

const KNOWN_FUNCTIONS = new Set([...TSQL_FUNCTIONS, ...ACCESS_FUNCTIONS]);

/* Words that may legally precede a parenthesized SQL expression but are not
   function calls. This keeps constructs such as IN (...), EXISTS (...), and
   OVER (...) from being reported as unknown functions. */
const PAREN_EXPRESSION_KEYWORDS = new Set(`
AND ANY AS EXISTS FROM GROUP IN NOT ON OR OVER PARTITION SELECT SOME VALUES WHERE
WITHIN PIVOT UNPIVOT
`.trim().split(/\s+/));
const LITERALS = new Set(['NULL', 'TRUE', 'FALSE', 'UNKNOWN']);

/* clause keywords: each gets its own line, its body indented one level.
   Longest match wins, so ['GROUP','BY'] beats ['GROUP']. */
const CLAUSES = [
  ['SELECT', 'DISTINCT'], ['SELECT'], ['FROM'], ['WHERE'], ['GROUP', 'BY'], ['ORDER', 'BY'], ['HAVING'],
  ['LIMIT'], ['OFFSET'], ['UNION', 'ALL'], ['UNION'], ['INTERSECT'], ['EXCEPT'], ['INSERT', 'INTO'],
  ['VALUES'], ['UPDATE'], ['SET'], ['DELETE', 'FROM'], ['WITH', 'RECURSIVE'], ['WITH'], ['RETURNING'],
  ['PARTITION', 'BY'], ['WINDOW'], ['QUALIFY'], ['LEFT', 'OUTER', 'JOIN'], ['RIGHT', 'OUTER', 'JOIN'],
  ['FULL', 'OUTER', 'JOIN'], ['LEFT', 'JOIN'], ['RIGHT', 'JOIN'], ['FULL', 'JOIN'], ['INNER', 'JOIN'],
  ['CROSS', 'JOIN'], ['NATURAL', 'JOIN'], ['STRAIGHT_JOIN'], ['JOIN'], ['ON'], ['USING'],
];
const CLAUSE_HEADS = new Set(CLAUSES.map(c => c[0]));

/* a paren group is exploded rather than kept inline once its flat form exceeds this */
const INLINE_MAX = 76;

/* ---------------------------------------------------------------- tokenizer */

const WS = new Set([' ', '\t', '\n', '\r', '\f', '\v']);
const isWs = c => WS.has(c);
const isDigit = c => c >= '0' && c <= '9';
const WORD_START = /[A-Za-z_@$-￿]/;
const WORD_CHAR = /[A-Za-z0-9_@$#-￿]/;

const OPS3 = ['<=>'];
const OPS2 = ['<=', '>=', '<>', '!=', '||', '&&', '::', ':=', '->', '=>', '<<', '>>'];

function tokenize(sql) {
  const out = [];
  const n = sql.length;
  let i = 0;

  while (i < n) {
    const c = sql[i];

    if (isWs(c)) {
      let j = i; while (j < n && isWs(sql[j])) j++;
      out.push({ t: 'ws', v: sql.slice(i, j), start: i, end: j }); i = j; continue;
    }

    if ((c === '-' && sql[i + 1] === '-') || c === '#') {
      let j = sql.indexOf('\n', i); if (j < 0) j = n;
      out.push({ t: 'comment', v: sql.slice(i, j), line: true, start: i, end: j }); i = j; continue;
    }

    if (c === '/' && sql[i + 1] === '*') {
      const closeAt = sql.indexOf('*/', i + 2);
      const closed = closeAt >= 0;
      const j = closed ? closeAt + 2 : n;
      out.push({ t: 'comment', v: sql.slice(i, j), line: false, closed, start: i, end: j }); i = j; continue;
    }

    if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      let j = i + 1, closed = false;
      while (j < n) {
        if (sql[j] === '\\' && c !== '`' && c !== '[') { j += 2; continue; }
        if (sql[j] === close) {
          if (sql[j + 1] === close && c !== '[') { j += 2; continue; }   // '' escape
          j++; closed = true; break;
        }
        j++;
      }
      // '...' and "..." are both string literals (MySQL-style, ANSI_QUOTES off);
      // only `...` and [...] delimit identifiers
      const ident = c === '`' || c === '[';
      out.push({ t: ident ? 'qid' : 'str', v: sql.slice(i, j), quote: c, closed, start: i, end: j });
      i = j; continue;
    }

    if (isDigit(c) || (c === '.' && isDigit(sql[i + 1] || ''))) {
      let j = i;
      if (c === '0' && (sql[i + 1] === 'x' || sql[i + 1] === 'X')) {
        j = i + 2; while (j < n && /[0-9a-fA-F]/.test(sql[j])) j++;
      } else {
        while (j < n && (isDigit(sql[j]) || sql[j] === '.')) j++;
        if (sql[j] === 'e' || sql[j] === 'E') {
          let k = j + 1; if (sql[k] === '+' || sql[k] === '-') k++;
          if (isDigit(sql[k] || '')) { j = k; while (j < n && isDigit(sql[j])) j++; }
        }
      }
      out.push({ t: 'num', v: sql.slice(i, j), start: i, end: j }); i = j; continue;
    }

    if (WORD_START.test(c)) {
      let j = i; while (j < n && WORD_CHAR.test(sql[j])) j++;
      out.push({ t: 'word', v: sql.slice(i, j), start: i, end: j }); i = j; continue;
    }

    if (c === '(' || c === ')') { out.push({ t: 'paren', v: c, start: i, end: i + 1 }); i++; continue; }
    if (c === ',') { out.push({ t: 'comma', v: c, start: i, end: i + 1 }); i++; continue; }
    if (c === ';') { out.push({ t: 'semi', v: c, start: i, end: i + 1 }); i++; continue; }

    const three = sql.substr(i, 3), two = sql.substr(i, 2);
    if (OPS3.includes(three)) { out.push({ t: 'op', v: three, start: i, end: i + 3 }); i += 3; continue; }
    if (OPS2.includes(two)) { out.push({ t: 'op', v: two, start: i, end: i + 2 }); i += 2; continue; }
    out.push({ t: 'op', v: c, start: i, end: i + 1 }); i++;
  }
  return out;
}

/* --------------------------------------------------------------- classifier */

function classify(toks) {
  let prevCode = null;
  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i];
    if (tk.t === 'ws') continue;

    if (tk.t === 'word') {
      const u = tk.v.toUpperCase();
      tk.up = u;
      let next = null;
      for (let j = i + 1; j < toks.length; j++) {
        if (toks[j].t === 'ws' || toks[j].t === 'comment') continue;
        next = toks[j]; break;
      }
      const callish = next && next.t === 'paren' && next.v === '(';
      if (LITERALS.has(u)) tk.cls = 't-lit';
      else if (callish && KNOWN_FUNCTIONS.has(u)) { tk.cls = 't-fn'; tk.isFn = true; }
      else if (KEYWORDS.has(u)) { tk.cls = 't-kw'; tk.kw = true; }
      else tk.cls = 't-id';
    } else if (tk.t === 'str') tk.cls = 't-str';
    else if (tk.t === 'qid') tk.cls = tk.quote === '[' ? 't-id' : 't-qid';
    else if (tk.t === 'num') tk.cls = 't-num';
    else if (tk.t === 'comment') tk.cls = 't-com';
    else if (tk.t === 'comma' || tk.t === 'semi') tk.cls = 't-punct';
    else if (tk.t === 'op') {
      tk.cls = 't-op';
      // unary +/- : glue it to the number that follows
      if ((tk.v === '-' || tk.v === '+') &&
        (!prevCode || prevCode.t === 'op' || prevCode.t === 'comma' ||
          (prevCode.t === 'paren' && prevCode.v === '(') || prevCode.kw)) {
        tk.unary = true;
      }
    }
    prevCode = tk;
  }
  return toks;
}

/* Tokenization is shared by the formatter, highlighter, normalizer,
   diagnostics, and bracket marker. Keep a tiny MRU cache so one keystroke does
   not scan the same text four or five times. The cache is intentionally small:
   it covers the source/formatted pair without retaining old editor contents. */
const TOKEN_CACHE_LIMIT = 4;
const tokenCache = new Map();
function tokensFor(sql) {
  const cached = tokenCache.get(sql);
  if (cached) {
    tokenCache.delete(sql);
    tokenCache.set(sql, cached);
    return cached;
  }

  const tokens = classify(tokenize(sql));
  tokenCache.set(sql, tokens);
  while (tokenCache.size > TOKEN_CACHE_LIMIT) tokenCache.delete(tokenCache.keys().next().value);
  return tokens;
}

/* ------------------------------------------------------------------- layout */

/* nest paren groups; drop whitespace (it is regenerated by the writer) */
function buildTree(toks) {
  let i = 0, depth = 0;

  function walk(top) {
    const items = [];
    while (i < toks.length) {
      const tk = toks[i];
      if (tk.t === 'ws') { i++; continue; }
      if (tk.t === 'paren' && tk.v === '(') {
        const open = tk; open.depth = depth;
        i++; depth++;
        const inner = walk(false);
        depth--;
        let close = null;
        if (i < toks.length && toks[i].t === 'paren' && toks[i].v === ')') {
          close = toks[i]; close.depth = depth; i++;
        }
        items.push({ group: true, open, close, items: inner });
        continue;
      }
      if (tk.t === 'paren' && tk.v === ')') {
        if (!top) return items;
        tk.depth = 0; tk.stray = true; items.push(tk); i++; continue;   // unbalanced input
      }
      items.push(tk); i++;
    }
    return items;
  }
  return walk(true);
}

function matchClause(items, at) {
  const first = items[at];
  if (!first || first.group || first.t !== 'word' || !CLAUSE_HEADS.has(first.up)) return null;
  for (const words of CLAUSES) {
    let k = at, ok = true;
    for (const w of words) {
      const it = items[k];
      if (!it || it.group || it.t !== 'word' || it.up !== w) { ok = false; break; }
      k++;
    }
    if (ok) return { toks: items.slice(at, k), next: k };
  }
  return null;
}

function flatLen(items) {
  let len = 0, prev = null;
  for (const it of items) {
    if (it.group) {
      if (prev && needSpace(prev, it.open)) len++;
      len += 2 + flatLen(it.items);
      prev = it.close || it.open;
      continue;
    }
    if (prev && needSpace(prev, it)) len++;
    len += it.v.length;
    prev = it;
  }
  return len;
}

/* decide which paren groups explode; also tag the AND that belongs to a BETWEEN */
function analyze(items) {
  let logic = false, childBreaks = false, between = 0;
  for (const it of items) {
    if (it.group) {
      it.brk = analyze(it.items);
      if (it.brk) childBreaks = true;
      continue;
    }
    if (it.t === 'word') {
      const u = it.up;
      if (u === 'BETWEEN') between++;
      else if (u === 'AND') { if (between > 0) { between--; it.between = true; } else logic = true; }
      else if (u === 'OR') logic = true;
      else if (u === 'CASE' || u === 'WHEN' || CLAUSE_HEADS.has(u)) logic = true;
    }
    if (it.t === 'comment') logic = true;
  }
  return logic || childBreaks || flatLen(items) > INLINE_MAX;
}

function needSpace(prev, cur) {
  if (!prev) return false;
  if (cur.t === 'comma' || cur.t === 'semi') return false;
  if (cur.t === 'paren' && cur.v === ')') return false;
  if (prev.t === 'paren' && prev.v === '(') return false;
  if (cur.v === '.' || prev.v === '.') return false;
  if (cur.t === 'paren' && cur.v === '(' && prev.isFn) return false;
  if (prev.unary) return false;
  if (prev.t === 'op' && prev.v === '::') return false;
  return true;
}

class Writer {
  constructor() { this.lines = []; this.cur = null; }
  nl() { if (this.cur && this.cur.toks.length) this.lines.push(this.cur); this.cur = null; }
  push(tok, indent) {
    if (!this.cur) this.cur = { indent, toks: [] };
    this.cur.toks.push(tok);
  }
  done() { this.nl(); return this.lines; }
}

function flatten(group, into) {
  into.push(group.open);
  for (const it of group.items) it.group ? flatten(it, into) : into.push(it);
  if (group.close) into.push(group.close);
  return into;
}

function emit(items, indent, w) {
  let i = 0;
  while (i < items.length) {
    const m = matchClause(items, i);
    if (m) {
      w.nl();
      for (const t of m.toks) w.push(t, indent);

      let j = m.next; const body = [];
      while (j < items.length && !matchClause(items, j)) { body.push(items[j]); j++; }

      if (body.length && !analyze(body)) {
        emitBody(body, indent, w);          // short and flat: keep it on the clause line
      } else {
        w.nl();
        emitBody(body, indent + 1, w);
      }
      w.nl();
      i = j;
      continue;
    }
    let j = i; const body = [];
    while (j < items.length && !matchClause(items, j)) { body.push(items[j]); j++; }
    emitBody(body, indent, w);
    i = j;
  }
}

function commaParts(items) {
  const parts = [];
  let current = [];
  for (const it of items) {
    if (it.t === 'comma') {
      parts.push({ items: current, comma: it });
      current = [];
    } else {
      current.push(it);
    }
  }
  parts.push({ items: current, comma: null });
  return parts;
}

/* A long list is still safe to wrap horizontally when each item can be
   rendered as one flat token sequence. Lists containing their own broken
   groups or boolean/clause structure keep the more explicit layout below. */
function canPackCommaList(items) {
  if (!items.some(it => it.t === 'comma')) return false;
  return commaParts(items).every(part => {
    if (!part.items.length) return false;
    return part.items.every(it => {
      if (it.group) return !it.brk;
      if (it.t === 'comment') return false;
      if (it.t !== 'word') return true;
      return !['AND', 'OR', 'CASE', 'WHEN', 'ELSE', 'END'].includes(it.up) &&
        !CLAUSE_HEADS.has(it.up);
    });
  });
}

function flatTokens(items, into = []) {
  for (const it of items) it.group ? flatten(it, into) : into.push(it);
  return into;
}

/* Emit a long comma list in rows that fit the same width used to decide when
   a parenthesised group should expand. The comma stays with its item, so the
   result remains easy to scan and copy. */
function emitPackedCommaList(items, indent, w) {
  let prefix = w.cur && w.cur.toks.length ? w.cur.toks.slice() : [];
  let line = [];
  let lineIndent = w.cur && w.cur.toks.length ? w.cur.indent : indent;

  const flush = () => {
    for (const tk of line) w.push(tk, lineIndent);
    w.nl();
    prefix = [];
    line = [];
    lineIndent = indent;
  };

  for (const part of commaParts(items)) {
    const entry = flatTokens(part.items.slice());
    if (part.comma) entry.push(part.comma);

    const candidate = prefix.concat(line, entry);
    if ((prefix.length || line.length) && 2 * lineIndent + flatLen(candidate) > INLINE_MAX) {
      flush();
    }

    line.push(...entry);
  }

  for (const tk of line) w.push(tk, lineIndent);
}

function emitBody(items, indent, w) {
  const longBody = flatLen(items) > INLINE_MAX;
  if (longBody && canPackCommaList(items)) {
    emitPackedCommaList(items, indent, w);
    return;
  }

  let caseLvl = 0;                        // CASE bodies nest one level per open CASE

  for (const it of items) {
    if (it.group) {
      if (it.brk) {
        w.push(it.open, indent + caseLvl); // rides along on e.g. "AND ("
        w.nl();
        emit(it.items, indent + caseLvl + 1, w);
        w.nl();
        // leave the ")" line open so an alias or operator can follow it
        if (it.close) w.push(it.close, indent + caseLvl);
      } else {
        for (const t of flatten(it, [])) w.push(t, indent + caseLvl);
      }
      continue;
    }

    if (it.t === 'word') {
      if ((it.up === 'AND' && !it.between) || it.up === 'OR') w.nl();
      else if (it.up === 'WHEN' || it.up === 'ELSE') w.nl();
      else if (it.up === 'END') { caseLvl = Math.max(0, caseLvl - 1); w.nl(); }
    }

    w.push(it, indent + caseLvl);

    if (it.t === 'word' && it.up === 'CASE') { caseLvl++; w.nl(); }
    if (it.t === 'comment' && it.line) w.nl();
    if (it.t === 'comma' && longBody) w.nl();
    if (it.t === 'semi') w.nl();
  }
}

/* Returns the laid-out lines plus a start-line -> end-line map of collapsible
   bracket chains. A broken group always puts its "(" last on its line and its
   ")" first on a later one, so at most one fold can start per line. */
function formatSql(sql) {
  const tree = buildTree(tokensFor(sql));
  analyze(tree);
  const w = new Writer();
  emit(tree, 0, w);
  const lines = w.done();

  const lineOf = new Map();
  let pair = 0;
  const stack = [];
  lines.forEach((ln, i) => {
    for (const tk of ln.toks) {
      lineOf.set(tk, i);
      if (tk.t !== 'paren') continue;
      // pair ids are assigned over the whole document so folding cannot skew them
      if (tk.v === '(') { tk.pairId = pair++; stack.push(tk.pairId); }
      else tk.pairId = tk.stray || !stack.length ? -1 : stack.pop();
    }
  });

  const folds = new Map();
  (function collect(items) {
    for (const it of items) {
      if (!it.group) continue;
      if (it.brk && it.close) {
        const a = lineOf.get(it.open), b = lineOf.get(it.close);
        if (a !== undefined && b !== undefined && b > a) folds.set(a, b);
      }
      collect(it.items);
    }
  })(tree);

  return { lines, folds };
}


/* -------------------------------------------------------------- rendering */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
const esc = s => s.replace(/[&<>]/g, c => ESC[c]);

/* The formatted text carries its indentation as real spaces rather than CSS
   padding, so a transparent textarea can sit under it and line up exactly. */
function lineText(line, indent = true) {
  let s = indent ? '  '.repeat(line.indent) : '', prev = null;
  for (const tk of line.toks) {
    if (prev && needSpace(prev, tk)) s += ' ';
    s += tk.v;
    prev = tk;
  }
  return s;
}

const formattedText = lines => lines.map(lineText).join('\n');

/* The source pane keeps the compact one-line shape you paste in, so edits made
   on the formatted side come back collapsed rather than as the laid-out text.
   Only whitespace changes, which keeps the caret anchor valid. */
function oneLine(sql) {
  let out = '', prev = null;
  for (const tk of tokensFor(sql)) {
    if (tk.t === 'ws') continue;
    if (tk.t === 'comment' && tk.line) {         // -- runs to end of line
      out += (prev ? ' ' : '') + tk.v + '\n';
      prev = null;
      continue;
    }
    if (prev && needSpace(prev, tk)) out += ' ';
    out += tk.v;
    prev = tk;
  }
  return out;
}

/* `indent` is dropped for the closing line of a collapsed chain, which gets
   spliced onto the opening one - its leading spaces would show as a gap. */
function lineHtml(line, seq, indent = true, view = null) {
  let html = indent ? '  '.repeat(line.indent) : '', prev = null;
  for (const tk of line.toks) {
    if (prev && needSpace(prev, tk)) html += ' ';
    const diag = diagnosticTokenClass(tk, view);
    html += tk.t === 'paren'
      ? `<span class="p b${(tk.depth || 0) % 3}${diag}" data-p="${seq.n++}">${tk.v}</span>`
      : `<span class="${tk.cls || 't-id'}${diag}">${esc(tk.v)}</span>`;
    prev = tk;
  }
  return html;
}

/* Highlight arbitrary text as one block per logical line. Used for the source
   pane always, and for the formatted pane while it is being typed in. */
function highlightRows(sql, seq, view = null) {
  const rows = [''];
  let depth = 0;
  const primaryLines = diagnosticLines(sql, view && view.primary);
  const relatedLines = diagnosticLines(sql, view && view.related);

  for (const tk of tokensFor(sql)) {
    let cls = tk.cls || 't-id';
    let paren = false;
    if (tk.t === 'paren') {
      paren = true;
      if (tk.v === '(') { cls = `p b${depth % 3}`; depth++; }
      else { depth = Math.max(0, depth - 1); cls = `p b${depth % 3}`; }
    }
    // a token may straddle newlines (block comments, multi-line strings)
    const parts = tk.v.split('\n');
    for (let i = 0; i < parts.length; i++) {
      if (i) rows.push('');
      if (!parts[i]) continue;
      rows[rows.length - 1] += tk.t === 'ws'
        ? esc(parts[i])
        : `<span class="${cls}${diagnosticTokenClass(tk, view)}"${paren ? ` data-p="${seq.n++}"` : ''}>${esc(parts[i])}</span>`;
    }
  }

  // indent guides follow whatever leading spaces the text already has
  const plain = sql.split('\n');
  return rows
    .map((r, i) => {
      const lead = (plain[i] || '').match(/^ */)[0].length;
      const rowClass = primaryLines.has(i) ? ' diag-row' : relatedLines.has(i) ? ' diag-related-row' : '';
      return `<div class="lrow${rowClass}" style="--i:${Math.floor(lead / 2)}">${r || '<br>'}</div>`;
    })
    .join('');
}

/* One gutter entry per rendered row, each as tall as that row actually is -
   logical lines in the source pane soft-wrap over several visual rows. All the
   offsets are read before anything is written, so this costs one layout flush. */
function paintGutter(mirrorEl, gutInEl, editorEl, marks, wide) {
  const rows = mirrorEl.querySelectorAll('.lrow');
  if (!rows.length) { gutInEl.innerHTML = ''; return; }

  const tops = [];
  for (const r of rows) tops.push(r.offsetTop);
  const lastBottom = tops[tops.length - 1] + rows[rows.length - 1].offsetHeight;

  let html = '';
  for (let i = 0; i < rows.length; i++) {
    const h = (i + 1 < rows.length ? tops[i + 1] : lastBottom) - tops[i];
    html += `<i style="height:${h}px">${marks[i] || ''}</i>`;
  }
  const digits = Math.max(2, String(marks.length).length);
  editorEl.style.setProperty('--gut', `calc(${digits}ch + ${wide ? 34 : 24}px)`);
  gutInEl.innerHTML = html;
}

/* ------------------------------------------------------------- diagnostics */

function activeDiag() {
  return activeDiagnostic >= 0 ? diagnostics[activeDiagnostic] || null : null;
}

function attr(s) {
  return esc(String(s)).replace(/"/g, '&quot;');
}

function clampOffset(text, at) {
  return Math.max(0, Math.min(text.length, Number.isFinite(at) ? at : 0));
}

function rangesHit(aStart, aEnd, bStart, bEnd) {
  if (aStart === aEnd) return bStart <= aStart && aStart < bEnd;
  if (bStart === bEnd) return aStart <= bStart && bStart < aEnd;
  return aStart < bEnd && aEnd > bStart;
}

function diagnosticTokenClass(tk, view) {
  if (!view || tk.start === undefined) return '';
  let cls = '';
  if (rangesHit(tk.start, tk.end, view.primary.start, view.primary.end)) cls += ' diag-primary';
  if (view.related && rangesHit(tk.start, tk.end, view.related.start, view.related.end)) cls += ' diag-related';
  return cls;
}

function diagnosticLines(text, range) {
  const lines = new Set();
  if (!range) return lines;
  const add = at => lines.add((text.slice(0, clampOffset(text, at)).match(/\n/g) || []).length);
  add(range.start);
  if (range.end > range.start) add(range.end - 1);
  return lines;
}

function diagnosticView(d, text, sourceText, sourceAligned = false) {
  if (!d) return null;
  if (sourceAligned) {
    return {
      primary: { start: d.start, end: d.end },
      related: d.relatedStart === undefined ? null : { start: d.relatedStart, end: d.relatedEnd },
    };
  }

  const sourceToStart = anchor => indexOfAnchorStart(text, anchor);
  const sourceToEnd = anchor => indexOfAnchorEnd(text, anchor);
  return {
    primary: { start: sourceToStart(d.anchorStart), end: sourceToEnd(d.anchorEnd) },
    related: d.relatedAnchorStart === undefined ? null : {
      start: sourceToStart(d.relatedAnchorStart), end: sourceToEnd(d.relatedAnchorEnd),
    },
  };
}

function diagnosticPosition(sql, at) {
  const offset = clampOffset(sql, at);
  const before = sql.slice(0, offset);
  const line = (before.match(/\n/g) || []).length + 1;
  const lastBreak = before.lastIndexOf('\n');
  return { line, column: offset - lastBreak };
}

function makeDiagnostic(sql, type, message, short, start, end, relatedStart, relatedEnd) {
  const d = {
    type, message, short,
    start: clampOffset(sql, start), end: clampOffset(sql, end),
  };
  const pos = diagnosticPosition(sql, d.start);
  d.line = pos.line;
  d.column = pos.column;
  d.anchorStart = anchorOf(sql, d.start);
  d.anchorEnd = anchorOf(sql, d.end);
  if (relatedStart !== undefined) {
    d.relatedStart = clampOffset(sql, relatedStart);
    d.relatedEnd = clampOffset(sql, relatedEnd === undefined ? relatedStart : relatedEnd);
    d.relatedAnchorStart = anchorOf(sql, d.relatedStart);
    d.relatedAnchorEnd = anchorOf(sql, d.relatedEnd);
  }
  return d;
}

function structuralDiagnostics(sql) {
  const stack = [];
  const found = [];

  for (const tk of tokensFor(sql)) {
    if ((tk.t === 'str' || tk.t === 'qid') && !tk.closed) {
      const close = tk.quote === '[' ? ']' : tk.quote;
      const bracketedIdentifier = tk.t === 'qid' && tk.quote === '[';
      found.push(makeDiagnostic(
        sql,
        bracketedIdentifier ? 'missing-identifier-bracket' : 'unclosed-quote',
        bracketedIdentifier
          ? `missing closing bracket ${JSON.stringify(close)}`
          : `missing closing quote ${JSON.stringify(close)}`,
        bracketedIdentifier ? `Missing ${close}` : `Missing ${JSON.stringify(close)}`,
        tk.start, tk.end,
      ));
      continue;
    }
    if (tk.t === 'comment' && tk.line === false && !tk.closed) {
      found.push(makeDiagnostic(
        sql, 'unclosed-comment', 'missing closing comment marker "*/"',
        'Missing */', tk.start, tk.end,
      ));
      continue;
    }
    if (tk.t !== 'paren') continue;
    if (tk.v === '(') stack.push(tk);
    else if (!stack.length) {
      found.push(makeDiagnostic(
        sql, 'unexpected-bracket', 'unexpected closing bracket ")"',
        'Unexpected )', tk.start, tk.end,
      ));
    } else stack.pop();
  }

  for (const open of stack) {
    found.push(makeDiagnostic(
      sql, 'missing-bracket', 'missing closing bracket ")"',
      'Missing )', sql.length, sql.length, open.start, open.end,
    ));
  }

  return found.sort((a, b) => a.start - b.start || (a.relatedStart || 0) - (b.relatedStart || 0));
}

function nextCodeToken(tokens, index) {
  for (let i = index + 1; i < tokens.length; i++) {
    if (tokens[i].t !== 'ws' && tokens[i].t !== 'comment') return tokens[i];
  }
  return null;
}

function previousCodeToken(tokens, index) {
  for (let i = index - 1; i >= 0; i--) {
    if (tokens[i].t !== 'ws' && tokens[i].t !== 'comment') return tokens[i];
  }
  return null;
}

function identifierTokenName(tk) {
  if (!tk || (tk.t !== 'word' && tk.t !== 'qid')) return '';
  if (tk.t === 'word') return tk.v;
  if (tk.quote === '[') return tk.v.slice(1, -1).replace(/]]/g, ']');
  return tk.v.slice(1, -1).replace(/``/g, '`');
}

/* The syntax parser can tell us that name(...) has the shape of a function
   call, but it cannot tell whether name is one of the dialects we support.
   Do that schema-independent check here so typos do not get a false
   "Syntax OK" result. */
function unknownFunctionDiagnostics(sql) {
  const tokens = tokensFor(sql);
  const found = [];

  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    if (tk.t !== 'word' && tk.t !== 'qid') continue;

    const next = nextCodeToken(tokens, i);
    if (!next || next.t !== 'paren' || next.v !== '(') continue;

    const name = identifierTokenName(tk);
    const upper = name.toUpperCase();
    if (KNOWN_FUNCTIONS.has(upper) || PAREN_EXPRESSION_KEYWORDS.has(upper)) continue;

    /* In CREATE FUNCTION ... the name is a declaration, not a call. */
    const previous = previousCodeToken(tokens, i);
    if (previous && previous.t === 'word' && previous.v.toUpperCase() === 'FUNCTION') continue;

    found.push(makeDiagnostic(
      sql,
      'unknown-function',
      `unknown SQL function ${JSON.stringify(name)}`,
      `Unknown function ${JSON.stringify(name)}`,
      tk.start,
      tk.end,
    ));
  }

  return found;
}

/* node-sql-parser is configured for MySQL, which uses backticks for quoted
   identifiers. Accept square-bracket identifiers in the editor by translating
   only the parser's private copy; the source and formatted text stay intact. */
function parserInput(sql) {
  return tokensFor(sql).map(tk => {
    if (tk.t === 'qid' && tk.quote === '[' && tk.closed) {
      return `\`${tk.v.slice(1, -1)}\``;
    }
    return tk.v;
  }).join('');
}

function offsetFromPosition(text, pos) {
  if (!pos) return text.length;
  if (typeof pos.offset === 'number') return clampOffset(text, pos.offset);
  const line = Math.max(1, Number(pos.line) || 1);
  const column = Math.max(1, Number(pos.column) || 1);
  let at = 0;
  for (let n = 1; n < line; n++) {
    const next = text.indexOf('\n', at);
    if (next < 0) return text.length;
    at = next + 1;
  }
  return clampOffset(text, at + column - 1);
}

function parserDiagnostic(sql, trimmed, err, prefix) {
  const parserText = prefix + parserInput(trimmed);
  const loc = err && err.location && err.location.start;
  const parserAt = offsetFromPosition(parserText, loc);
  const trimmedAt = Math.max(0, sql.indexOf(trimmed));
  const start = clampOffset(sql, trimmedAt + parserAt - prefix.length);
  const rawFound = err && err.found == null ? '' : String(err.found || '');
  const atEnd = !rawFound || /end of input/i.test(rawFound);
  const found = rawFound.slice(0, 24);
  const message = atEnd
    ? 'unexpected end of SQL'
    : `unexpected ${JSON.stringify(found)}`;
  const short = atEnd ? 'Unexpected end of SQL' : `Unexpected ${JSON.stringify(found)}`;
  const end = atEnd ? start : clampOffset(sql, start + Math.max(1, found.length));
  return makeDiagnostic(sql, 'parser', message, short, start, end);
}

function parserDiagnosticIsCovered(d, structural) {
  return structural.some(s =>
    (d.message === 'unexpected end of SQL' &&
      ['missing-bracket', 'missing-identifier-bracket', 'unclosed-quote', 'unclosed-comment'].includes(s.type)) ||
    (s.type === 'unexpected-bracket' && s.start === d.start) ||
    (['missing-identifier-bracket', 'unclosed-quote', 'unclosed-comment'].includes(s.type) && d.start >= s.start),
  );
}

/* --------------------------------------------------------------- validity */

let parser = null;
const STATEMENT = /^(SELECT|INSERT|UPDATE|DELETE|WITH|CREATE|ALTER|DROP|TRUNCATE|EXPLAIN|SHOW|REPLACE)\b/i;
const TAIL = /^(WHERE|ORDER|GROUP|HAVING|LIMIT|OFFSET|ON|USING|JOIN|LEFT|RIGHT|INNER|FULL|CROSS|NATURAL|UNION)\b/i;
const AS_CLAUSE = 'SELECT * FROM __t ';
const AS_PREDICATE = 'SELECT * FROM __t WHERE ';
const LIVE_PARSE_MAX_CHARS = 8000;
const LIVE_PARSE_MAX_TOKENS = 1600;
const LIVE_PARSE_MAX_OR = 120;

function getParser() {
  if (parser) return parser;
  if (typeof window.Parser !== 'function') return null;
  parser = new window.Parser();
  return parser;
}

/* A paste may be a whole statement, a trailing clause, or - most often here -
   a bare boolean predicate with no WHERE in front of it. Try each shape. */
function candidates(sql) {
  if (STATEMENT.test(sql)) return [['', 'Syntax OK']];
  if (TAIL.test(sql)) return [[AS_CLAUSE, 'Syntax OK'], [AS_PREDICATE, 'Syntax OK']];
  return [[AS_PREDICATE, 'Syntax OK'], [AS_CLAUSE, 'Syntax OK'], ['', 'Syntax OK']];
}

function liveParseTooExpensive(sql) {
  if (sql.length > LIVE_PARSE_MAX_CHARS) return true;
  const tokens = tokensFor(sql);
  if (tokens.length > LIVE_PARSE_MAX_TOKENS) return true;
  let ors = 0;
  for (const tk of tokens) {
    if (tk.t === 'word' && tk.v.toUpperCase() === 'OR' && ++ors > LIVE_PARSE_MAX_OR) return true;
  }
  return false;
}

function validate(sql) {
  const trimmed = sql.trim();
  if (!trimmed) return { state: '', text: '', diagnostics: [] };
  const structural = structuralDiagnostics(sql);
  const unknownFunctions = unknownFunctionDiagnostics(sql);
  const preflight = structural.concat(unknownFunctions)
    .sort((a, b) => a.start - b.start || (a.relatedStart || 0) - (b.relatedStart || 0));
  if (preflight.length) return { state: 'bad', text: '', diagnostics: preflight };
  if (liveParseTooExpensive(trimmed)) {
    return { state: '', text: 'syntax check deferred for large SQL', diagnostics: [] };
  }
  const p = getParser();
  if (!p) {
    return { state: '', text: 'syntax check unavailable', diagnostics: [] };
  }

  let first = null;
  const parseText = parserInput(trimmed);
  for (const [prefix, label] of candidates(trimmed)) {
    try {
      p.astify(prefix + parseText, { database: 'MySQL' });
      return { state: 'ok', text: label, diagnostics: [] };
    } catch (err) {
      if (!first) first = { err, prefix };
    }
  }

  const parser = first ? parserDiagnostic(sql, trimmed, first.err, first.prefix) : null;
  const all = preflight.slice();
  if (parser && !parserDiagnosticIsCovered(parser, structural)) all.push(parser);
  all.sort((a, b) => a.start - b.start || (a.relatedStart || 0) - (b.relatedStart || 0));
  if (!all.length) {
    const raw = String((first && first.err && first.err.message) || 'parse error').split('\n')[0];
    all.push(makeDiagnostic(sql, 'parser', `could not parse SQL: ${raw.slice(0, 120)}`, 'Could not parse SQL', sql.length, sql.length));
  }
  return { state: 'bad', text: '', diagnostics: all };
}

/* ------------------------------------------------------------------- wiring */

const src = document.getElementById('src');
const srcMirror = document.getElementById('srcMirror');
const srcEditor = document.getElementById('srcEditor');
const srcGutIn = document.getElementById('srcGutIn');
const srcCur = document.getElementById('srcCur');
const srcMatch = document.getElementById('srcMatch');

const fmt = document.getElementById('fmt');
const fmtMirror = document.getElementById('fmtMirror');
const fmtEditor = document.getElementById('fmtEditor');
const fmtGutIn = document.getElementById('fmtGutIn');
const fmtCur = document.getElementById('fmtCur');
const fmtMatch = document.getElementById('fmtMatch');
const srcHov = document.getElementById('srcHov');
const fmtHov = document.getElementById('fmtHov');
const fmtDiagLine = document.getElementById('fmtDiagLine');
const fmtDiagLabel = document.getElementById('fmtDiagLabel');

const statusEl = document.getElementById('status');
const statusText = document.getElementById('statusText');
const foldAllButton = document.getElementById('foldAll');
const foldAllText = document.getElementById('foldAllText');
const optimiserButton = document.getElementById('optimiser');

const KEY = 'sqlviewer.input';

let frame = 0, timer = 0, saveTimer = 0, foldedRenderFrame = 0, fastEditFrame = 0;
let selectionSyncFrame = 0, diagnosticIndicatorFrame = 0;
let editPaintTimer = 0, validationVersion = 0;
let doc = { lines: [], folds: new Map() };
const folded = new Set();
let rowLine = [];              // rendered row -> its line number in doc.lines
let foldAnchors = [];          // offset in the collapsed text -> anchor in the full text
let fmtSelectionMap = { fullText: '', shown: '', boundaries: [0], markers: [] };
let rawGutterMode = '';
let paintedSourceValue = null;
let sourceMirrorMode = 'highlighted';
let fmtMirrorMode = 'highlighted';
let lastFmtValue = '';
let fmtScrollPadding = 0;
let fmtScrollLimit = null;
const hoverY = new WeakMap();
let diagnostics = [];
let activeDiagnostic = -1;
let diagnosticNavigated = false;

/* Native textarea undo becomes unreliable after a folded view is mapped back
   into the full SQL and after a collapsed block is removed programmatically.
   Keep a lightweight state history so Ctrl+Z restores the exact visible view,
   hidden SQL, folds, and caret in one fast operation. */
const HISTORY_LIMIT = 80;
const HISTORY_MERGE_MS = 550;
let undoStack = [], redoStack = [];
let historyCurrent = null;
let historyBefore = null;
let historyTarget = '';
let historyApplying = false;
let pendingInputTarget = '';

/* What stands in for a collapsed chain. Three plain characters, so the pill in
   the mirror is exactly 3ch wide and the textarea underneath can hold the same
   three characters and still line up. */
const MARK = '...';

const nonWs = s => { let n = 0; for (const c of s) if (!/\s/.test(c)) n++; return n; };
let fmtDirty = false;          // true while the formatted pane is being typed in

/* Large SQL documents should stay on the native textarea's fast path. During
   active typing we patch only the affected visual row, then restore complete
   token highlighting once the user pauses. */
const FAST_EDIT_CHARS = 3000;
const FAST_EDIT_ROWS = 160;

/* ---- status ---- */

function diagnosticStatusText() {
  const d = activeDiag();
  if (!d) return '';
  const prefix = diagnostics.length > 1
    ? `error ${activeDiagnostic + 1}/${diagnostics.length}`
    : 'error';
  return `${prefix}: ${d.message} at line ${d.line}, col ${d.column}`;
}

function setStatus(state, text) {
  statusEl.dataset.s = state;
  statusText.textContent = text;
  const clickable = state === 'bad' && diagnostics.length > 0;
  statusEl.disabled = !clickable;
  statusEl.title = clickable ? `${text}. Click to show the next error.` : text;
  statusEl.setAttribute('aria-label', text || 'SQL validity check');
}

function clearDiagnostics() {
  diagnostics = [];
  activeDiagnostic = -1;
  diagnosticNavigated = false;
}

function hasFoldLayout(map = fmtSelectionMap) {
  return !!(map && (map.folds || []).length);
}

function updateFoldAllButton() {
  const folds = fmtDirty
    ? (fmtSelectionMap.folds || []).map(fold => fold.line)
    : [...(doc.folds || new Map()).keys()];
  const lines = [...new Set(folds)];
  const allCollapsed = lines.length > 0 && lines.every(line => folded.has(line));
  const action = allCollapsed ? 'Expand all' : 'Collapse all';

  foldAllButton.disabled = lines.length === 0;
  foldAllText.textContent = action;
  foldAllButton.title = `${action} brackets`;
  foldAllButton.setAttribute('aria-label', `${action} brackets`);
}

/* localStorage is synchronous. Debounce it so persistence never blocks the
   input event that should be rendering the next character. */
function schedulePersist(sql) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = 0;
    localStorage.setItem(KEY, sql);
  }, 300);
}

function paintDiagnosticState() {
  clearTimeout(editPaintTimer);
  editPaintTimer = 0;
  const sourceReady = sourceMirrorMode === 'highlighted' && paintedSourceValue === src.value;
  const fmtReady = fmtDirty
    ? fmtMirrorMode === 'highlighted' && lastFmtValue === fmt.value
    : rawGutterMode === 'formatted' && lastFmtValue === fmt.value;
  if (!activeDiag() && sourceReady && fmtReady) return;
  paintSrc();
  if (fmtDirty) {
    if (folded.size || hasFoldLayout()) paintFmtRawFolded(); else paintFmtRaw();
  } else paintFmt();
}

function applyValidation(result) {
  diagnostics = result.diagnostics || [];
  activeDiagnostic = diagnostics.length ? 0 : -1;
  diagnosticNavigated = false;
  setStatus(result.state, diagnostics.length ? diagnosticStatusText() : result.text);
  paintDiagnosticState();
}

function scheduleValidate(sql) {
  const version = ++validationVersion;
  clearTimeout(timer);
  setStatus('', 'checking...');
  /* Undo/redo can repair the SQL without passing through the native input
     event. Clear the previous diagnostic immediately so an old parser error
     (for example, unexpected "d") cannot remain visible while the restored
     value is being checked. */
  clearDiagnostics();
  timer = setTimeout(() => {
    if (version !== validationVersion || sql !== src.value) return;
    const r = validate(sql);
    if (version !== validationVersion || sql !== src.value) return;
    applyValidation(r);
  }, 220);
}

function showDiagnostic(index) {
  if (!diagnostics.length) return;
  activeDiagnostic = (index + diagnostics.length) % diagnostics.length;
  diagnosticNavigated = true;
  /* An error hidden inside a fold cannot be navigated to. Make the full
     formatted document visible before mapping and scrolling to the marker. */
  clearFmtScrollPadding();
  folded.clear();
  paintDiagnosticState();

  const d = activeDiag();
  setStatus('bad', diagnosticStatusText());
  const fmtView = diagnosticView(d, fmt.value, src.value);
  revealCaret(fmt, fmtMirror, fmt.value, fmtView.primary.start);
  syncScroll(fmt, fmtMirror, fmtGutIn);
  paintDiagnosticIndicator(fmtMirror, fmtEditor, fmtDiagLine, fmtDiagLabel, fmt.value, fmtView, d);
  syncHistoryView();
}

/* ---- painting ---- */

/* While a chain is collapsed the mirror holds fewer rows than the textarea, so
   it cannot always scroll as far. Let the mirror's clamped value win and push it
   back into the textarea: the gutter follows the textarea, and if the two drift
   the numbers slide out of step with the rows they are numbering. */
function syncScroll(ta, mirrorEl, gutInEl) {
  const requestedTop = ta === fmt && fmtScrollLimit !== null
    ? Math.min(ta.scrollTop, fmtScrollLimit)
    : ta.scrollTop;
  if (ta.scrollTop !== requestedTop) ta.scrollTop = requestedTop;
  mirrorEl.scrollTop = requestedTop;
  mirrorEl.scrollLeft = ta.scrollLeft;
  const top = mirrorEl.scrollTop;
  if (top !== ta.scrollTop) ta.scrollTop = top;   // settles in one bounce
  gutInEl.style.transform = `translateY(${-top}px)`;
  refreshHoverLine(ta === fmt ? fmtEditor : srcEditor, mirrorEl, ta === fmt ? fmtHov : srcHov);
}

/* When the final fold is collapsed at the bottom of the pane, the new content
   can be too short to hold the line that was at the top of the viewport. Give
   the formatted pane just enough temporary trailing space to keep that line
   anchored instead of letting the browser clamp scrollTop upwards. */
function setFmtScrollPadding(extra) {
  const next = Math.max(0, Number(extra) || 0);
  if (Math.abs(next - fmtScrollPadding) < 0.1) return;
  const value = next ? `calc(var(--pad) + ${next}px)` : '';
  fmt.style.paddingBottom = value;
  fmtMirror.style.paddingBottom = value;
  fmtScrollPadding = next;
}

function clearFmtScrollPadding() {
  fmtScrollLimit = null;
  setFmtScrollPadding(0);
}

function fmtScrollMax() {
  const fmtMax = Math.max(0, fmt.scrollHeight - fmt.clientHeight);
  const mirrorMax = Math.max(0, fmtMirror.scrollHeight - fmtMirror.clientHeight);
  return Math.min(fmtMax, mirrorMax);
}

function clampFmtScrollLimit() {
  const max = fmtScrollMax();
  const limit = fmtScrollLimit === null ? max : Math.min(max, fmtScrollLimit);
  const top = Math.max(0, Math.min(fmt.scrollTop, limit));
  if (fmt.scrollTop !== top) fmt.scrollTop = top;
  if (fmtMirror.scrollTop !== top) fmtMirror.scrollTop = top;
  return top;
}

function fmtAtBottom() {
  const max = fmtScrollMax();
  return fmt.scrollTop >= max - 1;
}

/* The scroll event is delivered after a wheel gesture has moved the textarea.
   When a final-fold lock is active, stop a wheel that would cross that exact
   boundary and place the textarea on it immediately. This keeps the browser
   from handing the excess delta to another scroll container, while a negative
   delta is always allowed to move back up. */
function keepFmtWheelInsideBoundary(e) {
  if (!e.deltaY || e.deltaY < 0) return;

  const max = fmtScrollMax();
  const limit = fmtScrollLimit === null ? max : Math.min(max, fmtScrollLimit);
  const delta = e.deltaMode === 1 ? e.deltaY * 16
    : e.deltaMode === 2 ? e.deltaY * fmt.clientHeight
      : e.deltaY;
  if (fmt.scrollTop >= limit - 1 || fmt.scrollTop + delta >= limit) {
    fmt.scrollTop = limit;
    syncScroll(fmt, fmtMirror, fmtGutIn);
    e.preventDefault();
  }
}

function lineMatchesDiagnostic(line, view, key, isLast = false) {
  const range = view && view[key];
  if (!range) return false;
  if (line.toks.some(tk => tk.start !== undefined && rangesHit(tk.start, tk.end, range.start, range.end))) return true;
  return key === 'primary' && isLast && range.start === range.end;
}

function diagnosticGutterMark(on, d) {
  return on && d ? `<span class="diag-glyph" title="${attr(d.message)}">!</span>` : '';
}

function hideDiagnosticIndicator(lineEl, labelEl) {
  lineEl.style.display = 'none';
  labelEl.style.display = 'none';
}

function paintDiagnosticIndicator(mirrorEl, editorEl, lineEl, labelEl, text, view, d) {
  if (!d || !view || !mirrorEl.children.length) {
    hideDiagnosticIndicator(lineEl, labelEl);
    return;
  }

  const idx = clampOffset(text, view.primary.start);
  const upto = text.slice(0, idx);
  const line = (upto.match(/\n/g) || []).length;
  const col = idx - (upto.lastIndexOf('\n') + 1);
  const row = mirrorEl.children[Math.min(line, mirrorEl.children.length - 1)];
  if (!row) {
    hideDiagnosticIndicator(lineEl, labelEl);
    return;
  }

  const lh = parseFloat(getComputedStyle(mirrorEl).lineHeight);
  const rowTop = row.getBoundingClientRect().top;
  const rect = rangeAt(row, col).getBoundingClientRect();
  const wrapped = rect.height ? Math.round((rect.top - rowTop) / lh) : 0;
  const editorTop = editorEl.getBoundingClientRect().top;
  const top = rowTop - editorTop + wrapped * lh;

  lineEl.style.display = 'block';
  lineEl.style.height = `${lh}px`;
  lineEl.style.top = `${top}px`;
  labelEl.textContent = d.short;
  labelEl.style.display = 'block';
  labelEl.style.top = `${top + 2}px`;
}

/* The diagnostic overlays sit above the scrolling mirror, so their positions
   are viewport-relative. Repaint them after scrolling to keep the callout
   attached to the same error row instead of leaving it behind. */
function paintActiveDiagnosticIndicator() {
  if (fmtMirrorMode !== 'highlighted') {
    hideDiagnosticIndicator(fmtDiagLine, fmtDiagLabel);
    return;
  }
  const d = activeDiag();
  paintDiagnosticIndicator(
    fmtMirror, fmtEditor, fmtDiagLine, fmtDiagLabel, fmt.value,
    diagnosticView(d, fmt.value, src.value), d,
  );
}

function scheduleDiagnosticIndicator() {
  if (diagnosticIndicatorFrame) return;
  diagnosticIndicatorFrame = requestAnimationFrame(() => {
    diagnosticIndicatorFrame = 0;
    paintActiveDiagnosticIndicator();
  });
}

function paintSrc() {
  srcMirror.innerHTML = highlightRows(src.value, { n: 0 });
  const marks = [];
  for (let i = 0; i < srcMirror.children.length; i++) marks.push(`<b>${i + 1}</b>`);
  paintGutter(srcMirror, srcGutIn, srcEditor, marks, false);
  paintedSourceValue = src.value;
  sourceMirrorMode = 'highlighted';
  syncScroll(src, srcMirror, srcGutIn);
}

function paintSrcFast() {
  const lines = src.value.split('\n');
  srcMirror.innerHTML = lines.map(text => {
    const lead = (text.match(/^ */) || [''])[0].length;
    return `<div class="lrow" style="--i:${Math.floor(lead / 2)}">${esc(text) || '<br>'}</div>`;
  }).join('') || '<div class="lrow"><br></div>';
  const marks = lines.map((_, i) => `<b>${i + 1}</b>`);
  paintGutter(srcMirror, srcGutIn, srcEditor, marks, false);
  paintedSourceValue = src.value;
  sourceMirrorMode = 'plain';
  syncScroll(src, srcMirror, srcGutIn);
}

/* the formatted pane in reading mode: fold arrows, collapsed chains */
function paintFmt() {
  const { lines, folds } = doc;
  const d = activeDiag();
  const view = diagnosticView(d, src.value, src.value, true);
  const rows = [], marks = [], texts = [], seq = { n: 0 };
  let i = 0;
  rowLine = [];

  const fullLines = lines.map(lineText);
  const fullText = fullLines.join('\n');
  const lineStart = [];
  let fullAt = 0;
  for (let k = 0; k < fullLines.length; k++) {
    lineStart.push(fullAt);
    fullAt += fullLines[k].length + (k + 1 < fullLines.length ? 1 : 0);
  }

  /* The textarea is shorter while folded, but a selection crossing a pill
     still needs to know which range of the expanded text it represents. */
  const selectionMap = {
    fullText,
    shown: '',
    boundaries: [0],
    markers: [],
    anchorIndex: buildAnchorIndex(fullText),
  };
  const mapText = (text, start) => {
    const at = selectionMap.shown.length;
    selectionMap.shown += text;
    for (let k = 0; k < text.length; k++) {
      selectionMap.boundaries[at + k] = start + k;
      selectionMap.boundaries[at + k + 1] = start + k + 1;
    }
  };
  const mapMarker = (text, start, end, line) => {
    const at = selectionMap.shown.length;
    selectionMap.shown += text;
    selectionMap.boundaries[at] = start;
    for (let k = 1; k < text.length; k++) selectionMap.boundaries[at + k] = start;
    selectionMap.boundaries[at + text.length] = end;
    selectionMap.markers.push({ start: at, end: at + text.length, fullStart: start, fullEnd: end, line });
  };

  // non-whitespace characters before each line of the fully expanded text
  const lineAnchor = [];
  let acc = 0;
  for (const ln of lines) { lineAnchor.push(acc); acc += nonWs(lineText(ln)); }
  foldAnchors = [];
  let a = 0;

  while (i < lines.length) {
    const end = folds.get(i);
    const shut = end !== undefined && folded.has(i);

    let html = lineHtml(lines[i], seq, true, view);
    let text = lineText(lines[i]);
    mapText(text, lineStart[i]);
    a = lineAnchor[i];
    for (const c of text) { foldAnchors.push(a); if (!/\s/.test(c)) a++; }

    if (shut) {
      html += `<span class="ell" data-fold="${i}" title="Expand">${MARK}</span>` + lineHtml(lines[end], seq, false, view);
      const tail = lineText(lines[end], false);
      for (let k = 0; k < MARK.length; k++) foldAnchors.push(a);   // the pill counts for nothing
      a = lineAnchor[end];
      for (const c of tail) { foldAnchors.push(a); if (!/\s/.test(c)) a++; }
      const tailStart = lineStart[end] + fullLines[end].length - tail.length;
      mapMarker(MARK, lineStart[i] + text.length, tailStart, i);
      mapText(tail, tailStart);
      text += MARK + tail;
    }
    const last = shut ? end : i;
    if (last + 1 < lines.length) mapText('\n', lineStart[last] + fullLines[last].length);
    foldAnchors.push(a);                                            // the newline
    texts.push(text);

    let primary = false, related = false;
    for (let line = i; line <= (shut ? end : i); line++) {
      primary ||= lineMatchesDiagnostic(lines[line], view, 'primary', line === lines.length - 1);
      related ||= lineMatchesDiagnostic(lines[line], view, 'related', line === lines.length - 1);
    }
    rows.push(`<div class="lrow${primary ? ' diag-row' : related ? ' diag-related-row' : ''}" style="--i:${lines[i].indent}">${html || '<br>'}</div>`);
    rowLine.push(i);
    marks.push(diagnosticGutterMark(primary, d) + `<b>${i + 1}</b>` + (end === undefined
      ? '<s class="fs"></s>'
      : `<s class="fold${shut ? ' shut' : ''}" data-fold="${i}" title="${shut ? 'Expand' : 'Collapse'}">${shut ? '&#x25B8;' : '&#x25BE;'}</s>`));

    i = shut ? end + 1 : i + 1;
  }

  selectionMap.rows = rowLine.slice();
  selectionMap.folds = foldDescriptors(doc, fullText, null, selectionMap.anchorIndex);
  fmtSelectionMap = selectionMap;
  fmtMirror.innerHTML = rows.join('') || '<div class="lrow"><br></div>';

  /* The textarea holds exactly what is on screen. While a chain is collapsed
     that is the shortened text, so clicking still lands the caret where you
     aimed. Edits are mapped back to the full formatted text in fromFmt(), so
     the fold can stay closed while the visible part is edited. */
  const shown = folded.size ? texts.join('\n') : formattedText(lines);
  if (fmt.value !== shown) fmt.value = shown;
  fmt.readOnly = false;

  paintGutter(fmtMirror, fmtGutIn, fmtEditor, marks, true);
  rawGutterMode = 'formatted';
  fmtMirrorMode = 'highlighted';
  lastFmtValue = fmt.value;
  syncScroll(fmt, fmtMirror, fmtGutIn);
  paintDiagnosticIndicator(
    fmtMirror, fmtEditor, fmtDiagLine, fmtDiagLabel, fmt.value,
    diagnosticView(d, fmt.value, src.value), d,
  );
  updateFoldAllButton();
}

/* the formatted pane while you are typing in it: no folds, no re-layout */
function paintFmtRaw(reuseGutter = false) {
  const d = activeDiag();
  const view = diagnosticView(d, fmt.value, src.value);
  fmtMirror.innerHTML = highlightRows(fmt.value, { n: 0 }, view);
  rowLine = fmt.value.split('\n').map((_, i) => i);
  const primaryLines = diagnosticLines(fmt.value, view && view.primary);
  const marks = [];
  for (let i = 0; i < fmtMirror.children.length; i++) {
    marks.push(diagnosticGutterMark(primaryLines.has(i), d) + `<b>${i + 1}</b><s class="fs"></s>`);
  }
  const canReuseGutter = reuseGutter && rawGutterMode === 'raw'
    && fmtGutIn.children.length === fmtMirror.children.length;
  if (!canReuseGutter) paintGutter(fmtMirror, fmtGutIn, fmtEditor, marks, true);
  rawGutterMode = 'raw';
  fmtMirrorMode = 'highlighted';
  lastFmtValue = fmt.value;
  fmtEditor.classList.remove('folded');
  syncScroll(fmt, fmtMirror, fmtGutIn);
  paintDiagnosticIndicator(fmtMirror, fmtEditor, fmtDiagLine, fmtDiagLabel, fmt.value, view, d);
  updateFoldAllButton();
}

function editChangesRows(before, change) {
  return before.slice(change.start, change.end).includes('\n') || change.inserted.includes('\n');
}

function shouldUseFastEdit(text) {
  return text.length >= FAST_EDIT_CHARS || textLineStarts(text).length >= FAST_EDIT_ROWS;
}

function canPatchRawEdit(before, change, next) {
  if (editChangesRows(before, change)) return false;
  return fmtMirror.children.length === textLineStarts(next).length;
}

/* Replace the one changed row without touching the other highlighted rows.
   The row is plain only while typing; the idle repaint restores its token
   spans. This keeps the native textarea responsive even for very long SQL. */
function patchRawMirrorRow(text, change, foldedView) {
  const starts = textLineStarts(text);
  const row = displayRowAtStarts(starts, change.start);
  const rowEl = fmtMirror.children[row];
  if (!rowEl) return false;

  const rowStart = starts[row] ?? 0;
  const rowEnd = row + 1 < starts.length ? starts[row + 1] - 1 : text.length;
  const rowText = text.slice(rowStart, rowEnd);
  rowEl.className = 'lrow';
  rowEl.style.setProperty('--i', String(Math.floor(((rowText.match(/^ */) || [''])[0].length) / 2)));
  rowEl.textContent = rowText;
  if (!rowText) rowEl.innerHTML = '<br>';

  if (foldedView) {
    for (const marker of fmtSelectionMap.markers || []) {
      if (displayRowAtStarts(starts, marker.start) !== row) continue;
      if (text.slice(marker.start, marker.end) !== MARK) continue;
      wrapTextRange(rowEl, marker.start - rowStart, marker.end - rowStart, span => {
        span.className = 'ell';
        span.dataset.fold = marker.line;
        span.title = 'Expand';
      });
    }
  }
  return true;
}

function paintFmtRawFast(change) {
  if (!patchRawMirrorRow(fmt.value, change, false)) return false;
  rowLine = fmt.value.split('\n').map((_, i) => i);
  rawGutterMode = 'raw';
  fmtMirrorMode = 'plain';
  lastFmtValue = fmt.value;
  fmtEditor.classList.remove('folded');
  syncScroll(fmt, fmtMirror, fmtGutIn);
  hideDiagnosticIndicator(fmtDiagLine, fmtDiagLabel);
  updateFoldAllButton();
  return true;
}

function paintFmtRawFoldedFast(change) {
  if (!patchRawMirrorRow(fmt.value, change, true)) return false;
  rawGutterMode = 'raw-folded';
  fmtMirrorMode = 'plain';
  lastFmtValue = fmt.value;
  syncScroll(fmt, fmtMirror, fmtGutIn);
  hideDiagnosticIndicator(fmtDiagLine, fmtDiagLabel);
  updateFoldAllButton();
  return true;
}

/* ---- caret: same spot in both panes ---- */

/* Formatting only ever rewrites whitespace, so the count of non-whitespace
   characters before the caret is the one anchor both texts agree on. */
function anchorOf(text, idx) {
  let k = 0;
  for (let i = 0; i < idx; i++) if (!/\s/.test(text[i])) k++;
  return k;
}

/* Build the non-whitespace prefix counts once. The folded editor uses these
   counts for every visible caret boundary; recalculating anchorOf() from the
   start for each boundary made long folded documents quadratic per keystroke. */
function buildAnchorIndex(text) {
  const index = new Uint32Array(text.length + 1);
  for (let i = 0; i < text.length; i++) {
    index[i + 1] = index[i] + (/\s/.test(text[i]) ? 0 : 1);
  }
  return index;
}

function anchorFromIndex(index, at) {
  if (!index || !index.length) return 0;
  return index[Math.max(0, Math.min(Number(at) || 0, index.length - 1))] || 0;
}

function indexOfAnchor(text, k) {
  if (k <= 0) return 0;
  let c = 0;
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) continue;
    if (++c === k) return i + 1;
  }
  return text.length;
}

function indexOfAnchorStart(text, k) {
  if (k <= 0) return 0;
  let c = 0;
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) continue;
    if (c++ === k) return i;
  }
  return text.length;
}

function indexOfAnchorEnd(text, k) {
  if (k <= 0) return 0;
  let c = 0;
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) continue;
    if (++c === k) return i + 1;
  }
  return text.length;
}

/* The formatted pane's caret as an anchor into the fully expanded text, and
   back again - so a collapsed pane still agrees with the source on where you
   are. Offsets hidden inside a fold resolve to the nearest visible one. */
function fmtAnchor() {
  const at = fmt.selectionStart;
  if (!folded.size) return anchorOf(fmt.value, at);
  return foldAnchors[Math.min(at, foldAnchors.length - 1)] || 0;
}

function fmtIndexOf(anchor) {
  if (!folded.size) return indexOfAnchor(fmt.value, anchor);
  for (let i = 0; i < foldAnchors.length; i++) if (foldAnchors[i] >= anchor) return i;
  return fmt.value.length;
}

function selectionAsFull(map, start, end, direction = 'none') {
  const max = map.shown.length;
  start = Math.max(0, Math.min(start, max));
  end = Math.max(start, Math.min(end, max));
  const boundaries = map.boundaries;
  let fullStart = boundaries[start] ?? map.fullText.length;
  let fullEnd = boundaries[end] ?? fullStart;
  const hits = [];

  for (const marker of map.markers) {
    if (end > marker.start && start < marker.end) {
      hits.push(marker);
      fullStart = Math.min(fullStart, marker.fullStart);
      fullEnd = Math.max(fullEnd, marker.fullEnd);
    }
  }

  return {
    start: Math.min(fullStart, fullEnd),
    end: Math.max(fullStart, fullEnd),
    displayStart: start,
    displayEnd: end,
    direction,
    hits,
  };
}

function fmtSelectionAsFull() {
  return selectionAsFull(
    fmtSelectionMap,
    fmt.selectionStart,
    fmt.selectionEnd,
    fmt.selectionDirection || 'none',
  );
}

/* Keep a mapped caret in view without scrolling the page or disturbing the
   user's position when it is already visible. The mirror has the same font,
   padding, and scroll offsets as its textarea, so its range gives us the
   exact visual position of the mapped character. */
function revealCaret(ta, mirrorEl, text, idx) {
  const upto = text.slice(0, idx);
  const line = (upto.match(/\n/g) || []).length;
  const col = idx - (upto.lastIndexOf('\n') + 1);
  const row = mirrorEl.children[line];
  if (!row) return;

  const cs = getComputedStyle(mirrorEl);
  const lh = parseFloat(cs.lineHeight);
  const padTop = parseFloat(cs.paddingTop);
  const padBottom = parseFloat(cs.paddingBottom);
  const padLeft = parseFloat(cs.paddingLeft);
  const padRight = parseFloat(cs.paddingRight);
  const editorRect = ta.getBoundingClientRect();

  let rect = rangeAt(row, col).getBoundingClientRect();
  const rectBottom = Math.max(rect.bottom, rect.top + lh);
  const viewTop = editorRect.top + padTop;
  const viewBottom = editorRect.top + ta.clientHeight - padBottom;

  if (rect.top < viewTop) ta.scrollTop += rect.top - viewTop;
  else if (rectBottom > viewBottom) ta.scrollTop += rectBottom - viewBottom;

  /* Sync before measuring x again: vertical scrolling may clamp in a folded
     pane, and the mirror must describe the same viewport as the textarea. */
  mirrorEl.scrollTop = ta.scrollTop;
  mirrorEl.scrollLeft = ta.scrollLeft;
  rect = rangeAt(row, col).getBoundingClientRect();

  const viewLeft = editorRect.left + padLeft;
  const viewRight = editorRect.left + ta.clientWidth - padRight;
  if (rect.left < viewLeft) ta.scrollLeft += rect.left - viewLeft;
  else if (rect.right > viewRight) ta.scrollLeft += rect.right - viewRight;

  mirrorEl.scrollTop = ta.scrollTop;
  mirrorEl.scrollLeft = ta.scrollLeft;
}

function rangeAt(row, col) {
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  let node, acc = 0;
  while ((node = walker.nextNode())) {
    const len = node.nodeValue.length;
    if (acc + len >= col) {
      const r = document.createRange();
      r.setStart(node, col - acc);
      r.collapse(true);
      return r;
    }
    acc += len;
  }
  const r = document.createRange();
  r.selectNodeContents(row);
  r.collapse(false);
  return r;
}

function paintCaretLine(mirrorEl, editorEl, curEl, text, idx, on) {
  if (!on) { curEl.style.display = 'none'; return; }
  const upto = text.slice(0, idx);
  const line = (upto.match(/\n/g) || []).length;
  const col = idx - (upto.lastIndexOf('\n') + 1);
  const row = mirrorEl.children[line];
  if (!row) { curEl.style.display = 'none'; return; }

  /* A collapsed range reports the glyph box, which sits a couple of pixels
     below the line box - taking it as-is left the text riding high in its own
     highlight. Use it only to pick which wrapped row we are on, then snap to
     the row grid. */
  const lh = parseFloat(getComputedStyle(mirrorEl).lineHeight);
  const rowTop = row.getBoundingClientRect().top;
  const rect = rangeAt(row, col).getBoundingClientRect();
  const wrapped = rect.height ? Math.round((rect.top - rowTop) / lh) : 0;

  curEl.style.display = 'block';
  curEl.style.height = `${lh}px`;
  curEl.style.top = `${rowTop - editorEl.getBoundingClientRect().top + wrapped * lh}px`;
}

function syncCarets(navigate = false) {
  const onSrc = document.activeElement === src;
  const onFmt = document.activeElement === fmt;
  if (!onSrc && !onFmt) {
    srcCur.style.display = 'none';
    fmtCur.style.display = 'none';
    clearBrackets();
    paintMatches();
    return;
  }

  // anchors are always counted against the fully expanded text
  const anchor = onSrc ? anchorOf(src.value, src.selectionStart) : fmtAnchor();
  const atSrc = onSrc ? src.selectionStart : indexOfAnchor(src.value, anchor);
  const atFmt = onSrc ? fmtIndexOf(anchor) : fmt.selectionStart;

  if (navigate) {
    if (onSrc) {
      if (fmt.selectionStart !== atFmt || fmt.selectionEnd !== atFmt) {
        fmt.setSelectionRange(atFmt, atFmt);
      }
      revealCaret(fmt, fmtMirror, fmt.value, atFmt);
      syncScroll(fmt, fmtMirror, fmtGutIn);
    } else if (onFmt) {
      if (src.selectionStart !== atSrc || src.selectionEnd !== atSrc) {
        src.setSelectionRange(atSrc, atSrc);
      }
      revealCaret(src, srcMirror, src.value, atSrc);
      syncScroll(src, srcMirror, srcGutIn);
    }
  }

  paintCaretLine(srcMirror, srcEditor, srcCur, src.value, atSrc, true);
  paintCaretLine(fmtMirror, fmtEditor, fmtCur, fmt.value, atFmt, true);
  paintMatches();
  markBrackets();
}

/* ---- the row under the pointer ---- */

/* The mirror is pointer-events:none, so locate the row from its rendered
   rectangles instead of relying on a text hit-test. This also handles the
   fractional line-height and soft-wrapped source rows exactly. */
function paintHoverLine(editorEl, mirrorEl, hovEl, clientY) {
  const cs = getComputedStyle(mirrorEl);
  const lh = parseFloat(cs.lineHeight);
  const editorTop = editorEl.getBoundingClientRect().top;
  const rows = mirrorEl.children;
  let lo = 0, hi = rows.length - 1, row = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const rect = rows[mid].getBoundingClientRect();
    if (clientY < rect.top) hi = mid - 1;
    else if (clientY >= rect.bottom) lo = mid + 1;
    else { row = rows[mid]; break; }
  }
  if (!row) { hovEl.style.display = 'none'; return; }

  /* Use the rendered row's rectangle rather than reconstructing it from
     scrollTop. This keeps the highlight on the same pixel grid as the text,
     including fractional line heights and folded trailing space. */
  const rowRect = row.getBoundingClientRect();
  const wrapped = Math.floor((clientY - rowRect.top) / lh);
  hovEl.style.display = 'block';
  hovEl.style.height = `${lh}px`;
  hovEl.style.top = `${rowRect.top - editorTop + wrapped * lh}px`;
}

/* Scrolling does not produce mousemove events when the pointer is stationary.
   Re-run the same rendered-row hit test after each scroll so the hover bar
   follows the text instead of being left at the old viewport coordinate. */
function refreshHoverLine(editorEl, mirrorEl, hovEl) {
  const y = hoverY.get(editorEl);
  if (y === undefined) return;
  const rect = editorEl.getBoundingClientRect();
  if (y < rect.top || y >= rect.bottom) {
    hovEl.style.display = 'none';
    return;
  }
  paintHoverLine(editorEl, mirrorEl, hovEl, y);
}

/* ---- the bracket pair around the caret ---- */

function clearBrackets() {
  document.querySelectorAll('.p.hit').forEach(n => n.classList.remove('hit'));
}

/* Only the bracket offsets are wanted, so this walks characters rather than
   paying for a full tokenize on every keystroke. Comments and quoted runs are
   skipped exactly as the tokenizer skips them, which is what keeps the Nth
   bracket here the same bracket as the Nth `data-p` in the mirror. */
let parenScan = { text: null, parens: null };

function parenPositions(text) {
  if (parenScan.text === text) return parenScan.parens;

  const parens = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];

    if ((c === '-' && text[i + 1] === '-') || c === '#') {          // -- and # to EOL
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? n : nl;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {                          // block comment
      const close = text.indexOf('*/', i + 2);
      i = close < 0 ? n : close + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`' || c === '[') {          // strings and quoted ids
      const close = c === '[' ? ']' : c;
      const escaped = c !== '`' && c !== '[';                        // \ and doubling
      let j = i + 1;
      while (j < n) {
        if (escaped && text[j] === '\\') { j += 2; continue; }
        if (text[j] === close) {
          if (escaped && text[j + 1] === close) { j += 2; continue; }
          j++;
          break;
        }
        j++;
      }
      i = j;
      continue;
    }
    if (c === '(' || c === ')') parens.push({ ord: parens.length, at: i, open: c === '(' });
    i++;
  }

  parenScan = { text, parens };
  return parens;
}

/* The pair to light up: whichever bracket the caret is sitting on, or failing
   that the innermost pair the caret is inside. Brackets close from the inside
   out, so the first pair to close around the caret is the innermost one. */
function bracketPairAt(text, caret) {
  const open = [];
  let touching = null, around = null;

  for (const p of parenPositions(text)) {
    if (p.open) { open.push(p); continue; }
    const start = open.pop();
    if (!start) continue;                       // a stray ) closing nothing

    if (!touching
      && (start.at === caret || start.at === caret - 1 || p.at === caret || p.at === caret - 1)) {
      touching = [start.ord, p.ord];
    } else if (!around && start.at < caret && caret <= p.at) {
      around = [start.ord, p.ord];
    }
  }
  return touching || around;
}

function markBrackets() {
  clearBrackets();
  const ta = document.activeElement;
  if (ta !== fmt && ta !== src) return;

  /* Mid-edit on a large document the mirror is rebuilt as plain text, with no
     token spans to mark and stale `data-p` numbering on the rows the fast path
     did not touch. The idle repaint puts the highlighted mirror back. */
  const mirrorEl = ta === fmt ? fmtMirror : srcMirror;
  if ((ta === fmt ? fmtMirrorMode : sourceMirrorMode) !== 'highlighted') return;

  const pair = bracketPairAt(ta.value, ta.selectionStart);
  if (!pair) return;
  for (const ord of pair) {
    const el = mirrorEl.querySelector(`.p[data-p="${ord}"]`);
    if (el) el.classList.add('hit');
  }
}

/* ---- words ---- */

/* VS Code's default word separators. Chrome's own breaker reads
   "119410,119422" as a single number - comma and all, the way it would read
   "1,234" - which is both the wrong thing to double-click and the wrong thing
   to highlight, so word boundaries are decided here instead. */
const WORD_BREAK = '`~!@#$%^&*()-=+[{]}\\|;:\'",.<>/?';
const isWordChar = c => c > ' ' && !WORD_BREAK.includes(c);

/* The word `at` sits in, or null if that is a bracket or a run of spaces.
   Landing on the right half of a character puts the offset just past it, so
   the character before is tried as well. */
function wordRangeAt(text, at) {
  const seed = isWordChar(text[at]) ? at : isWordChar(text[at - 1]) ? at - 1 : -1;
  if (seed < 0) return null;   // a bracket or a run of spaces

  let start = seed, end = seed + 1;
  while (start > 0 && isWordChar(text[start - 1])) start--;
  while (end < text.length && isWordChar(text[end])) end++;
  return [start, end];
}

/* ---- other runs of the selected text ---- */

/* Two VS Code behaviours over one mechanism.

   "Selection highlight": select something and every other copy of it picks up
   a faint box. "Occurrence highlight": with nothing selected, the word the
   caret sits in and all of its copies pick up a fainter one - whole words
   only, and including the word under the caret, which has no selection over
   it to stand in for a box.

   The mirrors are the only place the text is really laid out, so the boxes are
   measured off the rendered rows and drawn into their own layer underneath the
   textarea - the live selection, which the textarea paints itself, still wins
   wherever the two overlap. */
const MATCH_MAX_LEN = 200;    // a paragraph-sized selection is not a word
const MATCH_MAX_BOXES = 600;  // a screenful is nowhere near this many

/* The occurrence highlight follows the caret, so left to itself it would box
   every word as you typed it - the caret is inside a word for most of the time
   you are writing one. Only putting the caret somewhere deliberately, by
   clicking, arms it; the next keystroke puts it away again. A selection is
   always deliberate, so the selection highlight ignores this. */
let wordHighlightArmed = false;

function selectionNeedle() {
  const ta = document.activeElement;
  if (ta !== src && ta !== fmt) return null;

  const value = ta.value;
  let from = ta.selectionStart, to = ta.selectionEnd, kind = 'match';
  if (from === to) {
    if (!wordHighlightArmed) return null;
    const word = wordRangeAt(value, from);
    if (!word) return null;   // caret in whitespace or on a bracket
    [from, to] = word;
    kind = 'word';
  }
  if (to - from > MATCH_MAX_LEN) return null;

  const text = value.slice(from, to);
  // a multi-line drag is a range rather than a word; VS Code skips those too
  if (!text.trim() || text.includes('\n')) return null;

  const upto = value.slice(0, from);
  return {
    ta,
    kind,
    text: text.toLowerCase(),
    line: (upto.match(/\n/g) || []).length,
    col: from - (upto.lastIndexOf('\n') + 1),
  };
}

function paintMatches() {
  const need = selectionNeedle();
  // measure both panes before either is written, so this costs one layout
  const srcHtml = matchBoxes(srcEditor, srcMirror, need, need !== null && need.ta === src);
  const fmtHtml = matchBoxes(fmtEditor, fmtMirror, need, need !== null && need.ta === fmt);
  const cls = need && need.kind === 'word' ? 'matchlayer words' : 'matchlayer';
  for (const [layer, html] of [[srcMatch, srcHtml], [fmtMatch, fmtHtml]]) {
    if (layer.className !== cls) layer.className = cls;
    if (layer.innerHTML !== html) layer.innerHTML = html;
  }
}

/* The first row whose bottom edge is past `y`. Row tops only ever increase, so
   a binary search finds the viewport without touching every row. */
function firstRowBelow(rows, y) {
  let lo = 0, hi = rows.length - 1, found = rows.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].getBoundingClientRect().bottom > y) { found = mid; hi = mid - 1; }
    else lo = mid + 1;
  }
  return found;
}

/* Only the rows on screen are measured. Highlighting a common word in a long
   document would otherwise cost a client rect per occurrence, and the layer is
   rebuilt on every scroll anyway. */
function matchBoxes(editorEl, mirrorEl, need, focused) {
  const rows = mirrorEl.children;
  if (!need || !rows.length) return '';

  const editorRect = editorEl.getBoundingClientRect();
  const lh = parseFloat(getComputedStyle(mirrorEl).lineHeight);
  const first = firstRowBelow(rows, editorRect.top);
  const len = need.text.length;
  const whole = need.kind === 'word';
  let html = '', boxes = 0;

  for (let i = first; i < rows.length && boxes < MATCH_MAX_BOXES; i++) {
    const row = rows[i];
    const rowTop = row.getBoundingClientRect().top;
    if (rowTop >= editorRect.bottom) break;

    const hay = row.textContent.toLowerCase();
    for (let at = hay.indexOf(need.text); at >= 0; at = hay.indexOf(need.text, at + len)) {
      /* A caret in `119410` should not light up the tail of `2119410`, but a
         selection is taken at its word, exactly as the user drew it. */
      if (whole && (isWordChar(hay[at - 1]) || isWordChar(hay[at + len]))) continue;
      // the selected copy is already blue; the caret's own copy still wants a box
      if (!whole && focused && i === need.line && at === need.col) continue;
      html += matchBoxesFor(rangeSpan(row, at, at + len), editorRect, rowTop, lh);
      if (++boxes >= MATCH_MAX_BOXES) break;
    }
  }
  return html;
}

/* A range crossing two token spans reports a rect per span, and a soft-wrapped
   match reports one per visual row. Merge by row so a match reads as a single
   box, and snap each box to the row grid - the raw rects describe the glyph
   box, which sits a couple of pixels inside the line box. */
function matchBoxesFor(range, editorRect, rowTop, lh) {
  const wraps = new Map();
  for (const r of range.getClientRects()) {
    if (!r.width || !r.height) continue;
    const wrapped = Math.round((r.top - rowTop) / lh);
    const box = wraps.get(wrapped);
    if (!box) wraps.set(wrapped, { left: r.left, right: r.right });
    else {
      box.left = Math.min(box.left, r.left);
      box.right = Math.max(box.right, r.right);
    }
  }

  let html = '';
  for (const [wrapped, box] of wraps) {
    const top = rowTop + wrapped * lh - editorRect.top;
    html += `<i style="left:${box.left - editorRect.left}px;top:${top}px`
      + `;width:${box.right - box.left}px;height:${lh}px"></i>`;
  }
  return html;
}

/* Like rangeAt, but over a span of the row rather than a single caret point. */
function rangeSpan(row, from, to) {
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  range.selectNodeContents(row);
  let node, acc = 0, open = false;
  while ((node = walker.nextNode())) {
    const len = node.nodeValue.length;
    if (!open && acc + len > from) { range.setStart(node, from - acc); open = true; }
    if (open && acc + len >= to) { range.setEnd(node, to - acc); break; }
    acc += len;
  }
  return range;
}


function textEdit(before, after) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;

  let beforeEnd = before.length, afterEnd = after.length;
  while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd--;
    afterEnd--;
  }

  return {
    start,
    end: beforeEnd,
    inserted: after.slice(start, afterEnd),
  };
}

function mapOffsetThroughEdit(offset, start, end, insertedLength) {
  if (offset < start) return offset;
  if (offset >= end) return offset + insertedLength - (end - start);
  return start + insertedLength;
}

function foldDescriptors(layout, fullText, selected = null, anchorIndex = null) {
  const anchors = anchorIndex || buildAnchorIndex(fullText);
  const lines = layout.lines.map(lineText);
  const starts = [];
  let at = 0;
  for (const text of lines) {
    starts.push(at);
    at += text.length + 1;
  }

  const found = [];
  for (const [line, end] of layout.folds) {
    if (selected && !selected.has(line)) continue;

    let offset = (starts[line] || 0) + (layout.lines[line].indent || 0) * 2;
    let prev = null;
    let openAt = -1;
    let pairId;
    for (const tk of layout.lines[line].toks) {
      if (prev && needSpace(prev, tk)) offset++;
      if (tk.t === 'paren' && tk.v === '(') {
        openAt = offset;
        pairId = tk.pairId;
        break;
      }
      offset += tk.v.length;
      prev = tk;
    }

    if (openAt >= 0) {
      const closeLine = lineText(layout.lines[end], false);
      const closeOffset = closeLine.indexOf(')');
      const closeStart = starts[end] + lines[end].length - closeLine.length;
      const closeAt = closeOffset >= 0 ? closeStart + closeOffset : -1;
      found.push({
        line,
        end,
        openAt,
        closeAt,
        closeEnd: closeAt >= 0 ? closeAt + 1 : -1,
        pairId,
        anchor: anchorFromIndex(anchors, openAt),
      });
    }
  }
  return found;
}

function restoreFolded(previous, layout, fullText) {
  const anchorIndex = buildAnchorIndex(fullText);
  const candidates = foldDescriptors(layout, fullText, null, anchorIndex);
  const used = new Set();
  folded.clear();

  for (const old of previous) {
    const anchor = old.anchor ?? anchorFromIndex(anchorIndex, old.openAt);
    let match = candidates.find(candidate => !used.has(candidate.line) && candidate.anchor === anchor);
    if (!match && old.pairId !== undefined) {
      match = candidates.find(candidate => !used.has(candidate.line) && candidate.pairId === old.pairId);
    }
    if (!match) continue;
    folded.add(match.line);
    used.add(match.line);
  }
}

function textLineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

function displayRowAt(text, at) {
  return displayRowAtStarts(textLineStarts(text), at);
}

function displayRowAtStarts(starts, at) {
  let lo = 0, hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= at) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(0, lo - 1);
}

function mapRowsAfterEdit(map, change, nextShown) {
  const displayDelta = change.inserted.length - (change.end - change.start);
  const insertedEnd = change.start + change.inserted.length;
  const starts = textLineStarts(nextShown);
  const oldStarts = textLineStarts(map.shown);
  const oldRows = map.rows || [];

  return starts.map(start => {
    let oldAt;
    if (start <= change.start) oldAt = start;
    else if (start <= insertedEnd) oldAt = change.start;
    else oldAt = start - displayDelta;
    const oldRow = displayRowAtStarts(oldStarts, Math.max(0, Math.min(oldAt, map.shown.length)));
    return oldRows[oldRow] ?? oldRows[oldRows.length - 1] ?? 0;
  });
}

function updateFoldAnchors(map) {
  if (!map.anchorIndex || map.anchorIndex.length !== map.fullText.length + 1) {
    map.anchorIndex = buildAnchorIndex(map.fullText);
  }
  foldAnchors = [];
  for (let i = 0; i <= map.shown.length; i++) {
    const fullAt = map.boundaries[Math.min(i, map.boundaries.length - 1)] ?? map.fullText.length;
    foldAnchors.push(anchorFromIndex(map.anchorIndex, fullAt));
  }
}

function updateSelectionMap(map, change, fullStart, fullEnd, nextShown, nextFull) {
  const displayDelta = change.inserted.length - (change.end - change.start);
  const fullDelta = change.inserted.length - (fullEnd - fullStart);
  const insertedEnd = change.start + change.inserted.length;
  const boundaryAt = at => map.boundaries[Math.max(0, Math.min(at, map.boundaries.length - 1))] ?? map.fullText.length;
  const boundaries = [];

  for (let at = 0; at <= nextShown.length; at++) {
    if (at <= change.start) boundaries[at] = boundaryAt(at);
    else if (at <= insertedEnd) boundaries[at] = fullStart + at - change.start;
    else boundaries[at] = boundaryAt(at - displayDelta) + fullDelta;
  }

  const markers = (map.markers || []).map(marker => {
    if (marker.end <= change.start) return { ...marker };
    if (marker.start >= change.end) {
      return {
        ...marker,
        start: marker.start + displayDelta,
        end: marker.end + displayDelta,
        fullStart: marker.fullStart + fullDelta,
        fullEnd: marker.fullEnd + fullDelta,
      };
    }
    return { ...marker };
  });

  const anchorIndex = buildAnchorIndex(nextFull);
  const folds = (map.folds || []).map(fold => {
    const openAt = mapOffsetThroughEdit(fold.openAt, fullStart, fullEnd, change.inserted.length);
    const closeAt = fold.closeAt === undefined || fold.closeAt < 0
      ? fold.closeAt
      : mapOffsetThroughEdit(fold.closeAt, fullStart, fullEnd, change.inserted.length);
    return {
      ...fold,
      openAt,
      closeAt,
      closeEnd: closeAt >= 0 ? closeAt + 1 : fold.closeEnd,
      anchor: anchorFromIndex(anchorIndex, openAt),
    };
  });

  const nextMap = {
    fullText: nextFull,
    shown: nextShown,
    boundaries,
    markers,
    folds,
    anchorIndex,
    rows: mapRowsAfterEdit(map, change, nextShown),
  };
  updateFoldAnchors(nextMap);
  return nextMap;
}

function displayIndexForFullOffset(map, fullAt) {
  let lo = 0, hi = map.boundaries.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (map.boundaries[mid] < fullAt) lo = mid + 1;
    else hi = mid;
  }
  return map.boundaries[lo] === fullAt ? lo : -1;
}

function wrapTextRange(root, start, end, setup) {
  if (end <= start) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node, offset = 0, startNode, startOffset, endNode, endOffset;
  while ((node = walker.nextNode())) {
    const next = offset + node.nodeValue.length;
    if (!startNode && start >= offset && start <= next) {
      startNode = node;
      startOffset = start - offset;
    }
    if (end >= offset && end <= next) {
      endNode = node;
      endOffset = end - offset;
      break;
    }
    offset = next;
  }
  if (!startNode || !endNode) return;

  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  const span = document.createElement('span');
  setup(span);
  span.append(range.extractContents());
  range.insertNode(span);
}

function paintFmtRawFolded(reuseGutter = false) {
  const d = activeDiag();
  const view = diagnosticView(d, fmt.value, src.value);
  updateFoldAnchors(fmtSelectionMap);
  fmtMirror.innerHTML = highlightRows(fmt.value, { n: 0 }, view);

  const starts = textLineStarts(fmt.value);
  const markerRows = new Map();
  for (const marker of fmtSelectionMap.markers || []) {
    const row = displayRowAtStarts(starts, marker.start);
    const rowStart = starts[row] ?? 0;
    if (row >= fmtMirror.children.length || fmt.value.slice(marker.start, marker.end) !== MARK) continue;
    markerRows.set(row, marker);
    wrapTextRange(fmtMirror.children[row], marker.start - rowStart, marker.end - rowStart, span => {
      span.className = 'ell';
      span.dataset.fold = marker.line;
      span.title = 'Expand';
    });
  }

  const foldRows = new Map(markerRows);
  for (const fold of fmtSelectionMap.folds || []) {
    if (folded.has(fold.line)) continue;
    const at = displayIndexForFullOffset(fmtSelectionMap, fold.openAt);
    if (at < 0) continue;   // the fold is inside another collapsed chain
    const row = displayRowAtStarts(starts, at);
    if (!foldRows.has(row)) foldRows.set(row, fold);
  }

  rowLine = (fmtSelectionMap.rows || []).slice(0, fmtMirror.children.length);
  while (rowLine.length < fmtMirror.children.length) rowLine.push(rowLine[rowLine.length - 1] ?? 0);
  for (const [row, marker] of markerRows) rowLine[row] = marker.line;

  const primaryLines = diagnosticLines(fmt.value, view && view.primary);
  const marks = [];
  for (let i = 0; i < fmtMirror.children.length; i++) {
    const fold = foldRows.get(i);
    const line = rowLine[i] ?? i;
    const arrow = fold
      ? `<s class="fold${folded.has(fold.line) ? ' shut' : ''}" data-fold="${fold.line}" title="${folded.has(fold.line) ? 'Expand' : 'Collapse'}">${folded.has(fold.line) ? '&#x25B8;' : '&#x25BE;'}</s>`
      : '<s class="fs"></s>';
    marks.push(diagnosticGutterMark(primaryLines.has(i), d) + `<b>${line + 1}</b>` + arrow);
  }

  fmtSelectionMap.rows = rowLine.slice();
  const canReuseGutter = reuseGutter && rawGutterMode === 'raw-folded'
    && fmtGutIn.children.length === fmtMirror.children.length;
  if (!canReuseGutter) paintGutter(fmtMirror, fmtGutIn, fmtEditor, marks, true);
  rawGutterMode = 'raw-folded';
  fmtMirrorMode = 'highlighted';
  lastFmtValue = fmt.value;
  syncScroll(fmt, fmtMirror, fmtGutIn);
  paintDiagnosticIndicator(fmtMirror, fmtEditor, fmtDiagLine, fmtDiagLabel, fmt.value, view, d);
  updateFoldAllButton();
}

/* Deleting a marker changes which rows own fold arrows, but the fast edit path
   deliberately leaves the highlighted mirror DOM in place. Rebuild only the
   gutter here so the deleted block's arrow disappears without paying for a
   second full syntax-highlight pass. */
function repaintRawFoldedGutter() {
  const starts = textLineStarts(fmt.value);
  const markerRows = new Map();
  for (const marker of fmtSelectionMap.markers || []) {
    const row = displayRowAtStarts(starts, marker.start);
    if (row < fmtMirror.children.length && fmt.value.slice(marker.start, marker.end) === MARK) {
      markerRows.set(row, marker);
    }
  }

  const foldRows = new Map(markerRows);
  for (const fold of fmtSelectionMap.folds || []) {
    if (folded.has(fold.line)) continue;
    const at = displayIndexForFullOffset(fmtSelectionMap, fold.openAt);
    if (at < 0) continue;
    const row = displayRowAtStarts(starts, at);
    if (!foldRows.has(row)) foldRows.set(row, fold);
  }

  rowLine = (fmtSelectionMap.rows || []).slice(0, fmtMirror.children.length);
  while (rowLine.length < fmtMirror.children.length) rowLine.push(rowLine[rowLine.length - 1] ?? 0);
  for (const [row, marker] of markerRows) rowLine[row] = marker.line;

  const d = activeDiag();
  const view = diagnosticView(d, fmt.value, src.value);
  const primaryLines = diagnosticLines(fmt.value, view && view.primary);
  const marks = [];
  for (let i = 0; i < fmtMirror.children.length; i++) {
    const fold = foldRows.get(i);
    const line = rowLine[i] ?? i;
    const arrow = fold
      ? `<s class="fold${folded.has(fold.line) ? ' shut' : ''}" data-fold="${fold.line}" title="${folded.has(fold.line) ? 'Expand' : 'Collapse'}">${folded.has(fold.line) ? '&#x25B8;' : '&#x25BE;'}</s>`
      : '<s class="fs"></s>';
    marks.push(diagnosticGutterMark(primaryLines.has(i), d) + `<b>${line + 1}</b>` + arrow);
  }
  fmtSelectionMap.rows = rowLine.slice();
  paintGutter(fmtMirror, fmtGutIn, fmtEditor, marks, true);
  updateFoldAllButton();
}

/* ---- the two directions ---- */

/* source edited: the formatted pane is regenerated from it */
function fromSrc() {
  const sql = src.value;
  schedulePersist(sql);
  clearDiagnostics();
  clearFmtScrollPadding();
  fmtDirty = false;
  folded.clear();

  paintSrc();
  doc = formatSql(sql);
  fmt.value = formattedText(doc.lines);
  paintFmt();
  syncCarets(true);
  scheduleValidate(sql);
  finishHistoryAction('src');
}

/* formatted pane edited: it stays exactly as typed and the source mirrors it.
   Re-indenting on every keystroke would swallow the space you just typed, so
   the tidy-up happens when the pane loses focus. */
function fromFmt() {
  clearFmtScrollPadding();
  if (folded.size) {
    const oldMap = fmtSelectionMap;
    const oldShown = oldMap.shown;
    const nextShown = fmt.value;
    const change = textEdit(oldShown, nextShown);
    if (change.start === change.end && !change.inserted.length) {
      finishHistoryAction('fmt');
      return;
    }

    const selected = selectionAsFull(oldMap, change.start, change.end, fmt.selectionDirection || 'none');
    if (selected.hits.length) {
      fmt.value = oldShown;
      fmt.setSelectionRange(change.start, change.start);
      scheduleFoldedRender();
      finishHistoryAction('fmt');
      return;
    }
    const nextFull = oldMap.fullText.slice(0, selected.start) + change.inserted + oldMap.fullText.slice(selected.end);
    const fullStart = selected.start;
    const fullEnd = selected.end;
    const nextMap = updateSelectionMap(oldMap, change, fullStart, fullEnd, nextShown, nextFull);

    const sql = oneLine(nextFull);
    src.value = sql;
    schedulePersist(sql);
    clearDiagnostics();
    fmtDirty = true;
    fmtSelectionMap = nextMap;

    const canPatch = canPatchRawEdit(oldShown, change, nextShown);
    const useFast = canPatch && (shouldUseFastEdit(nextShown) || shouldUseFastEdit(sql));
    if (useFast) {
      cancelFoldedRender();
      if (paintFmtRawFoldedFast(change)) {
        scheduleFastEditFrame();
        scheduleIdleEditPaint();
      } else {
        scheduleFoldedRender();
      }
    } else {
      scheduleFoldedRender();
    }
    scheduleValidate(sql);
    finishHistoryAction('fmt');
    return;
  }

  /* Keep the full fold map while the visible text is being edited. The old
     plain path discarded it, which made every arrow disappear until blur. */
  const wasDirty = fmtDirty;
  const oldMap = fmtSelectionMap;
  const previousFmt = oldMap.shown;
  const change = textEdit(previousFmt, fmt.value);
  if (change.start === change.end && !change.inserted.length) {
    finishHistoryAction('fmt');
    return;
  }

  const selected = selectionAsFull(oldMap, change.start, change.end, fmt.selectionDirection || 'none');
  if (selected.hits.length) {
    fmt.value = previousFmt;
    fmt.setSelectionRange(change.start, change.start);
    if (hasFoldLayout(oldMap)) paintFmtRawFolded(); else paintFmtRaw();
    finishHistoryAction('fmt');
    return;
  }

  const nextFull = oldMap.fullText.slice(0, selected.start)
    + change.inserted
    + oldMap.fullText.slice(selected.end);
  const nextMap = updateSelectionMap(
    oldMap, change, selected.start, selected.end, fmt.value, nextFull,
  );
  const sql = oneLine(nextFull);
  src.value = sql;
  schedulePersist(sql);
  clearDiagnostics();
  fmtDirty = true;
  folded.clear();
  fmtSelectionMap = nextMap;

  const hasFolds = hasFoldLayout(nextMap);
  const rawMode = hasFolds ? 'raw-folded' : 'raw';
  const paintRaw = hasFolds ? paintFmtRawFolded : paintFmtRaw;
  const paintRawFast = hasFolds ? paintFmtRawFoldedFast : paintFmtRawFast;

  const canPatch = wasDirty && rawGutterMode === rawMode
    && canPatchRawEdit(previousFmt, change, fmt.value);
  const useFast = canPatch && (shouldUseFastEdit(fmt.value) || shouldUseFastEdit(sql));
  const sourceNeedsPaint = paintedSourceValue !== src.value || sourceMirrorMode !== 'highlighted';
  if (useFast && paintRawFast(change)) {
    if (hasFolds) repaintRawFoldedGutter();
    if (sourceNeedsPaint) scheduleFastEditFrame();
    else syncCarets(true);
    scheduleIdleEditPaint();
  } else {
    if (sourceNeedsPaint) {
      if (shouldUseFastEdit(src.value)) paintSrcFast(); else paintSrc();
    }
    const reuseGutter = rawGutterMode === rawMode
    && fmt.value.split('\n').length === fmtMirror.children.length;
    paintRaw(reuseGutter);
    syncCarets(true);
    if (sourceMirrorMode !== 'highlighted') scheduleIdleEditPaint();
  }
  scheduleValidate(sql);
  finishHistoryAction('fmt');
}

function settleFmt() {
  if (!fmtDirty) return;
  clearTimeout(editPaintTimer);
  editPaintTimer = 0;
  const anchor = folded.size ? fmtAnchor() : anchorOf(fmt.value, fmt.selectionStart);
  if (folded.size) {
    const previousFolds = (fmtSelectionMap.folds || []).filter(fold => folded.has(fold.line));
    fmtDirty = false;
    doc = formatSql(src.value);
    restoreFolded(previousFolds, doc, formattedText(doc.lines));
    if (paintedSourceValue !== src.value || sourceMirrorMode !== 'highlighted') paintSrc();
    paintFmt();
    const at = fmtIndexOf(anchor);
    fmt.setSelectionRange(at, at);
    replaceHistoryState();
    return;
  }
  fmtDirty = false;
  doc = formatSql(src.value);
  fmt.value = formattedText(doc.lines);
  const at = indexOfAnchor(fmt.value, anchor);
  paintFmt();
  fmt.setSelectionRange(at, at);
  replaceHistoryState();
}

function schedule(fn) {
  if (frame) cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => {
    frame = 0;
    pendingInputTarget = '';
    fn();
  });
}

function scheduleSelectionSync() {
  if (selectionSyncFrame) return;
  selectionSyncFrame = requestAnimationFrame(() => {
    selectionSyncFrame = 0;
    syncCarets(true);
  });
}

/* Keep the mapping current for every input, but paint the two mirrors and
   caret once per animation frame. This keeps rapid typing on a folded pane
   from synchronously rebuilding the DOM for every individual key. */
function cancelFoldedRender() {
  if (!foldedRenderFrame) return;
  cancelAnimationFrame(foldedRenderFrame);
  foldedRenderFrame = 0;
}

function scheduleFastEditFrame() {
  if (fastEditFrame) return;
  fastEditFrame = requestAnimationFrame(() => {
    fastEditFrame = 0;
    if (!fmtDirty) return;
    if (paintedSourceValue !== src.value) {
      if (shouldUseFastEdit(src.value)) paintSrcFast(); else paintSrc();
    }
    syncCarets(true);
  });
}

function scheduleIdleEditPaint() {
  clearTimeout(editPaintTimer);
  editPaintTimer = setTimeout(() => {
    editPaintTimer = 0;
    if (!fmtDirty) return;

    if (sourceMirrorMode !== 'highlighted' || paintedSourceValue !== src.value) paintSrc();
    if (folded.size || hasFoldLayout()) {
      if (fmtMirrorMode !== 'highlighted') paintFmtRawFolded();
    } else if (fmtMirrorMode !== 'highlighted') {
      paintFmtRaw();
    }
    syncCarets(false);
  }, 120);
}

function scheduleFoldedRender() {
  if (foldedRenderFrame) return;
  foldedRenderFrame = requestAnimationFrame(() => {
    foldedRenderFrame = 0;
    if (!fmtDirty || !folded.size) return;

    if (paintedSourceValue !== src.value) paintSrc();
    const reuseGutter = rawGutterMode === 'raw-folded'
      && fmt.value.split('\n').length === fmtMirror.children.length;
    paintFmtRawFolded(reuseGutter);
    syncCarets(true);
  });
}

function historySelection(ta) {
  return {
    start: ta.selectionStart,
    end: ta.selectionEnd,
    direction: ta.selectionDirection || 'none',
  };
}

function captureHistoryState() {
  const active = document.activeElement === src ? 'src'
    : document.activeElement === fmt ? 'fmt' : '';
  return {
    source: src.value,
    formatted: fmt.value,
    dirty: fmtDirty,
    folded: [...folded],
    doc,
    map: fmtSelectionMap,
    active,
    srcSelection: historySelection(src),
    fmtSelection: historySelection(fmt),
    srcScrollTop: src.scrollTop,
    srcScrollLeft: src.scrollLeft,
    fmtScrollTop: fmt.scrollTop,
    fmtScrollLeft: fmt.scrollLeft,
  };
}

function sameFoldedState(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sameHistoryContent(a, b) {
  return a.source === b.source
    && a.formatted === b.formatted
    && a.dirty === b.dirty
    && sameFoldedState(a.folded, b.folded);
}

function sameHistoryCursor(a, b) {
  const same = (x, y) => x.start === y.start && x.end === y.end && x.direction === y.direction;
  return a.active === b.active && same(a.srcSelection, b.srcSelection) && same(a.fmtSelection, b.fmtSelection);
}

function beginHistoryAction(target = '') {
  if (historyApplying) return;
  if (!historyCurrent) historyCurrent = captureHistoryState();
  if (!historyBefore) {
    historyBefore = captureHistoryState();
    historyTarget = target;
  } else if (!historyTarget) {
    historyTarget = target;
  }
}

function finishHistoryAction(target = '') {
  if (historyApplying) return;
  const after = captureHistoryState();
  const before = historyBefore || historyCurrent;
  const actionTarget = historyTarget || target;
  historyBefore = null;
  historyTarget = '';

  if (!before) {
    historyCurrent = after;
    return;
  }
  if (sameHistoryContent(before, after)) {
    historyCurrent = after;
    return;
  }

  const now = performance.now();
  const last = undoStack[undoStack.length - 1];
  const canMerge = last
    && actionTarget
    && last.target === actionTarget
    && now - last.time <= HISTORY_MERGE_MS
    && sameHistoryCursor(before, last.after);

  if (canMerge) {
    last.after = after;
    last.time = now;
  } else {
    undoStack.push({ before, after, target: actionTarget, time: now });
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  }
  redoStack = [];
  historyCurrent = after;
}

/* A blur may only replace the raw formatted text with its tidy layout. Keep
   that cleanup attached to the edit that caused it, so Ctrl+Z does not need a
   second press just to undo whitespace normalization. */
function replaceHistoryState() {
  if (historyApplying) return;
  const after = captureHistoryState();
  if (undoStack.length) undoStack[undoStack.length - 1].after = after;
  historyCurrent = after;
  historyBefore = null;
  historyTarget = '';
}

function syncHistoryView() {
  if (historyApplying || historyBefore) return;
  historyCurrent = captureHistoryState();
}

function flushPendingEdit() {
  const target = pendingInputTarget;
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  pendingInputTarget = '';
  if (target === 'src') fromSrc();
  else if (target === 'fmt') fromFmt();
}

function scheduleHistoryCleanPaint() {
  clearTimeout(editPaintTimer);
  editPaintTimer = setTimeout(() => {
    editPaintTimer = 0;
    if (historyApplying || fmtDirty) return;
    if (sourceMirrorMode !== 'highlighted' || paintedSourceValue !== src.value) paintSrc();
    if (fmtMirrorMode !== 'highlighted' || rawGutterMode !== 'formatted') paintFmt();
    syncCarets(false);
  }, 120);
}

function restoreHistoryState(state) {
  const current = captureHistoryState();
  historyApplying = true;
  try {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    pendingInputTarget = '';
    cancelFoldedRender();
    if (fastEditFrame) cancelAnimationFrame(fastEditFrame);
    fastEditFrame = 0;
    clearTimeout(editPaintTimer);
    editPaintTimer = 0;
    clearTimeout(timer);
    timer = 0;
    validationVersion++;
    clearDiagnostics();

    src.value = state.source;
    fmt.value = state.formatted;
    fmtDirty = state.dirty;
    doc = state.doc || formatSql(state.source);
    folded.clear();
    for (const line of state.folded) folded.add(line);
    fmtSelectionMap = state.map || { fullText: '', shown: '', boundaries: [0], markers: [] };

    const change = textEdit(current.formatted, state.formatted);
    const sameFolds = sameFoldedState(current.folded, state.folded);
    const stateHasFoldLayout = state.folded.length > 0 || hasFoldLayout(state.map);
    const canFastRaw = current.dirty
      && sameFolds
      && (shouldUseFastEdit(state.formatted) || shouldUseFastEdit(state.source))
      && canPatchRawEdit(current.formatted, change, state.formatted);

    if (!state.dirty) {
      let paintedFast = false;
      if (canFastRaw && stateHasFoldLayout && rawGutterMode === 'raw-folded') {
        paintedFast = paintFmtRawFoldedFast(change);
        if (paintedFast) repaintRawFoldedGutter();
      } else if (canFastRaw && !stateHasFoldLayout && rawGutterMode === 'raw') {
        paintedFast = paintFmtRawFast(change);
      }
      if (shouldUseFastEdit(state.source)) paintSrcFast(); else paintSrc();
      if (!paintedFast) paintFmt();
      if (paintedFast || sourceMirrorMode !== 'highlighted') scheduleHistoryCleanPaint();
    } else {
      if (shouldUseFastEdit(state.source)) paintSrcFast(); else paintSrc();
      let paintedFast = false;
      if (canFastRaw && stateHasFoldLayout && rawGutterMode === 'raw-folded') {
        paintedFast = paintFmtRawFoldedFast(change);
        if (paintedFast) repaintRawFoldedGutter();
      } else if (canFastRaw && !stateHasFoldLayout && rawGutterMode === 'raw') {
        paintedFast = paintFmtRawFast(change);
      }
      if (!paintedFast) {
        if (stateHasFoldLayout) paintFmtRawFolded(); else paintFmtRaw();
      }
      if (sourceMirrorMode !== 'highlighted'
        || fmtMirrorMode !== 'highlighted'
        || shouldUseFastEdit(state.source)) scheduleIdleEditPaint();
    }

    if (state.dirty && stateHasFoldLayout) updateFoldAnchors(fmtSelectionMap);

    if (state.active === 'src') src.focus();
    else if (state.active === 'fmt') fmt.focus();
    const restoreSelection = (ta, selection) => {
      const length = ta.value.length;
      const start = Math.max(0, Math.min(length, selection.start));
      const end = Math.max(start, Math.min(length, selection.end));
      ta.setSelectionRange(start, end, selection.direction || 'none');
    };
    restoreSelection(src, state.srcSelection);
    restoreSelection(fmt, state.fmtSelection);
    src.scrollTop = state.srcScrollTop;
    src.scrollLeft = state.srcScrollLeft;
    fmt.scrollTop = state.fmtScrollTop;
    fmt.scrollLeft = state.fmtScrollLeft;
    syncCarets(false);
    syncScroll(src, srcMirror, srcGutIn);
    syncScroll(fmt, fmtMirror, fmtGutIn);
    schedulePersist(state.source);
    scheduleValidate(state.source);
    historyCurrent = state;
    historyBefore = null;
    historyTarget = '';
  } finally {
    historyApplying = false;
  }
}

function undoEditor() {
  flushPendingEdit();
  if (!undoStack.length) return false;
  const entry = undoStack.pop();
  redoStack.push(entry);
  restoreHistoryState(entry.before);
  return true;
}

function redoEditor() {
  flushPendingEdit();
  if (!redoStack.length) return false;
  const entry = redoStack.pop();
  undoStack.push(entry);
  restoreHistoryState(entry.after);
  return true;
}

function consumeHistoryInput(e) {
  if (e.inputType === 'historyUndo' && undoEditor()) {
    e.preventDefault();
    return true;
  }
  if (e.inputType === 'historyRedo' && redoEditor()) {
    e.preventDefault();
    return true;
  }
  return false;
}

/* The optimiser receives a snapshot. Its overlay can experiment visually, but
   the viewer itself is never changed by opening or viewing it. */
function openOptimizer() {
  window.dispatchEvent(new CustomEvent('sqlviewer-open-optimizer', {
    detail: { sql: src.value }
  }));
}

function inputTouchesFoldMarker(inputType) {
  if (!folded.size) return false;
  let start = fmt.selectionStart;
  let end = fmt.selectionEnd;
  if (start === end && inputType === 'deleteContentBackward') start = Math.max(0, start - 1);
  else if (start === end && inputType === 'deleteContentForward') end++;

  if (start !== end) return (fmtSelectionMap.markers || []).some(marker => start < marker.end && end > marker.start);
  return (fmtSelectionMap.markers || []).some(marker => start > marker.start && start < marker.end);
}

function foldDeleteTarget(inputType) {
  if (!folded.size) return null;
  const backward = inputType === 'deleteContentBackward' || inputType === 'deleteWordBackward';
  const forward = inputType === 'deleteContentForward' || inputType === 'deleteWordForward';
  if (!backward && !forward) return null;

  const start = fmt.selectionStart;
  const end = fmt.selectionEnd;
  const markers = fmtSelectionMap.markers || [];
  if (start !== end) return markers.find(marker => start < marker.end && end > marker.start) || null;
  return markers.find(marker => start >= marker.start && start <= marker.end) || null;
}

/* A collapsed marker represents a complete parenthesized range. Treat it as
   one editing unit so Backspace/Delete never exposes a half-deleted fold or
   strands the gutter with an arrow that no longer has a matching block. */
function deleteCollapsedFold(inputType) {
  const map = fmtSelectionMap;
  const target = foldDeleteTarget(inputType);
  if (!target) return false;

  const selectionStart = fmt.selectionStart;
  const selectionEnd = fmt.selectionEnd;
  const markerTargets = selectionStart === selectionEnd
    ? [target]
    : (map.markers || []).filter(marker => selectionStart < marker.end && selectionEnd > marker.start);
  if (!markerTargets.length) return false;

  let fullStart = Infinity;
  let fullEnd = -1;
  const targetLines = new Set();
  for (const marker of markerTargets) {
    const fold = (map.folds || []).find(item => item.line === marker.line);
    const closeEnd = fold && fold.closeEnd >= 0
      ? fold.closeEnd
      : fold && fold.closeAt >= 0
        ? fold.closeAt + 1
        : -1;
    if (!fold || fold.openAt < 0 || closeEnd < 0) return false;
    fullStart = Math.min(fullStart, fold.openAt);
    fullEnd = Math.max(fullEnd, closeEnd);
    targetLines.add(fold.line);
  }

  if (selectionStart !== selectionEnd) {
    const selected = selectionAsFull(map, selectionStart, selectionEnd, fmt.selectionDirection || 'none');
    fullStart = Math.min(fullStart, selected.start);
    fullEnd = Math.max(fullEnd, selected.end);
  }

  const displayStart = displayIndexForFullOffset(map, fullStart);
  const displayEnd = displayIndexForFullOffset(map, fullEnd);
  if (displayStart < 0 || displayEnd < displayStart) return false;

  clearFmtScrollPadding();
  beginHistoryAction('fmt-block');

  /* Remove nested folds that lived inside the deleted parenthesized range,
     including their markers if they were independently visible. */
  const removedLines = new Set(targetLines);
  for (const fold of map.folds || []) {
    const closeEnd = fold.closeEnd >= 0
      ? fold.closeEnd
      : fold.closeAt >= 0
        ? fold.closeAt + 1
        : -1;
    if ((fold.openAt >= fullStart && fold.openAt < fullEnd)
      || (closeEnd > fullStart && closeEnd <= fullEnd)) {
      removedLines.add(fold.line);
    }
  }

  const change = { start: displayStart, end: displayEnd, inserted: '' };
  const nextShown = map.shown.slice(0, displayStart) + map.shown.slice(displayEnd);
  const nextFull = map.fullText.slice(0, fullStart) + map.fullText.slice(fullEnd);
  const nextMap = updateSelectionMap(map, change, fullStart, fullEnd, nextShown, nextFull);
  nextMap.markers = nextMap.markers.filter(marker => !removedLines.has(marker.line));
  nextMap.folds = nextMap.folds.filter(fold => !removedLines.has(fold.line));

  for (const line of removedLines) folded.delete(line);
  fmt.value = nextShown;
  fmt.setSelectionRange(displayStart, displayStart);
  const sql = oneLine(nextFull);
  src.value = sql;
  schedulePersist(sql);
  clearDiagnostics();
  fmtDirty = true;
  fmtSelectionMap = nextMap;

  cancelFoldedRender();
  const sourceNeedsPaint = paintedSourceValue !== src.value || sourceMirrorMode !== 'highlighted';
  if (folded.size) {
    const canPatch = canPatchRawEdit(map.shown, change, nextShown);
    const useFast = canPatch && (shouldUseFastEdit(nextShown) || shouldUseFastEdit(sql));
    if (useFast && paintFmtRawFoldedFast(change)) {
      repaintRawFoldedGutter();
      scheduleFastEditFrame();
      scheduleIdleEditPaint();
    } else {
      repaintRawFoldedGutter();
      scheduleFoldedRender();
    }
  } else {
    if (sourceNeedsPaint) {
      if (shouldUseFastEdit(src.value)) paintSrcFast(); else paintSrc();
    }
    /* The last fold needs a gutter rebuild so its arrow is removed too. */
    paintFmtRaw(false);
    syncCarets(true);
  }
  scheduleValidate(sql);
  finishHistoryAction('fmt-block');
  return true;
}

/* ---- events ---- */

foldAllButton.addEventListener('click', toggleFoldAll);
optimiserButton.addEventListener('click', openOptimizer);
statusEl.addEventListener('click', () => {
  if (!diagnostics.length) return;
  showDiagnostic(diagnosticNavigated ? activeDiagnostic + 1 : activeDiagnostic);
});
src.addEventListener('beforeinput', e => {
  if (consumeHistoryInput(e)) return;
  beginHistoryAction('src');
});
src.addEventListener('input', () => {
  pendingInputTarget = 'src';
  schedule(fromSrc);
});
fmt.addEventListener('input', () => {
  pendingInputTarget = 'fmt';
  if (folded.size) {
    pendingInputTarget = '';
    fromFmt();
  } else schedule(fromFmt);
});
fmt.addEventListener('beforeinput', e => {
  if (consumeHistoryInput(e)) return;
  if (deleteCollapsedFold(e.inputType)) {
    e.preventDefault();
    return;
  }
  if (inputTouchesFoldMarker(e.inputType)) {
    e.preventDefault();
    return;
  }
  beginHistoryAction('fmt');
});
fmt.addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const inputType = e.key === 'Backspace'
    ? 'deleteContentBackward'
    : e.key === 'Delete'
      ? 'deleteContentForward'
      : null;
  if (!inputType || !deleteCollapsedFold(inputType)) return;
  e.preventDefault();
});
document.addEventListener('keydown', e => {
  if (e.altKey || (!e.ctrlKey && !e.metaKey)) return;
  const key = String(e.key || '').toLowerCase();
  let handled = false;
  if (key === 'z') handled = e.shiftKey ? redoEditor() : undoEditor();
  else if (key === 'y' && !e.shiftKey) handled = redoEditor();
  if (handled) e.preventDefault();
});
fmt.addEventListener('blur', settleFmt);

src.addEventListener('scroll', () => { syncScroll(src, srcMirror, srcGutIn); syncCarets(); });
fmt.addEventListener('scroll', () => {
  clampFmtScrollLimit();
  syncScroll(fmt, fmtMirror, fmtGutIn);
  syncCarets();
  scheduleDiagnosticIndicator();
});
fmtEditor.addEventListener('wheel', keepFmtWheelInsideBoundary, { passive: false, capture: true });

/* The textarea is the only scroll source. The mirror is pointer-events:none
   with a hidden scrollbar, so letting it write back a delayed scrollTop can
   undo a legitimate move (especially when returning down after scrolling up). */

for (const [ed, mirrorEl, hovEl] of [[srcEditor, srcMirror, srcHov], [fmtEditor, fmtMirror, fmtHov]]) {
  ed.addEventListener('mousemove', e => {
    hoverY.set(ed, e.clientY);
    paintHoverLine(ed, mirrorEl, hovEl, e.clientY);
  });
  ed.addEventListener('mouseleave', () => {
    hoverY.delete(ed);
    hovEl.style.display = 'none';
  });
}

document.addEventListener('selectionchange', scheduleSelectionSync);
for (const ta of [src, fmt]) {
  /* Regaining focus (including returning to this browser tab) should not
     replace the user's viewport with the caret's position. A real selection
     change still follows the normal navigation path below. */
  ta.addEventListener('focus', () => syncCarets(false));
  ta.addEventListener('blur', syncCarets);
}

window.addEventListener('resize', () => {
  paintSrc();
  if (fmtDirty) {
    if (folded.size || hasFoldLayout()) paintFmtRawFolded(); else paintFmtRaw();
  } else paintFmt();
  syncCarets();
});

/* Folding changes how many rows sit above you, so putting the old pixel offset
   back would slide the whole view. Anchor on the row you were looking at and
   keep its fractional pixel offset as well. */
function viewportAnchor() {
  const lh = parseFloat(getComputedStyle(fmtMirror).lineHeight);
  const row = Math.min(Math.floor(fmtMirror.scrollTop / lh), rowLine.length - 1);
  return {
    line: rowLine[Math.max(0, row)] || 0,
    offset: fmtMirror.scrollTop - Math.max(0, row) * lh,
  };
}

function topLine() {
  return viewportAnchor().line;
}

function scrollToLine(line, keepBottomSpace = false, offset = 0, lockBottom = false) {
  const lh = parseFloat(getComputedStyle(fmtMirror).lineHeight);
  let row = 0;    // rowLine ascends, so this lands on the last row at or before it
  while (row + 1 < rowLine.length && rowLine[row + 1] <= line) row++;
  const target = row * lh + (Number(offset) || 0);

  if (keepBottomSpace) {
    /* Account for any compensation from the previous fold before deciding how
       much trailing space this layout needs. */
    /* Read the content box directly instead of using scrollHeight: browsers
       clamp a short textarea's scrollHeight to clientHeight, hiding the
       underflow that the spacer needs to fill. */
    const last = fmtMirror.lastElementChild;
    const contentBottom = last ? last.offsetTop + last.offsetHeight : 0;
    const padBottom = parseFloat(getComputedStyle(fmtMirror).paddingBottom) || 0;
    /* A long formatted line can make the textarea reserve a horizontal
       scrollbar, while the mirror hides its scrollbar. Use the tighter of
       the two vertical ranges so neither layer clamps the preserved target
       after the fold is painted. */
    const fmtBaseMax = contentBottom + padBottom - fmtScrollPadding - fmt.clientHeight;
    const mirrorBaseMax = contentBottom + padBottom - fmtScrollPadding - fmtMirror.clientHeight;
    const baseMax = Math.min(fmtBaseMax, mirrorBaseMax);
    setFmtScrollPadding(Math.max(0, target - baseMax));
    fmtScrollLimit = lockBottom ? target : null;
  } else {
    clearFmtScrollPadding();
  }
  fmt.scrollTop = target;
  syncScroll(fmt, fmtMirror, fmtGutIn);
}

function toggleFoldAll() {
  flushPendingEdit();
  if (fmtDirty) settleFmt();

  const lines = [...(doc.folds || new Map()).keys()];
  if (!lines.length) return;

  const viewport = viewportAnchor();
  const wasAtBottom = fmtAtBottom();
  const anchor = fmtAnchor();
  const allCollapsed = lines.every(foldLine => folded.has(foldLine));

  folded.clear();
  if (!allCollapsed) for (const foldLine of lines) folded.add(foldLine);

  paintFmt();
  const at = fmtIndexOf(anchor);
  fmt.setSelectionRange(at, at);
  scrollToLine(viewport.line, !allCollapsed, viewport.offset, !allCollapsed && wasAtBottom);
  syncCarets();
  syncHistoryView();
}

/* Fold / unfold. Finish a raw folded edit before changing the layout so the
   click cannot discard a newline or other text the user just entered. */
fmtEditor.addEventListener('pointerdown', e => {
  const tag = e.target.closest('[data-fold]');
  if (!tag) return;                       // scrolling/caret placement keeps the spacer
  let at = Number(tag.dataset.fold);
  const target = (fmtSelectionMap.folds || []).find(fold => fold.line === at);
  const viewport = viewportAnchor();
  const wasAtBottom = fmtAtBottom();
  const anchor = fmtAnchor();
  if (fmtDirty) {
    settleFmt();
    if (target) {
      const current = foldDescriptors(doc, formattedText(doc.lines)).find(fold => fold.anchor === target.anchor);
      if (current) at = current.line;
    }
  }
  const wasFolded = folded.has(at);
  if (folded.has(at)) folded.delete(at); else folded.add(at);
  paintFmt();
  const to = fmtIndexOf(anchor);
  fmt.setSelectionRange(to, to);
  scrollToLine(viewport.line, !wasFolded, viewport.offset, !wasFolded && wasAtBottom);
  syncCarets();
  syncHistoryView();
});

/* Continue the current indentation when a new line is created. An opening
   parenthesis on the line adds one level; closing parentheses reduce it. */
function enterIndent(text, at) {
  const lineStart = text.lastIndexOf('\n', Math.max(0, at - 1)) + 1;
  const lineEndAt = text.indexOf('\n', at);
  const lineEnd = lineEndAt < 0 ? text.length : lineEndAt;
  const line = text.slice(lineStart, lineEnd);
  const leading = (line.match(/^[ \t]*/) || [''])[0];
  const before = text.slice(lineStart, at);
  const tokens = tokensFor(before).filter(t => t.t !== 'ws' && t.t !== 'comment');

  let parenDelta = 0;
  let lastParen = null;
  for (const tk of tokens) {
    if (tk.t !== 'paren') continue;
    parenDelta += tk.v === '(' ? 1 : -1;
    lastParen = tk.v;
  }

  let levels = parenDelta;
  if (parenDelta === 0 && lastParen === '(') levels = 1;

  if (levels > 0) return `${leading}${'  '.repeat(levels)}`;
  if (levels < 0) return leading.slice(0, Math.max(0, leading.length + levels * 2));
  return leading;
}

function insertIndentedEnter(ta) {
  if (ta === fmt && inputTouchesFoldMarker('insertLineBreak')) return;
  beginHistoryAction(ta === fmt ? 'fmt-enter' : 'src-enter');
  const at = ta.selectionStart;
  const indent = enterIndent(ta.value, at);
  ta.setRangeText(`\n${indent}`, ta.selectionStart, ta.selectionEnd, 'end');
  ta.dispatchEvent(new Event('input'));
}

/* Enter keeps the indentation from the line it splits, instead of starting
   every new line at column zero. */
for (const ta of [src, fmt]) {
  ta.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    insertIndentedEnter(ta);
  });
}

/* A click is the one caret move that asks for the word under it to be
   highlighted. Typing is not, and neither is the caret landing mid-word while
   an edit reflows the text around it. */
for (const ta of [src, fmt]) {
  ta.addEventListener('mousedown', () => { wordHighlightArmed = true; });
  ta.addEventListener('input', () => { wordHighlightArmed = false; });
}

/* ---- double click selects one word ---- */

/* Which character the pointer is over. The caret the browser leaves behind
   cannot answer that: it snaps to the nearer boundary, so clicking `)` and
   clicking the `5` in front of it both land on the offset between them. That
   is fine for words, which are wide, but not for picking out one bracket. The
   mirror lays the text out at the same pixels as the textarea, so the column
   can be read straight off it. Returns -1 if the point is past the text. */
function offsetAtPoint(mirrorEl, text, clientX, clientY) {
  const rows = mirrorEl.children;
  let lo = 0, hi = rows.length - 1, row = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = rows[mid].getBoundingClientRect();
    if (clientY < r.top) hi = mid - 1;
    else if (clientY >= r.bottom) lo = mid + 1;
    else { row = mid; break; }
  }
  const starts = textLineStarts(text);
  if (row < 0 || row >= starts.length) return -1;

  const rowEl = rows[row];
  const rowTop = rowEl.getBoundingClientRect().top;
  const lh = parseFloat(getComputedStyle(mirrorEl).lineHeight);
  const wrapped = Math.max(0, Math.floor((clientY - rowTop) / lh));
  const len = (row + 1 < starts.length ? starts[row + 1] - 1 : text.length) - starts[row];

  /* Character boundaries run left to right within a visual row and top to
     bottom between them, so they are ordered and can be searched. The last
     boundary at or before the pointer is where the character under it starts. */
  const atOrBefore = col => {
    const r = rangeAt(rowEl, col).getBoundingClientRect();
    const line = Math.round((r.top - rowTop) / lh);
    return line < wrapped || (line === wrapped && r.left <= clientX);
  };
  lo = 0; hi = len;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (atOrBefore(mid)) lo = mid; else hi = mid - 1;
  }
  return starts[row] + lo;
}

/* What a double click on that character should take. A word if it is part of
   one, and otherwise just itself: a separator is its own word, so clicking a
   bracket takes that bracket. Chrome instead reaches past it for whatever run
   of whitespace or punctuation surrounds it, which on a closing bracket at the
   end of a line means selecting the line break. Whitespace is left to the
   browser, which already selects the run of it and has nothing to get wrong. */
function doubleClickRange(text, at) {
  const c = text[at];
  if (c === undefined || c <= ' ') return null;
  return isWordChar(c) ? wordRangeAt(text, at) : [at, at + 1];
}

/* The browser widens the selection on the second mousedown. Correcting that on
   dblclick means correcting it on mouseup, so the wrong word stays on screen
   for as long as the button is held down; a frame callback instead runs in the
   rendering steps, before the browser paints, and the wider word is never
   actually shown.

   The default is deliberately left to run. Preventing it would take the wrong
   word off the screen too, but it also cancels double-click-drag - holding the
   button after the second click and pulling down to extend the selection - and
   that is the browser's to do, not ours. */
for (const ta of [src, fmt]) {
  ta.addEventListener('mousedown', e => {
    if (e.button !== 0 || e.detail !== 2) return;
    if (ta.selectionStart !== ta.selectionEnd) return;   // the pair began as a drag
    const mirrorEl = ta === fmt ? fmtMirror : srcMirror;
    const over = offsetAtPoint(mirrorEl, ta.value, e.clientX, e.clientY);
    const take = over >= 0
      ? doubleClickRange(ta.value, over)
      : wordRangeAt(ta.value, ta.selectionStart);   // clicked past the text
    if (!take) return;                    // on whitespace: let the browser decide

    /* Once the pointer starts moving the selection belongs to the drag, not to
       the browser's guess at a word, so leave it alone. A drag that creeps off
       slowly enough to be missed here corrects itself: the next mousemove
       overwrites whatever this put back. */
    const stop = new AbortController();
    let dragged = false;
    window.addEventListener('mousemove', m => {
      if (Math.abs(m.clientX - e.clientX) > 2 || Math.abs(m.clientY - e.clientY) > 2) dragged = true;
    }, { capture: true, signal: stop.signal });
    window.addEventListener('mouseup', () => stop.abort(), { capture: true, signal: stop.signal });

    requestAnimationFrame(() => {
      stop.abort();
      if (dragged) return;
      if (ta.selectionStart === take[0] && ta.selectionEnd === take[1]) return;
      ta.setSelectionRange(take[0], take[1]);
    });
  });
}

/* Tab inserts two spaces instead of leaving the field */
for (const ta of [src, fmt]) {
  ta.addEventListener('keydown', e => {
    if (e.key !== 'Tab' || e.shiftKey) return;
    e.preventDefault();
    if (ta === fmt && inputTouchesFoldMarker('insertText')) return;
    beginHistoryAction(ta === fmt ? 'fmt-tab' : 'src-tab');
    ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end');
    ta.dispatchEvent(new Event('input'));
  });
}

/* Keep a folded view during selection. The clipboard handler resolves any
   selected pill to the corresponding range of the expanded formatted text. */
fmt.addEventListener('copy', e => {
  if (!folded.size || fmt.selectionStart === fmt.selectionEnd) return;
  const selection = fmtSelectionAsFull();
  if (!selection.hits.length || !e.clipboardData) return;
  e.preventDefault();
  e.clipboardData.setData('text/plain', fmtSelectionMap.fullText.slice(selection.start, selection.end));
});

/* Keep a drag inside the pane it started in - the browser treats the whole
   document as one selection root. */
for (const [ta, other] of [[src, fmtEditor], [fmt, srcEditor]]) {
  ta.addEventListener('pointerdown', () => other.classList.add('no-select'));
}
window.addEventListener('pointerup', () => {
  srcEditor.classList.remove('no-select');
  fmtEditor.classList.remove('no-select');
});

const saved = localStorage.getItem(KEY);
src.value = saved === null ? '' : saved;
fromSrc();
historyCurrent = captureHistoryState();
window.addEventListener('pagehide', () => {
  clearTimeout(saveTimer);
  saveTimer = 0;
  localStorage.setItem(KEY, src.value);
});

/* the parser arrives async from the CDN; re-check once it lands */
window.addEventListener('load', () => {
  const r = validate(src.value);
  applyValidation(r);
});
