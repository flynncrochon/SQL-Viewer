/* SQL Viewer - conservative, readability-first boolean predicate optimiser. */

(() => {
  'use strict';

  const CLAUSE_STOP = new Set([
    'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'INTERSECT', 'EXCEPT',
    'RETURNING', 'WINDOW', 'QUALIFY', 'FETCH', 'FOR', 'OPTION'
  ]);
  const COMPARATORS = new Set(['=', '!=', '<>', '<=>', '<', '<=', '>', '>=']);
  const OPS2 = new Set(['<=>', '<=', '>=', '<>', '!=', '||', '&&', '::', ':=', '->', '=>', '<<', '>>']);
  const OPS3 = new Set(['<=>']);
  const SPACE_BEFORE_PAREN = new Set(['IN', 'EXISTS', 'WHERE', 'NOT', 'AND', 'OR', 'ON', 'FROM', 'SELECT', 'VALUES', 'AS', 'CASE']);
  const LITERAL_WORDS = new Set(['TRUE', 'FALSE', 'NULL']);
  /* OR, AND, END, CASE, BETWEEN - the only words readAtom reacts to. */
  const ATOM_KEYWORD_LENGTHS = new Set([2, 3, 4, 7]);

  /* --------------------------------------------------------------- lexer */

  /* Character classes as code comparisons. The lexer asks these questions
     once per character of the statement, and a regular expression per
     character dominated lexing of the long single-line SQL this viewer is
     built for. */
  function isWordStartCode(code) {
    return (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
      || code === 95 /* _ */ || code === 64 /* @ */ || code === 36 /* $ */
      || code > 127;
  }

  function isWordCharCode(code) {
    return (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
      || (code >= 48 && code <= 57)
      || code === 95 || code === 64 || code === 36 || code === 35 /* # */
      || code > 127;
  }

  /* Exactly the set JavaScript's \s matches, so the lexer skips what it did
     when this was a /\s/ test per character. */
  function isSpaceCode(code) {
    if (code === 32 || (code >= 9 && code <= 13)) return true;
    if (code <= 127) return false;
    return code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a)
      || code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f
      || code === 0x3000 || code === 0xfeff;
  }

  function isDigitCode(code) { return code >= 48 && code <= 57; }

  function isHexCode(code) {
    return (code >= 48 && code <= 57) || (code >= 97 && code <= 102) || (code >= 65 && code <= 70);
  }

  function pushToken(out, type, value, start, end) {
    out.push({ type, value, start, end });
  }

  /* The viewer passes its configured line-comment markers along with the SQL
     snapshot; they only count at the start of a line. Without a list (the
     Node tests) the lexer keeps the historic "#" anywhere behaviour. */
  let lineCommentMarkers = null;

  /* `blank` is the lexer's running answer to "is everything between the last
     newline and here a space, tab or carriage return?". It used to be
     rediscovered by walking backwards from each character in turn, which is
     work the lexer had already done on its way forward. */
  function lineCommentStart(sql, i, blank) {
    if (lineCommentMarkers === null) return sql[i] === '#';
    if (!blank || !lineCommentMarkers.length) return false;
    for (let j = 0; j < lineCommentMarkers.length; j++) {
      if (sql.startsWith(lineCommentMarkers[j], i)) return true;
    }
    return false;
  }

  /* Only ' ', '\t' and '\r' keep a line blank; every other character ends
     the run exactly as the old backward scan did. */
  function blankAfter(text) {
    const newline = text.lastIndexOf('\n');
    if (newline < 0) return false;
    for (let i = newline + 1; i < text.length; i++) {
      const ch = text[i];
      if (ch !== ' ' && ch !== '\t' && ch !== '\r') return false;
    }
    return true;
  }

  function lex(sql) {
    const out = [];
    const length = sql.length;
    let i = 0;
    let blank = true;

    while (i < length) {
      const code = sql.charCodeAt(i);

      if (isSpaceCode(code)) {
        if (code === 10) blank = true;
        else if (code !== 32 && code !== 9 && code !== 13) blank = false;
        i++;
        continue;
      }

      const c = sql[i];

      if ((code === 45 && sql.charCodeAt(i + 1) === 45) || lineCommentStart(sql, i, blank)) {
        const start = i;
        let end = sql.indexOf('\n', i);
        if (end < 0) end = sql.length;
        pushToken(out, 'comment', sql.slice(start, end), start, end);
        i = end;
        blank = false;
        continue;
      }

      if (c === '/' && sql[i + 1] === '*') {
        const start = i;
        let end = sql.indexOf('*/', i + 2);
        end = end < 0 ? sql.length : end + 2;
        const text = sql.slice(start, end);
        pushToken(out, 'comment', text, start, end);
        i = end;
        blank = blankAfter(text);
        continue;
      }

      blank = false;

      if (c === "'" || c === '"' || c === '`' || c === '[') {
        const start = i;
        const close = c === '[' ? ']' : c;
        i++;
        while (i < length) {
          if (sql[i] === '\\' && c !== '`' && c !== '[') { i += 2; continue; }
          if (sql[i] === close) {
            if (sql[i + 1] === close && c !== '[') { i += 2; continue; }
            i++;
            break;
          }
          i++;
        }
        const text = sql.slice(start, i);
        pushToken(out, c === '`' || c === '[' ? 'qid' : 'str', text, start, i);
        if (text.indexOf('\n') >= 0) blank = blankAfter(text);
        continue;
      }

      if (isDigitCode(code) || (code === 46 && isDigitCode(sql.charCodeAt(i + 1)))) {
        const start = i;
        if (code === 48 && (sql[i + 1] === 'x' || sql[i + 1] === 'X')) {
          i += 2;
          while (isHexCode(sql.charCodeAt(i))) i++;
        } else {
          for (;;) {
            const digit = sql.charCodeAt(i);
            if (!isDigitCode(digit) && digit !== 46) break;
            i++;
          }
          if (sql[i] === 'e' || sql[i] === 'E') {
            let j = i + 1;
            if (sql[j] === '+' || sql[j] === '-') j++;
            if (isDigitCode(sql.charCodeAt(j))) {
              i = j + 1;
              while (isDigitCode(sql.charCodeAt(i))) i++;
            }
          }
        }
        pushToken(out, 'num', sql.slice(start, i), start, i);
        continue;
      }

      if (isWordStartCode(code)) {
        const start = i++;
        while (isWordCharCode(sql.charCodeAt(i))) i++;
        pushToken(out, 'word', sql.slice(start, i), start, i);
        continue;
      }

      if (c === '(' || c === ')') { pushToken(out, 'paren', c, i, i + 1); i++; continue; }
      if (c === ',') { pushToken(out, 'comma', c, i, i + 1); i++; continue; }
      if (c === ';') { pushToken(out, 'semi', c, i, i + 1); i++; continue; }

      const three = sql.slice(i, i + 3), two = sql.slice(i, i + 2);
      if (OPS3.has(three)) { pushToken(out, 'op', three, i, i + 3); i += 3; continue; }
      if (OPS2.has(two)) { pushToken(out, 'op', two, i, i + 2); i += 2; continue; }
      pushToken(out, 'op', c, i, i + 1);
      i++;
    }
    return out;
  }

  /* ------------------------------------------------------------- caches

     The optimiser walks the same nodes many times over: once per fixed-point
     pass, and O(n^2) times inside the implication scans that remove covered
     branches. Nothing here mutates a node, a token or a parsed constraint
     once it exists - every rewrite builds fresh objects - so each derived
     value is memoised against the object it came from, and the WeakMaps are
     collected along with the run's own AST. */
  const signatureCache = new WeakMap();
  const tokenKeyCache = new WeakMap();
  const constraintCache = new WeakMap();
  const factsCache = new WeakMap();
  const costCache = new WeakMap();
  const bucketSetCache = new WeakMap();

  /* Comments are rare, so the common answer is the caller's own array. */
  function significant(tokens) {
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type === 'comment') return tokens.filter(t => t.type !== 'comment');
    }
    return tokens;
  }

  /* SQL identifiers are normally case-insensitive. Keep the original token
     for rendering, but use one semantic spelling for optimiser comparisons so
     `prodid`, `PRODID`, and `[prodid]` share the same constraint group. */
  function identifierName(token) {
    if (!token) return '';
    const value = token.value || '';
    if (token.type !== 'qid') return value;
    if (value[0] === '[' && value[value.length - 1] === ']') return value.slice(1, -1).replace(/]]/g, ']');
    if ((value[0] === '`' || value[0] === '"') && value[value.length - 1] === value[0]) {
      return value.slice(1, -1).replace(new RegExp(value[0] + value[0], 'g'), value[0]);
    }
    return value;
  }

  function stringLiteralName(value) {
    if (!value || value.length < 2) return value;
    const quote = value[0];
    if ((quote !== "'" && quote !== '"') || value[value.length - 1] !== quote) return value;
    return value.slice(1, -1).replace(new RegExp(quote + quote, 'g'), quote);
  }

  function canonicalToken(t) {
    return t.type === 'word' ? t.value.toUpperCase() : t.value;
  }

  function tokenKey(tokens) {
    const cached = tokenKeyCache.get(tokens);
    if (cached !== undefined) return cached;
    const list = significant(tokens);
    let key = '';
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (i) key += '|';
      if (t.type === 'qid') key += 'word:' + identifierName(t).toUpperCase();
      else if (t.type === 'str') key += 'str:' + stringLiteralName(t.value).toUpperCase();
      else key += t.type + ':' + (t.type === 'word' ? t.value.toUpperCase() : t.value);
    }
    tokenKeyCache.set(tokens, key);
    return key;
  }

  function needsSpace(prev, cur, compact = false) {
    if (!prev) return false;
    if (cur.type === 'comma' || cur.type === 'semi' || (cur.type === 'paren' && cur.value === ')')) return false;
    if (prev.type === 'paren' && prev.value === '(') return false;
    if (cur.value === '.' || prev.value === '.') return false;
    if (cur.type === 'paren' && cur.value === '(' && (prev.type === 'word' || prev.type === 'qid') && !SPACE_BEFORE_PAREN.has(prev.value.toUpperCase())) return false;
    if (prev.type === 'comma') return !compact;
    if (prev.type === 'comment' || cur.type === 'comment') return true;
    if (compact && (prev.type === 'op' || cur.type === 'op')) return false;
    if (prev.type === 'op' && (prev.value === '::' || prev.value === '->')) return false;
    if (prev.type === 'op' && (prev.value === '+' || prev.value === '-') && (!prev.prev || prev.prev.type === 'op')) return false;
    return true;
  }

  function renderTokens(tokens, options = {}) {
    const compact = options.compact === true;
    let text = '';
    let prev = null;
    for (const token of tokens) {
      if (needsSpace(prev, token, compact)) text += ' ';
      text += token.value;
      prev = token;
    }
    return text;
  }

  function synthetic(type, value) {
    return { type, value, start: 0, end: value.length };
  }

  /* ---------------------------------------------------------- target finder */

  function extractTarget(sql) {
    const tokens = lex(sql);
    const code = significant(tokens);
    if (!code.length) return { error: 'There is no SQL to optimise.' };

    let depth = 0;
    let whereIndex = -1;
    for (let i = 0; i < code.length; i++) {
      const token = code[i];
      if (token.type === 'paren') {
        if (token.value === '(') depth++;
        else depth = Math.max(0, depth - 1);
        continue;
      }
      if (depth === 0 && token.type === 'word' && token.value.toUpperCase() === 'WHERE') {
        whereIndex = i;
        break;
      }
    }

    if (whereIndex >= 0) {
      depth = 0;
      let end = code.length;
      for (let i = whereIndex + 1; i < code.length; i++) {
        const token = code[i];
        if (token.type === 'paren') {
          if (token.value === '(') depth++;
          else depth = Math.max(0, depth - 1);
          continue;
        }
        if (depth === 0 && token.type === 'semi') { end = i; break; }
        if (depth === 0 && token.type === 'word' && CLAUSE_STOP.has(token.value.toUpperCase())) {
          end = i;
          break;
        }
      }
      return {
        mode: whereIndex === 0 ? 'where' : 'statement',
        prefix: code.slice(0, whereIndex),
        where: code[whereIndex],
        expression: code.slice(whereIndex + 1, end),
        suffix: code.slice(end),
      };
    }

    let suffix = [];
    let expression = code;
    if (expression[expression.length - 1].type === 'semi') {
      suffix = [expression[expression.length - 1]];
      expression = expression.slice(0, -1);
    }
    const first = expression[0];
    if (first && first.type === 'word' && /^(SELECT|INSERT|UPDATE|DELETE|WITH|CREATE|ALTER|DROP|TRUNCATE|EXPLAIN|SHOW|REPLACE)$/i.test(first.value)) {
      return { error: 'No top-level WHERE predicate was found. Only WHERE logic is optimised.' };
    }
    return { mode: 'predicate', prefix: [], where: null, expression, suffix };
  }

  /* -------------------------------------------------------- boolean parser */

  class ParseError extends Error {
    constructor(message, token) {
      super(message);
      this.token = token || null;
    }
  }

  class BooleanParser {
    constructor(tokens) {
      this.tokens = significant(tokens);
      this.index = 0;
    }

    peek() { return this.tokens[this.index] || null; }

    /* Every keyword this parser looks for is ASCII, and no character
       uppercases into one, so a length mismatch is already a mismatch. The
       guard matters because the alternative is a fresh uppercase string for
       every word token, three times over, on the way through the statement. */
    matchWord(word) {
      const token = this.peek();
      if (token && token.type === 'word' && token.value.length === word.length && token.value.toUpperCase() === word) {
        this.index++;
        return true;
      }
      return false;
    }

    parse() {
      if (!this.tokens.length) throw new ParseError('The WHERE predicate is empty.');
      const node = this.parseOr();
      const rest = this.peek();
      if (rest) throw new ParseError(`Unexpected ${JSON.stringify(rest.value)} in predicate.`, rest);
      return node;
    }

    parseOr() {
      const children = [this.parseAnd()];
      while (this.matchWord('OR')) children.push(this.parseAnd());
      return children.length === 1 ? children[0] : { kind: 'or', children };
    }

    parseAnd() {
      const children = [this.parseNot()];
      while (this.matchWord('AND')) children.push(this.parseNot());
      return children.length === 1 ? children[0] : { kind: 'and', children };
    }

    parseNot() {
      if (this.matchWord('NOT')) return { kind: 'not', child: this.parseNot() };
      return this.parsePrimary();
    }

    parsePrimary() {
      const token = this.peek();
      if (!token) throw new ParseError('The predicate ends unexpectedly.');
      if (token.type === 'paren' && token.value === '(') {
        this.index++;
        const child = this.parseOr();
        const close = this.peek();
        if (!close || close.type !== 'paren' || close.value !== ')') {
          throw new ParseError('A closing parenthesis is missing.', close || token);
        }
        this.index++;
        return child;
      }
      if (token.type === 'paren' && token.value === ')') {
        throw new ParseError('Unexpected closing parenthesis.', token);
      }
      return { kind: 'atom', tokens: this.readAtom() };
    }

    readAtom() {
      const start = this.index;
      let depth = 0;
      let caseDepth = 0;
      let betweenNeedsAnd = false;
      while (this.index < this.tokens.length) {
        const token = this.tokens[this.index];
        if (token.type === 'paren') {
          if (token.value === '(') depth++;
          else if (depth > 0) depth--;
          else break;
          this.index++;
          continue;
        }
        if (token.type === 'word' && ATOM_KEYWORD_LENGTHS.has(token.value.length)) {
          const word = token.value.toUpperCase();
          if (depth === 0 && caseDepth === 0 && (word === 'AND' || word === 'OR')) {
            if (word === 'AND' && betweenNeedsAnd) {
              betweenNeedsAnd = false;
            } else {
              break;
            }
          }
          if (word === 'BETWEEN' && depth === 0 && caseDepth === 0) betweenNeedsAnd = true;
          if (word === 'CASE') caseDepth++;
          else if (word === 'END' && caseDepth > 0) caseDepth--;
        }
        this.index++;
      }
      if (this.index === start) throw new ParseError('A predicate was expected.', this.peek());
      return this.tokens.slice(start, this.index);
    }
  }

  /* ------------------------------------------------------------ AST utils */

  function constant(value) { return { kind: 'const', value: !!value }; }

  function nodeSignature(node) {
    if (!node) return '';
    if (node.kind === 'const') return node.value ? 'true' : 'false';
    const cached = signatureCache.get(node);
    if (cached !== undefined) return cached;
    let signature;
    if (node.kind === 'atom') signature = `a:${tokenKey(node.tokens)}`;
    else if (node.kind === 'not') signature = `not(${nodeSignature(node.child)})`;
    else signature = `${node.kind}(${node.children.map(nodeSignature).sort().join(',')})`;
    signatureCache.set(node, signature);
    return signature;
  }

  function precedence(node) {
    if (node.kind === 'or') return 1;
    if (node.kind === 'and') return 2;
    if (node.kind === 'not') return 3;
    return 4;
  }

  function flatten(node, kind, into = []) {
    if (node.kind === kind) {
      for (const child of node.children) flatten(child, kind, into);
    } else {
      into.push(node);
    }
    return into;
  }

  function makeLogic(kind, children) {
    if (!children.length) return constant(kind === 'and');
    return children.length === 1 ? children[0] : { kind, children };
  }

  const RULES = {
    constants: { title: 'Folded constant conditions', detail: 'TRUE and FALSE branches were reduced without changing the predicate’s meaning.' },
    duplicates: { title: 'Removed duplicate predicates', detail: 'Repeated conditions were kept only once.' },
    covered: { title: 'Removed covered branches', detail: 'A narrower branch was already guaranteed by a broader branch.' },
    ranges: { title: 'Tightened ranges', detail: 'Multiple bounds on the same column were reduced to the strongest safe bound.' },
    sets: { title: 'Merged equality checks into IN', detail: 'Same-column equality alternatives were expressed as one readable set.' },
    impossible: { title: 'Removed impossible conditions', detail: 'Conflicting constraints on the same column can never pass a WHERE filter.' },
    inherited: { title: 'Removed conditions guaranteed by outer filters', detail: 'A nested condition was already decided by the AND constraints surrounding it.' },
    factored: { title: 'Factored shared conditions out of OR', detail: 'A condition repeated in every OR branch was written once in front of them.' },
    negated: { title: 'Pushed NOT into the comparison', detail: 'A negated comparison was rewritten with the opposite operator instead of being wrapped in NOT.' },
  };

  /* The grouped rule names the column the user chose, so it is built per run
     rather than stored in the static table above. */
  function groupedRule(column) {
    const name = column ? column.toLowerCase() : DEFAULT_GROUP_COLUMN;
    return {
      title: `Grouped ${name} conditions`,
      detail: `Literal ${name} filters were collected into one positive override and one global exclusion.`,
    };
  }

  function addRule(ctx, key, column) {
    if (ctx.rules.has(key)) return;
    ctx.rules.set(key, key === 'grouped' ? groupedRule(column) : RULES[key]);
  }

  /* ------------------------------------------------------- constraints */

  function isIdentifier(token) { return token && (token.type === 'word' || token.type === 'qid'); }

  function fieldAt(tokens) {
    if (!isIdentifier(tokens[0])) return null;
    const field = [tokens[0]];
    let i = 1;
    while (tokens[i] && tokens[i].value === '.' && isIdentifier(tokens[i + 1])) {
      field.push(tokens[i], tokens[i + 1]);
      i += 2;
    }
    return { tokens: field, key: tokenKey(field), next: i };
  }

  function literalAt(tokens, index) {
    const token = tokens[index];
    if (!token) return null;
    if (token.type === 'str' || token.type === 'num') return { tokens: [token], next: index + 1 };
    if (token.type === 'op' && (token.value === '-' || token.value === '+') && tokens[index + 1] && tokens[index + 1].type === 'num') {
      return { tokens: [token, tokens[index + 1]], next: index + 2 };
    }
    if (token.type === 'word' && LITERAL_WORDS.has(token.value.toUpperCase())) return { tokens: [token], next: index + 1 };
    return null;
  }

  function parseList(tokens, index) {
    if (!tokens[index] || tokens[index].type !== 'paren' || tokens[index].value !== '(') return null;
    const values = [];
    let i = index + 1;
    if (tokens[i] && tokens[i].type === 'paren' && tokens[i].value === ')') return { values, next: i + 1 };
    while (i < tokens.length) {
      const value = literalAt(tokens, i);
      if (!value) return null;
      values.push({ tokens: value.tokens, key: tokenKey(value.tokens) });
      i = value.next;
      if (tokens[i] && tokens[i].type === 'comma') { i++; continue; }
      if (tokens[i] && tokens[i].type === 'paren' && tokens[i].value === ')') return { values, next: i + 1 };
      return null;
    }
    return null;
  }

  function parseConstraint(node) {
    if (!node || node.kind !== 'atom') return null;
    const cached = constraintCache.get(node);
    if (cached !== undefined) return cached;
    const constraint = readConstraint(node);
    constraintCache.set(node, constraint);
    return constraint;
  }

  function readConstraint(node) {
    const tokens = significant(node.tokens);
    const field = fieldAt(tokens);
    if (!field) return null;
    let i = field.next;
    const operator = tokens[i];
    if (!operator) return null;
    const word = operator.type === 'word' ? operator.value.toUpperCase() : operator.value;

    if (word === 'IS') {
      i++;
      let not = false;
      if (tokens[i] && tokens[i].type === 'word' && tokens[i].value.toUpperCase() === 'NOT') { not = true; i++; }
      if (!tokens[i] || tokens[i].type !== 'word' || tokens[i].value.toUpperCase() !== 'NULL' || i + 1 !== tokens.length) return null;
      return { kind: not ? 'notNull' : 'null', field: field.key, fieldTokens: field.tokens, node };
    }

    if (word === 'NOT' && tokens[i + 1] && tokens[i + 1].type === 'word' && tokens[i + 1].value.toUpperCase() === 'IN') {
      const list = parseList(tokens, i + 2);
      if (!list || list.next !== tokens.length || !list.values.length) return null;
      /* NOT IN (..., NULL) is UNKNOWN or FALSE but never TRUE, so it does not
         behave like a set complement. Leave that shape alone. */
      if (hasNullValue(list.values)) return null;
      return { kind: 'notSet', field: field.key, fieldTokens: field.tokens, values: list.values, node };
    }

    if (word === 'IN') {
      const list = parseList(tokens, i + 1);
      if (!list || list.next !== tokens.length || !list.values.length) return null;
      if (list.values.some(v => v.key.toUpperCase() === 'WORD:NULL')) return null;
      return { kind: 'set', field: field.key, fieldTokens: field.tokens, values: list.values, node };
    }

    if (word === 'BETWEEN') {
      const low = literalAt(tokens, i + 1);
      if (!low || !tokens[low.next] || tokens[low.next].type !== 'word' || tokens[low.next].value.toUpperCase() !== 'AND') return null;
      const high = literalAt(tokens, low.next + 1);
      if (!high || high.next !== tokens.length) return null;
      const lowerValue = { tokens: low.tokens, key: tokenKey(low.tokens) };
      const upperValue = { tokens: high.tokens, key: tokenKey(high.tokens) };
      return {
        kind: 'range', field: field.key, fieldTokens: field.tokens,
        lower: { op: '>=', value: lowerValue, tokens: low.tokens, key: lowerValue.key },
        upper: { op: '<=', value: upperValue, tokens: high.tokens, key: upperValue.key },
        node,
      };
    }

    if (!COMPARATORS.has(word)) return null;
    const value = literalAt(tokens, i + 1);
    if (!value || value.next !== tokens.length) return null;
    const valueData = { tokens: value.tokens, key: tokenKey(value.tokens) };
    if (word === '<>' || word === '!=') {
      if (hasNullValue([valueData])) return null;
      return { kind: 'notSet', field: field.key, fieldTokens: field.tokens, values: [valueData], node };
    }
    if (word === '=') return { kind: 'eq', field: field.key, fieldTokens: field.tokens, value: valueData, node };
    if (word === '>' || word === '>=') return { kind: 'lower', field: field.key, fieldTokens: field.tokens, op: word, value: valueData, node };
    if (word === '<' || word === '<=') return { kind: 'upper', field: field.key, fieldTokens: field.tokens, op: word, value: valueData, node };
    return null;
  }

  const NEGATED_OP = { '=': '<>', '<>': '=', '!=': '=', '<': '>=', '>=': '<', '>': '<=', '<=': '>' };

  /* NOT (field OP literal) -> field NEGATED-OP literal, one comparison at a
     time - no De Morgan expansion over AND/OR. Exact in three-valued logic:
     a NULL operand leaves both forms UNKNOWN. parseConstraint gates the
     shape, so NULL inside an IN list is left alone. */
  function negateAtom(node) {
    if (!node || node.kind !== 'atom' || !parseConstraint(node)) return null;
    const tokens = significant(node.tokens);
    const i = fieldAt(tokens).next;
    const word = canonicalToken(tokens[i]).toUpperCase();
    const splice = (at, remove, ...insert) => {
      const out = tokens.slice();
      out.splice(at, remove, ...insert);
      return { kind: 'atom', tokens: out };
    };
    if (NEGATED_OP[word]) return splice(i, 1, synthetic(tokens[i].type, NEGATED_OP[word]));
    if (word === 'IN') return splice(i, 0, synthetic('word', 'NOT'));
    if (word === 'NOT') return splice(i, 1);
    if (word === 'IS') {
      return canonicalToken(tokens[i + 1]).toUpperCase() === 'NOT'
        ? splice(i + 1, 1)
        : splice(i + 1, 0, synthetic('word', 'NOT'));
    }
    return null; /* ponytail: BETWEEN stays as-is, NOT BETWEEN is no shorter. */
  }

  /* Memoised on the literal record itself. Every literal in the predicate is
     read millions of times by the implication scans, and a field on the object
     is the cheapest lookup available; the records are ours, are built once per
     atom and are never rewritten. */
  function valueComparable(value) {
    const cached = value.comparable;
    if (cached !== undefined) return cached;
    const computed = readComparable(value);
    value.comparable = computed;
    return computed;
  }

  function readComparable(value) {
    const text = renderTokens(value.tokens).trim();
    if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) {
      const number = Number(text);
      if (Number.isFinite(number)) return { type: 'number', value: number };
    }
    if ((text[0] === "'" && text[text.length - 1] === "'") || (text[0] === '"' && text[text.length - 1] === '"')) {
      /* The target databases use case-insensitive text comparisons. Preserve
         the first literal's spelling in the rendered SQL, but compare folded
         text for set merging, implication, ranges, and duplicate removal. */
      return { type: 'string', value: stringLiteralName(text).toUpperCase() };
    }
    return null;
  }

  function compareValues(a, b) {
    if (a.key === b.key) return 0;
    const av = valueComparable(a), bv = valueComparable(b);
    if (!av || !bv || av.type !== bv.type) return null;
    return av.value < bv.value ? -1 : av.value > bv.value ? 1 : 0;
  }

  function equalityValue(value, other) {
    const compared = compareValues(value, other);
    return compared === 0 || (compared === null && value.key === other.key);
  }

  function satisfies(value, op, bound) {
    const compared = compareValues(value, bound);
    if (compared === null) return null;
    if (op === '=') return compared === 0;
    if (op === '>') return compared > 0;
    if (op === '>=') return compared >= 0;
    if (op === '<') return compared < 0;
    if (op === '<=') return compared <= 0;
    return null;
  }

  function lowerImplies(strong, weak) {
    const compared = compareValues(strong.value, weak.value);
    if (compared === null) return false;
    if (compared > 0) return true;
    if (compared < 0) return false;
    return strong.op === '>' || weak.op === '>=';
  }

  function upperImplies(strong, weak) {
    const compared = compareValues(strong.value, weak.value);
    if (compared === null) return false;
    if (compared < 0) return true;
    if (compared > 0) return false;
    return strong.op === '<' || weak.op === '<=';
  }

  function constraintImplies(strong, weak) {
    if (!strong || !weak || strong.field !== weak.field) return false;
    if (weak.kind === 'null') return strong.kind === 'null';
    if (weak.kind === 'notNull') return ['eq', 'set', 'lower', 'upper', 'range', 'notNull', 'notSet'].includes(strong.kind);

    /* Every excluded literal has to be provably unreachable under `strong`. */
    if (weak.kind === 'notSet') {
      const excludes = value => {
        if (valueComparable(value) === null) return false;
        if (strong.kind === 'eq') return compareValues(strong.value, value) === 1 || compareValues(strong.value, value) === -1;
        if (strong.kind === 'set') return strong.values.every(v => compareValues(v, value) === 1 || compareValues(v, value) === -1);
        if (strong.kind === 'lower' || strong.kind === 'upper') return satisfies(value, strong.op, strong.value) === false;
        if (strong.kind === 'range') {
          return satisfies(value, strong.lower.op, strong.lower.value) === false
            || satisfies(value, strong.upper.op, strong.upper.value) === false;
        }
        return false;
      };
      if (strong.kind === 'notSet') {
        const excluded = valueBucketSet(strong.values);
        return weak.values.every(w => excluded.has(valueBucket(w)));
      }
      return weak.values.every(excludes);
    }
    if (strong.kind === 'notSet') return false;

    if (strong.kind === 'range') {
      if (weak.kind === 'range') return lowerImplies(strong.lower, weak.lower) && upperImplies(strong.upper, weak.upper);
      if (weak.kind === 'lower') return lowerImplies(strong.lower, weak);
      if (weak.kind === 'upper') return upperImplies(strong.upper, weak);
      return false;
    }
    if (strong.kind === 'eq') {
      if (weak.kind === 'eq') return equalityValue(strong.value, weak.value);
      if (weak.kind === 'set') return valueBucketSet(weak.values).has(valueBucket(strong.value));
      if (weak.kind === 'lower' || weak.kind === 'upper') return satisfies(strong.value, weak.op, weak.value) === true;
      if (weak.kind === 'range') return satisfies(strong.value, weak.lower.op, weak.lower.value) === true && satisfies(strong.value, weak.upper.op, weak.upper.value) === true;
      return false;
    }
    if (strong.kind === 'set') {
      if (weak.kind === 'set') {
        const allowed = valueBucketSet(weak.values);
        return strong.values.every(s => allowed.has(valueBucket(s)));
      }
      if (weak.kind === 'lower' || weak.kind === 'upper') return strong.values.every(v => satisfies(v, weak.op, weak.value) === true);
      if (weak.kind === 'range') return strong.values.every(v => satisfies(v, weak.lower.op, weak.lower.value) === true && satisfies(v, weak.upper.op, weak.upper.value) === true);
      return false;
    }
    if (strong.kind === 'lower') return weak.kind === 'lower' && lowerImplies(strong, weak);
    if (strong.kind === 'upper') return weak.kind === 'upper' && upperImplies(strong, weak);
    return strong.kind === weak.kind;
  }

  function nodeTerms(node) {
    if (node.kind === 'atom') return [node];
    if (node.kind === 'and') return flatten(node, 'and');
    return null;
  }

  /* Everything the implication test needs about one node: its signature, its
     AND terms, and those terms' constraints indexed by column.
     constraintImplies is false whenever the columns differ, so consulting one
     column's bucket asks exactly the same question as scanning every term.
     The scans that remove covered branches compare every pair of branches, so
     the whole record is derived once per node and then only read. */
  function implicationFacts(node) {
    const cached = factsCache.get(node);
    if (cached !== undefined) return cached;
    const terms = nodeTerms(node);
    const entries = [];
    const byField = new Map();
    const signatures = new Set();
    if (terms) {
      for (const term of terms) {
        const constraint = parseConstraint(term);
        if (constraint) {
          const bucket = byField.get(constraint.field);
          if (bucket) bucket.push(constraint);
          else byField.set(constraint.field, [constraint]);
        }
        const signature = nodeSignature(term);
        signatures.add(signature);
        entries.push({ constraint, signature });
      }
    }
    const facts = { signature: nodeSignature(node), conjunctive: terms !== null, entries, byField, signatures };
    factsCache.set(node, facts);
    return facts;
  }

  function impliesFacts(strong, weak) {
    if (strong.signature === weak.signature) return true;
    if (!strong.conjunctive || !weak.conjunctive) return false;

    const entries = weak.entries;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry.constraint) {
        if (!strong.signatures.has(entry.signature)) return false;
        continue;
      }
      const candidates = strong.byField.get(entry.constraint.field);
      if (!candidates) return false;
      let implied = false;
      for (let k = 0; k < candidates.length; k++) {
        if (constraintImplies(candidates[k], entry.constraint)) { implied = true; break; }
      }
      if (!implied) return false;
    }
    return true;
  }

  function makeSetAtom(fieldTokens, values, negated) {
    if (values.length === 1) {
      return {
        kind: 'atom',
        tokens: [...fieldTokens, synthetic('op', negated ? '<>' : '='), ...values[0].tokens.map(t => ({ ...t }))],
      };
    }
    const tokens = [...fieldTokens];
    if (negated) tokens.push(synthetic('word', 'NOT'));
    tokens.push(synthetic('word', 'IN'), synthetic('paren', '('));
    values.forEach((value, index) => {
      if (index) tokens.push(synthetic('comma', ','));
      tokens.push(...value.tokens.map(t => ({ ...t })));
    });
    tokens.push(synthetic('paren', ')'));
    return { kind: 'atom', tokens };
  }

  function makeNotNullAtom(fieldTokens) {
    return {
      kind: 'atom',
      tokens: [...fieldTokens, synthetic('word', 'IS'), synthetic('word', 'NOT'), synthetic('word', 'NULL')],
    };
  }

  function dedupeLiteralSet(node, ctx) {
    const constraint = parseConstraint(node);
    if (!constraint || !['set', 'notSet'].includes(constraint.kind)) return node;
    const values = valueListUnique(constraint.values);
    if (values.length === constraint.values.length) return node;
    addRule(ctx, 'duplicates');
    return makeSetAtom(constraint.fieldTokens, values, constraint.kind === 'notSet');
  }

  function comparableValues(values) {
    return values.every(value => valueComparable(value) !== null);
  }

  /* equalityValue is an equivalence relation - two literals match when their
     canonical text is the same, or when both are comparable and compare equal
     - so it can be written as a single bucket string. The list operations
     below were all O(n^2) scans of equalityValue; with buckets they are hash
     lookups, which is what a few hundred grouped product IDs need. */
  function valueBucket(value) {
    const cached = value.bucket;
    if (cached !== undefined) return cached;
    const comparable = valueComparable(value);
    const bucket = !comparable ? `k:${value.key}`
      : comparable.type === 'number' ? `n:${comparable.value}` : `s:${comparable.value}`;
    value.bucket = bucket;
    return bucket;
  }

  function valueBucketSet(values) {
    const cached = bucketSetCache.get(values);
    if (cached !== undefined) return cached;
    const set = new Set();
    for (const value of values) set.add(valueBucket(value));
    bucketSetCache.set(values, set);
    return set;
  }

  function valueListDifference(values, removed) {
    if (!removed.length) return values.slice();
    const excluded = valueBucketSet(removed);
    return values.filter(value => !excluded.has(valueBucket(value)));
  }

  function valueListIntersection(left, right) {
    const kept = valueBucketSet(right);
    return left.filter(value => kept.has(valueBucket(value)));
  }

  /* NOT IN / <> literals only merge when every one of them can be compared;
     otherwise "different key" does not prove "different value" (0x10 and 16)
     and the original nodes are passed straight through. */
  function exclusionState(notSets) {
    const nodes = notSets.map(c => c.node);
    if (!notSets.length || !notSets.every(c => comparableValues(c.values))) {
      return { values: null, nodes, single: null };
    }
    return {
      values: notSets.reduce((all, c) => valueListUnion(all, c.values), []),
      nodes,
      single: notSets.length === 1 ? notSets[0] : null,
    };
  }

  function sameValueSet(left, right) {
    if (left.length !== right.length) return false;
    const kept = valueBucketSet(right);
    return left.every(value => kept.has(valueBucket(value)));
  }

  function exclusionNodes(fieldTokens, values, state) {
    if (values === null) return state.nodes;
    if (!values.length) return [];
    if (state.single && sameValueSet(state.single.values, values)) return [state.single.node];
    return [makeSetAtom(fieldTokens, values, true)];
  }

  /* ------------------------------------------------ group-by-column pass */

  /* The regular constraint simplifier intentionally leaves NOT IN, <> and !=
     alone. This optional pass extracts the explicit literal filters on one
     chosen column as manual OR overrides; arbitrary SQL is left untouched.
     The column is a viewer setting (the gear in the top bar), defaulting to
     prodid. */

  const DEFAULT_GROUP_COLUMN = 'prodid';

  /* A setting is plain text, so accept the spellings a user would type for a
     column: bare, [bracketed], `backticked` or "quoted". */
  function normaliseGroupColumn(name) {
    const text = String(name == null ? '' : name).trim();
    if (!text) return '';
    const open = text[0];
    const close = text[text.length - 1];
    if (text.length > 1 && ((open === '[' && close === ']') || ((open === '`' || open === '"') && close === open))) {
      return text.slice(1, -1).trim().toUpperCase();
    }
    return text.toUpperCase();
  }

  function isGroupField(field, column) {
    const last = field && field.tokens && field.tokens[field.tokens.length - 1];
    return identifierName(last).toUpperCase() === column;
  }

  function hasNullValue(values) {
    return values.some(value => value.tokens.length === 1 && value.tokens[0].type === 'word' && value.tokens[0].value.toUpperCase() === 'NULL');
  }

  function parseGroupConstraint(node, column) {
    if (!node || node.kind !== 'atom') return null;
    const tokens = significant(node.tokens);
    const field = fieldAt(tokens);
    if (!field || !isGroupField(field, column)) return null;

    let index = field.next;
    const operator = tokens[index];
    if (!operator) return null;
    const word = operator.type === 'word' ? operator.value.toUpperCase() : operator.value;

    if (word === 'IN' || (word === 'NOT' && tokens[index + 1] && tokens[index + 1].type === 'word' && tokens[index + 1].value.toUpperCase() === 'IN')) {
      const negative = word === 'NOT';
      const list = parseList(tokens, index + (negative ? 2 : 1));
      if (!list || list.next !== tokens.length || !list.values.length || hasNullValue(list.values)) return null;
      return groupCondition(negative ? 'negative' : 'positive', { field: field.key, fieldTokens: field.tokens }, list.values);
    }

    if (word !== '=' && word !== '<>' && word !== '!=') return null;
    const value = literalAt(tokens, index + 1);
    if (!value || value.next !== tokens.length || value.tokens[0].type === 'word' && value.tokens[0].value.toUpperCase() === 'NULL') return null;
    return groupCondition(word === '=' ? 'positive' : 'negative', { field: field.key, fieldTokens: field.tokens }, [{ tokens: value.tokens, key: tokenKey(value.tokens) }]);
  }

  function valueListUnique(values) {
    const seen = new Set();
    const out = [];
    for (const value of values) {
      const bucket = valueBucket(value);
      if (seen.has(bucket)) continue;
      seen.add(bucket);
      out.push(value);
    }
    return out;
  }

  function valueListUnion(left, right) {
    return valueListUnique([...left, ...right]);
  }

  function groupCondition(kind, source, values = []) {
    const uniqueValues = valueListUnique(values);
    if (kind === 'positive' && !uniqueValues.length) return { kind: 'none', values: [] };
    if (kind === 'negative' && !uniqueValues.length) {
      return { kind: 'notNull', field: source && source.field, fieldTokens: source && source.fieldTokens, values: [] };
    }
    return {
      kind,
      field: source && source.field,
      fieldTokens: source && source.fieldTokens,
      values: uniqueValues,
    };
  }

  function makeGroupSetAtom(condition) {
    if (condition.kind === 'positive' || condition.kind === 'negative') {
      const tokens = [...condition.fieldTokens, synthetic('word', condition.kind === 'negative' ? 'NOT' : 'IN')];
      if (condition.kind === 'negative') tokens.push(synthetic('word', 'IN'));
      tokens.push(synthetic('paren', '('));
      condition.values.forEach((value, index) => {
        if (index) tokens.push(synthetic('comma', ','));
        tokens.push(...value.tokens.map(token => ({ ...token })));
      });
      tokens.push(synthetic('paren', ')'));
      return { kind: 'atom', tokens };
    }
    if (condition.kind === 'notNull') {
      return {
        kind: 'atom',
        tokens: [...condition.fieldTokens, synthetic('word', 'IS'), synthetic('word', 'NOT'), synthetic('word', 'NULL')],
      };
    }
    return condition.kind === 'all' ? constant(true) : constant(false);
  }

  function combineLogicNodes(kind, nodes) {
    const flattened = [];
    nodes.forEach(node => flatten(node, kind, flattened));
    return makeLogic(kind, flattened);
  }

  /* Remove the recognized predicates on the grouped column from the clean
     expression. A branch containing only those predicates has no clean
     counterpart, so it returns null instead of becoming TRUE. Both positive
     manual overrides and negative exclusions are collected from every boolean
     branch so grouped mode emits one global IN and one global NOT IN. NOT
     expressions are left intact because their grouped predicate is not an
     explicit form of this toggle. */
  function stripGroupConditions(node, collected, column) {
    if (node.kind === 'atom') {
      const condition = parseGroupConstraint(node, column);
      if (condition) { collected.push(condition); return null; }
      return node;
    }
    if (node.kind === 'const' || node.kind === 'not') return node;

    const children = node.children.map(child => {
      const mark = collected.length;
      const result = stripGroupConditions(child, collected, column);
      const tookPositive = result === null && collected.slice(mark).some(condition => condition.kind === 'positive');
      return { result, tookPositive };
    });
    /* An AND that lost a positive grouped list is dropped whole. Its rows are a
       subset of that list, so the hoisted OR override already covers them,
       while keeping the surviving siblings would widen the branch to every row
       they match on their own (Prodcode = 31 AND prodid IN (...) would become
       a bare Prodcode = 31). A stripped OR child is safe to keep because what
       is left still matches a subset of the rows it did before. Negative
       exclusions are intentionally hoisted globally by grouped mode. */
    if (node.kind === 'and' && children.some(child => child.tookPositive)) return null;

    const remaining = children.map(child => child.result).filter(child => child !== null);
    return remaining.length ? makeLogic(node.kind, remaining) : null;
  }

  function groupByColumn(node, ctx, column) {
    const collected = [];
    const clean = stripGroupConditions(node, collected, column);
    if (!collected.length) return node;

    const groups = new Map();
    collected.forEach(condition => {
      if (!groups.has(condition.field)) {
        groups.set(condition.field, { field: condition.field, fieldTokens: condition.fieldTokens, positive: [], negative: [] });
      }
      const group = groups.get(condition.field);
      group[condition.kind] = valueListUnion(group[condition.kind], condition.values);
    });

    const positiveConditions = [];
    const negativeConditions = [];
    groups.forEach(group => {
      if (group.positive.length) positiveConditions.push(groupCondition('positive', group, group.positive));
      if (group.negative.length) negativeConditions.push(groupCondition('negative', group, group.negative));
    });

    const positiveParts = clean ? [clean] : [];
    positiveConditions.forEach(condition => positiveParts.push(makeGroupSetAtom(condition)));
    const positiveTree = positiveParts.length ? combineLogicNodes('or', positiveParts) : null;
    const negativeNodes = negativeConditions.map(makeGroupSetAtom);
    addRule(ctx, 'grouped', column);
    if (!negativeNodes.length) return positiveTree || constant(false);
    if (!positiveTree) return combineLogicNodes('and', negativeNodes);
    return combineLogicNodes('and', [positiveTree, ...negativeNodes]);
  }

  function compareBounds(lower, upper) {
    const compared = compareValues(lower.value, upper.value);
    if (compared === null) return null;
    if (compared > 0) return false;
    if (compared < 0) return true;
    return lower.op === '>=' && upper.op === '<=';
  }

  function simplifyConstraintGroup(entries, ctx) {
    const constraints = entries.map(entry => ({ ...entry, constraint: parseConstraint(entry.node) }));
    const field = constraints[0].constraint;
    let eq = null;
    let allowed = null;
    let nullState = null;
    const lowers = [];
    const uppers = [];
    const notSets = [];

    for (const entry of constraints) {
      const c = entry.constraint;
      if (c.kind === 'notSet') {
        notSets.push(c);
      } else if (c.kind === 'null' || c.kind === 'notNull') {
        if (nullState && nullState.kind !== c.kind) {
          addRule(ctx, 'impossible');
          return { impossible: true };
        }
        nullState = c;
      } else if (c.kind === 'eq') {
        if (eq && !equalityValue(eq.value, c.value)) {
          addRule(ctx, 'impossible');
          return { impossible: true };
        }
        eq = eq || c;
      } else if (c.kind === 'set') {
        allowed = allowed ? valueListIntersection(allowed, c.values) : c.values.slice();
        if (!allowed.length) {
          addRule(ctx, 'impossible');
          return { impossible: true };
        }
      } else if (c.kind === 'lower') {
        lowers.push(c);
      } else if (c.kind === 'upper') {
        uppers.push(c);
      } else if (c.kind === 'range') {
        lowers.push({ ...c.lower, field: c.field, fieldTokens: c.fieldTokens });
        uppers.push({ ...c.upper, field: c.field, fieldTokens: c.fieldTokens });
      }
    }

    const rangeLower = lowers.reduce((best, current) => {
      if (!best) return current;
      const compared = compareValues(current.value, best.value);
      if (compared === null) return best;
      if (compared > 0 || (compared === 0 && current.op === '>' && best.op === '>=')) return current;
      return best;
    }, null);
    const rangeUpper = uppers.reduce((best, current) => {
      if (!best) return current;
      const compared = compareValues(current.value, best.value);
      if (compared === null) return best;
      if (compared < 0 || (compared === 0 && current.op === '<' && best.op === '<=')) return current;
      return best;
    }, null);

    if (rangeLower && rangeUpper && compareBounds(rangeLower, rangeUpper) === false) {
      addRule(ctx, 'impossible');
      return { impossible: true };
    }
    if (nullState && nullState.kind === 'null' && (eq || allowed || rangeLower || rangeUpper || notSets.length)) {
      addRule(ctx, 'impossible');
      return { impossible: true };
    }

    const exclusions = exclusionState(notSets);
    /* An exclusion only settles a positive value when both are comparable. */
    const excluded = exclusions.values;

    if (eq) {
      if (excluded && valueComparable(eq.value) !== null && valueBucketSet(excluded).has(valueBucket(eq.value))) {
        addRule(ctx, 'impossible');
        return { impossible: true };
      }
      if (allowed && !valueBucketSet(allowed).has(valueBucket(eq.value))) {
        addRule(ctx, 'impossible');
        return { impossible: true };
      }
      if (rangeLower && satisfies(eq.value, rangeLower.op, rangeLower.value) === false) {
        addRule(ctx, 'impossible');
        return { impossible: true };
      }
      if (rangeUpper && satisfies(eq.value, rangeUpper.op, rangeUpper.value) === false) {
        addRule(ctx, 'impossible');
        return { impossible: true };
      }
      if (entries.length > 1) addRule(ctx, 'ranges');
      /* A surviving equality decides every other bound on the column, so the
         exclusions are kept only while they cannot be evaluated. */
      const eqKeeps = excluded === null && valueComparable(eq.value) === null ? exclusions.nodes : [];
      return { nodes: [eq.node, ...eqKeeps] };
    }

    if (allowed) {
      let filtered = allowed.slice();
      if (rangeLower) filtered = filtered.filter(value => satisfies(value, rangeLower.op, rangeLower.value) !== false);
      if (rangeUpper) filtered = filtered.filter(value => satisfies(value, rangeUpper.op, rangeUpper.value) !== false);
      const setResolves = excluded !== null && comparableValues(filtered);
      if (setResolves && excluded.length) filtered = valueListDifference(filtered, excluded);
      if (!filtered.length) {
        addRule(ctx, 'impossible');
        return { impossible: true };
      }
      if (filtered.length !== allowed.length || rangeLower || rangeUpper) addRule(ctx, 'ranges');
      const originalSet = constraints.find(entry => entry.constraint.kind === 'set');
      const sameAsOriginal = originalSet && filtered.length === originalSet.constraint.values.length && filtered.every((value, i) => equalityValue(value, originalSet.constraint.values[i]));
      const setNode = sameAsOriginal && !rangeLower && !rangeUpper
        ? originalSet.node
        : makeSetAtom(field.fieldTokens, filtered);
      return { nodes: [setNode, ...(setResolves ? [] : exclusions.nodes)] };
    }

    const nodes = [];
    if (rangeLower) nodes.push(lowers.find(c => c.op === rangeLower.op && c.value.key === rangeLower.value.key)?.node || makeComparisonNode(field.fieldTokens, rangeLower));
    if (rangeUpper) nodes.push(uppers.find(c => c.op === rangeUpper.op && c.value.key === rangeUpper.value.key)?.node || makeComparisonNode(field.fieldTokens, rangeUpper));
    if (nullState) nodes.push(nullState.node);
    /* Drop excluded literals the surviving bounds already rule out. */
    const reachable = excluded === null ? null : excluded.filter(value =>
      (!rangeLower || satisfies(value, rangeLower.op, rangeLower.value) !== false)
      && (!rangeUpper || satisfies(value, rangeUpper.op, rangeUpper.value) !== false));
    nodes.push(...exclusionNodes(field.fieldTokens, reachable, exclusions));
    if (entries.length > nodes.length) addRule(ctx, 'ranges');
    return { nodes };
  }

  function makeComparisonNode(fieldTokens, bound) {
    return {
      kind: 'atom',
      tokens: [...fieldTokens, synthetic('op', bound.op), ...bound.value.tokens.map(t => ({ ...t }))],
    };
  }

  /* ------------------------------------------------------------ simplify */

  /* Two constraints on one column conflict when their AND is unsatisfiable. */
  function constraintsConflict(left, right) {
    if (!left || !right || left.field !== right.field) return false;
    return simplifyConstraintGroup([{ node: left.node }, { node: right.node }], { rules: new Map() }).impossible === true;
  }

  /* `env` holds the constraints an enclosing AND already guarantees. Using it
     can turn UNKNOWN into FALSE, which a WHERE filters identically, but NOT
     would observe the difference - so crossing a NOT drops the environment
     (env === null) and no propagation happens beneath it. */
  function applyEnvironment(node, ctx, env) {
    if (!env || !env.length) return node;
    const constraint = parseConstraint(node);
    if (!constraint) return node;
    for (const outer of env) {
      if (outer.field !== constraint.field || outer.node === node) continue;
      if (constraintImplies(outer, constraint)) { addRule(ctx, 'inherited'); return constant(true); }
      if (constraintsConflict(outer, constraint)) { addRule(ctx, 'impossible'); return constant(false); }
    }
    return node;
  }

  /* A literal TRUE/FALSE written in the SQL, as opposed to one this pass
     derived. Both are two-valued, so folding them is safe under NOT too. */
  function constantAtom(node) {
    const tokens = significant(node.tokens);
    if (tokens.length !== 1 || tokens[0].type !== 'word') return null;
    const word = tokens[0].value.toUpperCase();
    if (word === 'TRUE') return constant(true);
    if (word === 'FALSE') return constant(false);
    return null;
  }

  function simplify(node, ctx, env) {
    if (node.kind === 'const') return node;
    if (node.kind === 'atom') {
      const normalized = dedupeLiteralSet(node, ctx);
      const literal = constantAtom(normalized);
      if (literal) { addRule(ctx, 'constants'); return literal; }
      return applyEnvironment(normalized, ctx, env);
    }
    if (node.kind === 'not') {
      /* One comparison only: NOT flips the operator, never expands over AND/OR. */
      const flipped = negateAtom(node.child);
      if (flipped) { addRule(ctx, 'negated'); return simplify(flipped, ctx, env); }
      const child = simplify(node.child, ctx, null);
      if (child.kind === 'const') { addRule(ctx, 'constants'); return constant(!child.value); }
      if (child.kind === 'not') { addRule(ctx, 'duplicates'); return child.child; }
      return { kind: 'not', child };
    }
    if (node.kind === 'and') {
      const raw = flatten(node, 'and');
      /* Atoms see only the outer environment: sibling atoms are merged by
         simplifyConstraintGroup, which produces tidier SQL than TRUE/FALSE. */
      const local = env ? raw.map(parseConstraint).filter(Boolean) : [];
      /* One extended environment for the whole level; it used to be rebuilt
         for every non-atom child, which is quadratic on a wide AND. */
      const inner = env ? env.concat(local) : env;
      const children = raw.map(child =>
        simplify(child, ctx, !env || child.kind === 'atom' ? env : inner));
      return simplifyAnd(children, ctx, env);
    }
    /* OR branches may not assume each other, only the surrounding AND. */
    return simplifyOr(flatten(node, 'or').map(child => simplify(child, ctx, env)), ctx, env);
  }

  function uniqueNodes(children, ctx) {
    const seen = new Set();
    const out = [];
    for (const child of children) {
      const key = nodeSignature(child);
      if (seen.has(key)) { addRule(ctx, 'duplicates'); continue; }
      seen.add(key);
      out.push(child);
    }
    return out;
  }

  /* Cost of the rendered predicate in tokens, counting the parentheses
     renderLines would add. Factoring only wins when this goes down. */
  function nodeCost(node) {
    if (node.kind === 'const') return 1;
    const cached = costCache.get(node);
    if (cached !== undefined) return cached;
    let cost;
    if (node.kind === 'atom') cost = significant(node.tokens).length;
    else if (node.kind === 'not') cost = 1 + nodeCost(node.child) + (node.child.kind === 'and' || node.child.kind === 'or' ? 2 : 0);
    else {
      cost = node.children.length - 1;
      for (const child of node.children) cost += nodeCost(child) + (node.kind === 'and' && child.kind === 'or' ? 2 : 0);
    }
    costCache.set(node, cost);
    return cost;
  }

  /* (A AND B) OR (A AND C) -> A AND (B OR C). Distribution holds in SQL's
     three-valued logic, so this is only ever a readability decision. */
  function factorOr(children, ctx) {
    if (children.length < 2) return null;
    const branches = children.map(child => flatten(child, 'and'));
    if (branches.some(branch => branch.length < 2)) return null;

    const shared = new Set(branches[0].map(nodeSignature));
    for (const branch of branches.slice(1)) {
      const signatures = new Set(branch.map(nodeSignature));
      for (const signature of [...shared]) if (!signatures.has(signature)) shared.delete(signature);
    }
    if (!shared.size) return null;

    const common = [];
    const seen = new Set();
    for (const term of branches[0]) {
      const signature = nodeSignature(term);
      if (!shared.has(signature) || seen.has(signature)) continue;
      seen.add(signature);
      common.push(term);
    }
    const remainders = branches.map(branch => makeLogic('and', branch.filter(term => !shared.has(nodeSignature(term)))));
    const factored = makeLogic('and', [...common, makeLogic('or', remainders)]);
    if (nodeCost(factored) >= nodeCost(makeLogic('or', children))) return null;
    addRule(ctx, 'factored');
    return factored;
  }

  function simplifyAnd(rawChildren, ctx, env) {
    let children = flatten({ kind: 'and', children: rawChildren }, 'and');
    if (children.some(child => child.kind === 'const' && !child.value)) { addRule(ctx, 'constants'); return constant(false); }
    if (children.some(child => child.kind === 'const' && child.value)) { addRule(ctx, 'constants'); children = children.filter(child => child.kind !== 'const'); }
    if (!children.length) return constant(true);
    children = uniqueNodes(children, ctx);

    /* A AND (A OR B) is A. Constraint implication extends the same rule to
       cases such as quantity >= 20 AND (quantity >= 10 OR customer_type=...). */
    const covered = new Set();
    if (children.some(child => child.kind === 'or')) {
      const facts = children.map(implicationFacts);
      for (let i = 0; i < children.length; i++) {
        if (children[i].kind !== 'or') continue;
        if (children[i].children.some(option => {
          const optionFacts = implicationFacts(option);
          return children.some((other, j) => j !== i && impliesFacts(facts[j], optionFacts));
        })) covered.add(i);
      }
    }
    if (covered.size) { addRule(ctx, 'covered'); children = children.filter((_, i) => !covered.has(i)); }

    const groups = new Map();
    children.forEach((child, index) => {
      const constraint = parseConstraint(child);
      if (!constraint) return;
      if (!groups.has(constraint.field)) groups.set(constraint.field, []);
      groups.get(constraint.field).push({ node: child, constraint, index });
    });

    const consumed = new Set();
    const replacements = new Map();
    for (const entries of groups.values()) {
      if (entries.length < 2) continue;
      /* An unsatisfiable group is UNKNOWN, not FALSE, when the column is
         NULL. A WHERE rejects both, but an enclosing NOT does not, so the
         group is left alone once a NOT has been crossed - and its rules are
         only reported when the rewrite is actually kept. */
      const scratch = { rules: new Map() };
      const result = simplifyConstraintGroup(entries, scratch);
      if (result.impossible && env === null) continue;
      scratch.rules.forEach((rule, key) => { if (!ctx.rules.has(key)) ctx.rules.set(key, rule); });
      if (result.impossible) return constant(false);
      entries.forEach((entry, index) => { if (index > 0) consumed.add(entry.index); });
      replacements.set(entries[0].index, result.nodes || []);
    }

    const reduced = [];
    children.forEach((child, index) => {
      if (consumed.has(index)) return;
      if (replacements.has(index)) reduced.push(...replacements.get(index));
      else reduced.push(child);
    });
    children = uniqueNodes(reduced, ctx);
    if (children.some(child => child.kind === 'const' && !child.value)) return constant(false);
    return makeLogic('and', children);
  }

  /* Alternatives on one column collapse to a single set:
       IN     OR IN        -> IN     (union)
       NOT IN OR NOT IN    -> NOT IN (intersection)
       IN     OR NOT IN    -> NOT IN (negatives minus positives)
     An empty negative set means "any non-NULL value": that turns UNKNOWN into
     FALSE, which a WHERE cannot tell apart but an enclosing NOT can. */
  function mergeOrGroup(entries, safe) {
    const fieldTokens = entries[0].constraint.fieldTokens;
    const positives = [];
    const seenPositives = new Set();
    const negativeLists = [];

    for (const entry of entries) {
      const constraint = entry.constraint;
      if (constraint.kind === 'notSet') { negativeLists.push(constraint.values); continue; }
      const values = constraint.kind === 'eq' ? [constraint.value] : constraint.values;
      values.forEach(value => {
        const bucket = valueBucket(value);
        if (seenPositives.has(bucket)) return;
        seenPositives.add(bucket);
        positives.push(value);
      });
    }

    if (!negativeLists.length) return positives.length > 1 ? makeSetAtom(fieldTokens, positives) : null;
    if (!comparableValues(positives) || !negativeLists.every(comparableValues)) return null;

    const negatives = valueListDifference(
      negativeLists.reduce((all, list) => valueListIntersection(all, list)),
      positives,
    );
    if (!negatives.length) return safe ? makeNotNullAtom(fieldTokens) : null;
    return makeSetAtom(fieldTokens, negatives, true);
  }

  function simplifyOr(rawChildren, ctx, env) {
    let children = flatten({ kind: 'or', children: rawChildren }, 'or');
    if (children.some(child => child.kind === 'const' && child.value)) { addRule(ctx, 'constants'); return constant(true); }
    if (children.some(child => child.kind === 'const' && !child.value)) { addRule(ctx, 'constants'); children = children.filter(child => child.kind !== 'const'); }
    if (!children.length) return constant(false);
    children = uniqueNodes(children, ctx);

    /* A branch only has to be covered once, so the scan moves on to the
       next one as soon as it finds the branch that covers it. */
    let removedAny = false;
    const remove = new Uint8Array(children.length);
    const facts = children.map(implicationFacts);
    for (let i = 0; i < children.length; i++) {
      if (remove[i]) continue;
      for (let j = 0; j < children.length; j++) {
        if (i === j || remove[j]) continue;
        if (impliesFacts(facts[i], facts[j])) {
          remove[i] = 1; removedAny = true; addRule(ctx, 'covered');
          break;
        }
      }
    }
    if (removedAny) children = children.filter((_, index) => !remove[index]);

    /* Group equality / IN / NOT IN alternatives into one set per column. */
    const groups = new Map();
    children.forEach((child, index) => {
      const constraint = parseConstraint(child);
      if (!constraint || !['eq', 'set', 'notSet'].includes(constraint.kind)) return;
      if (constraint.kind === 'set' && constraint.values.some(v => v.key.toUpperCase() === 'WORD:NULL')) return;
      if (!groups.has(constraint.field)) groups.set(constraint.field, []);
      groups.get(constraint.field).push({ node: child, constraint, index });
    });
    const replacements = new Map();
    const consumed = new Set();
    for (const entries of groups.values()) {
      if (entries.length < 2) continue;
      const merged = mergeOrGroup(entries, env !== null);
      if (!merged) continue;
      replacements.set(entries[0].index, merged);
      entries.forEach(entry => consumed.add(entry.index));
      addRule(ctx, 'sets');
    }
    if (replacements.size) {
      const merged = [];
      children.forEach((child, index) => {
        if (replacements.has(index)) merged.push(replacements.get(index));
        else if (!consumed.has(index)) merged.push(child);
      });
      children = uniqueNodes(merged, ctx);
    }

    /* Merging can make a branch cover another one, so make one final pass. */
    let finalRemovedAny = false;
    const finalRemove = new Uint8Array(children.length);
    const finalFacts = children.map(implicationFacts);
    for (let i = 0; i < children.length; i++) {
      for (let j = 0; j < children.length; j++) {
        if (i === j) continue;
        if (impliesFacts(finalFacts[i], finalFacts[j])) {
          finalRemove[i] = 1; finalRemovedAny = true; addRule(ctx, 'covered');
          break;
        }
      }
    }
    if (finalRemovedAny) children = children.filter((_, index) => !finalRemove[index]);
    return factorOr(children, ctx) || makeLogic('or', children);
  }

  /* ----------------------------------------------------------- rendering */

  function renderLines(node, level = 0) {
    const pad = '  '.repeat(level);
    if (node.kind === 'atom') return [pad + renderTokens(node.tokens)];
    if (node.kind === 'const') return [pad + (node.value ? 'TRUE' : 'FALSE')];
    if (node.kind === 'not') {
      if (node.child.kind === 'atom' || node.child.kind === 'const') return [pad + 'NOT ' + renderTokens(node.child.tokens || [synthetic('word', node.child.value ? 'TRUE' : 'FALSE')])];
      return [pad + 'NOT (', ...renderLines(node.child, level + 1), pad + ')'];
    }

    const lines = [];
    const op = node.kind === 'and' ? 'AND' : 'OR';
    node.children.forEach((child, index) => {
      /* AND binds tighter than OR in SQL, so an AND branch inside an OR does
         not need visual parentheses. OR inside AND still does. */
      const wrap = child.kind === 'or' && node.kind === 'and';
      if (wrap) lines.push(pad + '(', ...renderLines(child, level + 1), pad + ')');
      else lines.push(...renderLines(child, level));
      if (index < node.children.length - 1) lines.push(pad + op);
    });
    return lines;
  }

  function prettyExpression(node) {
    return renderLines(node, 0).join('\n');
  }

  function simplifyFixedPoint(tree, ctx) {
    let finalTree = simplify(tree, ctx, []);
    let previous = nodeSignature(tree);
    for (let pass = 0; pass < 10 && nodeSignature(finalTree) !== previous; pass++) {
      previous = nodeSignature(finalTree);
      finalTree = simplify(finalTree, ctx, []);
    }
    return finalTree;
  }

  function assemble(target, expression) {
    const tail = renderTokens(target.suffix).trim();
    if (target.mode === 'predicate') return tail ? `${expression}${tail === ';' ? ';' : `\n${tail}`}` : expression;
    const head = renderTokens(target.prefix).trim();
    const whereWord = (target.where && target.where.value) || 'WHERE';
    let result = `${head ? `${head} ` : ''}${whereWord.toUpperCase()}\n`;
    result += expression.split('\n').map(line => `  ${line}`).join('\n');
    if (tail) result += tail === ';' ? ';' : `\n${tail}`;
    return result;
  }

  function optimiseSql(sql, options = {}) {
    const original = sql.trim();
    if (!original) return { optimized: '', error: 'There is no SQL to optimise.', rules: [] };
    const target = extractTarget(original);
    if (target.error) return { optimized: original, error: target.error, rules: [] };

    let tree;
    try {
      tree = new BooleanParser(target.expression).parse();
    } catch (error) {
      return { optimized: original, error: error.message || 'The predicate could not be parsed.', rules: [] };
    }

    const ctx = { rules: new Map() };
    /* groupColumn is the opt-in: a column name turns the pass on, anything
       empty leaves the predicate's explicit NOT IN / <> filters alone. */
    const column = normaliseGroupColumn(options.groupColumn);
    const prepared = column ? groupByColumn(tree, ctx, column) : tree;
    /* Each pass can expose work for the others (a factored branch becomes a
       new AND, a merged set makes a sibling redundant), so run to a fixed
       point. nodeSignature is canonical, and the cap keeps it deterministic. */
    const finalTree = simplifyFixedPoint(prepared, ctx);
    const optimized = assemble(target, prettyExpression(finalTree));
    const optimizedOneLine = renderTokens(lex(optimized)).trim();
    return {
      optimized,
      optimizedOneLine,
      rules: [...ctx.rules.values()],
      inputChars: original.length,
      outputChars: optimized.length,
      inputLines: original.split('\n').length,
      outputLines: optimized.split('\n').length,
    };
  }

  /* Keep the transformation engine available to the regression tests without
     making the browser-only diff modal part of the public API. */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { lex, renderTokens, optimiseSql, layoutOnOriginal };
  }

  /* The optimiser is also loaded directly by index.html. In a non-browser
     test process there is no modal to initialise. */
  if (typeof document === 'undefined') return;

  /* ----------------------------------------------------------- modal diff */

  const modal = document.getElementById('optimizerModal');
  const code = document.getElementById('optimizerCode');
  const close = document.getElementById('optimizerClose');
  const copyNew = document.getElementById('optimizerCopyNew');
  const groupColumnButton = document.getElementById('optimizerGroupColumn');
  const groupColumnLong = groupColumnButton.querySelector('.optimizer-toggle-long');
  const groupColumnShort = groupColumnButton.querySelector('.optimizer-toggle-short');
  const addedCount = document.getElementById('optimizerAdded');
  const removedCount = document.getElementById('optimizerRemoved');
  const loading = document.getElementById('optimizerLoading');
  const loadingCopies = [...loading.querySelectorAll('.optimizer-loading-copy')];
  let lastFocus = null;
  let currentOldText = '';
  let currentNewText = '';
  let groupColumnEnabled = false;
  let groupColumn = DEFAULT_GROUP_COLUMN;

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  function coarseSequence(oldItems, newItems) {
    let prefix = 0;
    while (prefix < oldItems.length && prefix < newItems.length && oldItems[prefix] === newItems[prefix]) prefix++;
    let suffix = 0;
    while (
      suffix < oldItems.length - prefix &&
      suffix < newItems.length - prefix &&
      oldItems[oldItems.length - suffix - 1] === newItems[newItems.length - suffix - 1]
    ) suffix++;
    const oldEnd = oldItems.length - suffix;
    const newEnd = newItems.length - suffix;
    return [
      { type: 'equal', items: oldItems.slice(0, prefix) },
      { type: 'remove', items: oldItems.slice(prefix, oldEnd) },
      { type: 'add', items: newItems.slice(prefix, newEnd) },
      { type: 'equal', items: oldItems.slice(oldEnd) },
    ].filter(part => part.items.length);
  }

  /* Myers' shortest-edit diff is run over SQL tokens instead of individual
     characters. A character diff can match the "32" inside one product ID
     with the "32" inside another and then strike through unrelated commas,
     operators, or predicates. Token boundaries give repeated IDs and SQL
     punctuation a stable place to match, while whitespace stays invisible to
     the comparison. */
  /* Myers costs O(D * (N + M)) time and O(D^2) memory in the edit distance D,
     not in the length of the input, so a long predicate the optimiser barely
     touched is cheap to diff exactly. Budgeting on N * M instead gave up on
     precisely those - a 150-line predicate with two dozen parentheses removed
     fell back to the coarse diff and lost every line of the original layout.
     The budget shrinks on very long inputs so the snake walks stay bounded. */
  function distanceBudget(max) {
    return Math.min(max, Math.max(64, Math.min(3000, Math.floor(20000000 / max))));
  }

  function diffSequence(oldItems, newItems) {
    if (!oldItems.length || !newItems.length) return coarseSequence(oldItems, newItems);

    const max = oldItems.length + newItems.length;
    const budget = distanceBudget(max);
    /* Frontier keyed by diagonal, -1 for "not reached yet". A typed array
       rather than a Map because every pass snapshots the frontier for the
       backtrack, and the per-entry map overhead is what made a deep search
       unaffordable. */
    const offset = max + 1;
    const frontier = new Int32Array(2 * max + 3).fill(-1);
    frontier[1 + offset] = 0;
    const trace = [];

    for (let distance = 0; distance <= budget; distance++) {
      /* Snapshot only the diagonals the backtrack can read at this depth:
         [-distance, distance], plus the seeded diagonal 1 either side. */
      trace.push(frontier.slice(offset - distance - 1, offset + distance + 2));
      for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
        const down = frontier[diagonal + 1 + offset];
        const right = frontier[diagonal - 1 + offset];
        let x;
        if (diagonal === -distance || (diagonal !== distance && down > right)) x = down;
        else x = right + 1;
        let y = x - diagonal;
        while (x < oldItems.length && y < newItems.length && oldItems[x] === newItems[y]) { x++; y++; }
        frontier[diagonal + offset] = x;
        if (x >= oldItems.length && y >= newItems.length) {
          return backtrackSequence(trace, oldItems, newItems);
        }
      }
    }
    return coarseSequence(oldItems, newItems);
  }

  function backtrackSequence(trace, oldItems, newItems) {
    let x = oldItems.length;
    let y = newItems.length;
    const reversed = [];

    for (let distance = trace.length - 1; distance > 0; distance--) {
      const frontier = trace[distance];
      /* Diagonals outside the snapshot were never reached, same as a missing
         map key was. */
      const reached = k => (k < -distance - 1 || k > distance + 1 ? -1 : frontier[k + distance + 1]);
      const diagonal = x - y;
      const down = reached(diagonal + 1);
      const right = reached(diagonal - 1);
      const previousDiagonal = diagonal === -distance || (diagonal !== distance && down > right)
        ? diagonal + 1
        : diagonal - 1;
      const previousX = Math.max(0, reached(previousDiagonal));
      const previousY = previousX - previousDiagonal;

      while (x > previousX && y > previousY) {
        reversed.push({ type: 'equal', items: [oldItems[x - 1]] });
        x--; y--;
      }
      if (x === previousX) { reversed.push({ type: 'add', items: [newItems[y - 1]] }); y--; }
      else { reversed.push({ type: 'remove', items: [oldItems[x - 1]] }); x--; }
    }
    while (x > 0 && y > 0) { reversed.push({ type: 'equal', items: [oldItems[x - 1]] }); x--; y--; }
    while (x > 0) { reversed.push({ type: 'remove', items: [oldItems[x - 1]] }); x--; }
    while (y > 0) { reversed.push({ type: 'add', items: [newItems[y - 1]] }); y--; }

    const ordered = reversed.reverse();
    const merged = [];
    for (const part of ordered) {
      const last = merged[merged.length - 1];
      if (last && last.type === part.type) last.items.push(...part.items);
      else merged.push({ type: part.type, items: part.items.slice() });
    }
    return merged;
  }

  function tokenDiffKey(token) {
    return `${token.type}:${canonicalToken(token)}`;
  }

  /* Lay the optimised tokens back over the original text. The original is
     the skeleton: every run of tokens the optimiser left alone is copied out
     verbatim, line breaks, indentation and comments included, and only the
     runs it changed are rewritten, compactly, in place. A single-line input
     stays on one line; a multi-line input keeps every line it can. Comments
     inside a rewritten run are kept too, each on its own line. */
  function layoutOnOriginal(oldText, oldTokens, newTokens) {
    const aCode = significant(oldTokens);
    const parts = diffSequence(aCode.map(tokenDiffKey), newTokens.map(tokenDiffKey));
    const status = new Array(aCode.length);
    const addsBefore = new Map();
    let ai = 0, bi = 0;
    for (const part of parts) {
      for (let i = 0; i < part.items.length; i++) {
        if (part.type === 'equal') { status[ai++] = 'keep'; bi++; }
        else if (part.type === 'remove') status[ai++] = 'del';
        else {
          if (!addsBefore.has(ai)) addsBefore.set(ai, []);
          addsBefore.get(ai).push(newTokens[bi++]);
        }
      }
    }

    /* A removed run that could equally be its twin on the next line (the
       diff is free to strike "AND a = 1" or "a = 1 AND") is slid onto line
       boundaries, so whole lines go and the lines around them stay intact.
       Only the part of the run that has a twin moves; a stray "(" struck
       alongside it stays where it is. */
    const wsAt = oldTokens.map((t, k) => oldText.slice(k ? oldTokens[k - 1].end : 0, t.start));
    const codePos = [];
    oldTokens.forEach((t, k) => { if (t.type !== 'comment') codePos.push(k); });
    const keys = aCode.map(tokenDiffKey);
    const n = aCode.length;
    const lineStart = i => i <= 0 || i >= n || /\n/.test(wsAt[codePos[i]]);
    const addsNear = (from, to) => {
      for (let j = Math.max(0, from); j <= Math.min(n, to); j++) if (addsBefore.has(j)) return true;
      return false;
    };
    for (let pass = 0, moved = true; moved && pass < 200; pass++) {
      moved = false;
      for (let i = 0; i < n;) {
        if (status[i] !== 'del') { i++; continue; }
        let e = i;
        while (e < n && status[e] === 'del') e++;
        if (!addsNear(i - 1, e + 1)) {
          if (i > 0 && !lineStart(i) && lineStart(i - 1)) {
            for (let w = e - i; w >= 1; w--) {
              if (keys[i - 1] === keys[i + w - 1]) { status[i - 1] = 'del'; status[i + w - 1] = 'keep'; moved = true; break; }
            }
          } else if (e < n && !lineStart(e) && lineStart(e + 1)) {
            for (let w = e - i; w >= 1; w--) {
              if (keys[e] === keys[e - w]) { status[e] = 'del'; status[e - w] = 'keep'; moved = true; break; }
            }
          }
        }
        i = e;
      }
    }

    /* ------------------------------------------------- unified (one pane)
       The same diff read as a single document. The original text is copied
       out verbatim - every line, indent, comment and blank line where the
       author left it - the struck tokens stay in place, and the new tokens
       are spliced in beside them. A deleted run is flushed before the new
       text that stands in for it, so each change reads red-then-green.
       Offsets are into the merged text, which re-lexes to the same tokens
       because every splice keeps the spacing the renderer would use. */
    const unified = { text: '', removedStarts: new Set(), addedStarts: new Set() };
    {
      let prev = null;              // last token written, for spacing
      let pending = [];             // adds waiting for the deleted run to end
      let codeAt = 0;
      let cursor = 0;               // offset in oldText just after the last token
      const endsLine = t => t && t.type === 'comment' && !t.value.startsWith('/*');
      const writeAdds = list => {
        /* Anything appended to a line comment is swallowed by it. */
        if (endsLine(prev) && !/\n[ \t]*$/.test(unified.text)) unified.text += '\n';
        for (const tok of list) {
          /* The author's own break or indent was written first, so only
             add a separator when the splice would run two tokens together. */
          if (needsSpace(prev, tok) && !/\s$/.test(unified.text)) unified.text += ' ';
          unified.addedStarts.add(unified.text.length);
          unified.text += tok.value;
          prev = tok;
        }
      };
      for (let k = 0; k < oldTokens.length; k++) {
        const t = oldTokens[k];
        const ws = oldText.slice(cursor, t.start);
        if (t.type === 'comment') {
          unified.text += ws;
        } else {
          const adds = addsBefore.get(codeAt);
          if (adds) pending.push(...adds);
          const deleted = status[codeAt++] === 'del';
          unified.text += ws;
          if (!deleted && pending.length) {
            writeAdds(pending);
            pending = [];
            if (needsSpace(prev, t)) unified.text += ' ';
          }
          if (deleted) unified.removedStarts.add(unified.text.length);
        }
        unified.text += t.value;
        prev = t;
        cursor = t.end;
      }
      const trailing = addsBefore.get(aCode.length);
      if (trailing) pending.push(...trailing);
      if (pending.length) writeAdds(pending);
      unified.text += oldText.slice(cursor);
    }

    const removedStarts = new Set();
    let addedStarts = new Set();
    let removedCount = 0, addedCount = 0;
    let out = '';
    let prevOut = null;          // last token written, for spacing
    let prevKeptEnd = 0;         // offset in oldText just after the last kept token
    let outLineStart = 0;        // offset in out where the line being written began
    let region = { changed: false, comments: [], adds: [], dels: 0, runWs: null };
    let codeIndex = 0;

    /* Everything reaches out through here so outLineStart keeps up; a hoisted
       comment has to know where the line being written began. */
    const write = chunk => {
      const nl = chunk.lastIndexOf('\n');
      if (nl >= 0) outLineStart = out.length + nl + 1;
      out += chunk;
    };

    /* "\n" + indentation. Blank lines the author left between branches are
       part of the layout, so they survive a rewritten run too. */
    const lineIndent = ws => {
      const first = ws.indexOf('\n');
      return first < 0 ? ws : ws.slice(first).replace(/[ \t\r]+(?=\n)/g, '');
    };
    const isLineComment = t => !t.value.startsWith('/*');

    /* The branch a comment labelled can be folded into the line above it, and
       then the point where the comment falls due is halfway through an
       expression - inside the very IN list that swallowed it. Lift it to the
       top of that line instead, where it still reads as a label for the code
       it describes. */
    const hoistComments = comments => {
      const indent = (out.slice(outLineStart).match(/^[ \t]*/) || [''])[0];
      const text = comments.map(({ t }) => indent + t.value).join('\n') + '\n';
      out = out.slice(0, outLineStart) + text + out.slice(outLineStart);
      const shifted = new Set();
      addedStarts.forEach(at => shifted.add(at >= outLineStart ? at + text.length : at));
      addedStarts = shifted;
      outLineStart += text.length;
    };

    const emitRegion = (next, wsBefore) => {
      const leadMatch = prevOut ? oldText.slice(prevKeptEnd).match(/^[ \t\r]*\n[ \t\r\n]*/) : null;
      const lead = leadMatch ? lineIndent(leadMatch[0]) : '';
      /* Where the rewritten code would start if the region carried no
         comments: a fresh line means they still sit at a boundary and stay
         put, a continuation means they would land mid-expression. */
      const firstCodeSep = !prevOut ? ''
        : region.adds.length ? (lead && !region.dels ? lead : '')
        : next ? (/\n/.test(wsBefore) ? lineIndent(wsBefore) : lead)
        : '';
      const hoist = Boolean(region.comments.length && prevOut && !/\n/.test(firstCodeSep));
      if (hoist) hoistComments(region.comments);

      let needNl = false;
      if (!hoist) {
        for (const { t, ws } of region.comments) {
          const sep = !prevOut ? '' : /\n/.test(ws) ? lineIndent(ws) : needNl ? '\n' : ' ';
          write(sep + t.value);
          prevOut = t;
          needNl = isLineComment(t);
        }
      }
      let first = true;
      for (const tok of region.adds) {
        let sep = '';
        if (!prevOut) sep = '';
        else if (needNl) sep = '\n';
        else if (first && lead && !region.dels) sep = lead;
        else sep = needsSpace(prevOut, tok) ? ' ' : '';
        addedStarts.add(out.length + sep.length);
        addedCount += tok.value.length;
        write(sep + tok.value);
        prevOut = tok;
        needNl = false;
        first = false;
      }
      if (next) {
        let sep = '';
        if (!prevOut) sep = '';
        else if (needNl) {
          const gap = /\n/.test(wsBefore) ? wsBefore : region.runWs;
          sep = gap ? lineIndent(gap) : '\n';
        }
        else if (/\n/.test(wsBefore)) sep = lineIndent(wsBefore);
        else if (lead && !region.adds.length) sep = lead;
        else sep = needsSpace(prevOut, next) ? ' ' : '';
        write(sep);
      }
      region = { changed: false, comments: [], adds: [], dels: 0, runWs: null };
    };

    for (let k = 0; k < oldTokens.length; k++) {
      const t = oldTokens[k];
      const wsBefore = oldText.slice(k ? oldTokens[k - 1].end : 0, t.start);
      if (t.type === 'comment') { region.comments.push({ t, ws: wsBefore }); continue; }
      const adds = addsBefore.get(codeIndex);
      if (adds) { region.adds.push(...adds); region.changed = true; }
      const st = status[codeIndex++];
      if (st === 'del') {
        region.changed = true;
        region.dels++;
        /* The line break before a struck token is still part of the author's
           layout: it is the only record of a blank line that sat between a
           comment block and the branch below it. */
        if (/\n/.test(wsBefore)) region.runWs = wsBefore;
        removedStarts.add(t.start);
        removedCount += t.value.length;
        continue;
      }
      if (!region.changed) {
        write(oldText.slice(prevKeptEnd, t.start));        // untouched: verbatim
        region.comments = [];
      } else {
        emitRegion(t, wsBefore);
      }
      write(t.value);
      prevOut = t;
      prevKeptEnd = t.end;
    }
    const tailAdds = addsBefore.get(aCode.length);
    if (tailAdds) { region.adds.push(...tailAdds); region.changed = true; }
    if (!region.changed) write(oldText.slice(prevKeptEnd));
    else emitRegion(null, '');

    return { text: out, removedStarts, addedStarts, removedCount, addedCount, unified };
  }

  /* Syntax colouring with the same classes as the editor panes. The viewer
     hands over its keyword, function and literal lists when it opens the
     modal; without them every word is an identifier. markOf returns the mark
     class for a token start, or '' - the plain spaces between two tokens
     marked the same way join one <mark>, so a rewritten predicate reads as a
     single change, but a line break or a switch from struck to new always
     ends it. */
  let style = { keywords: new Set(), functions: new Set(), literals: new Set() };

  function tokenClass(t, tokens, i, state) {
    switch (t.type) {
      case 'paren':
        if (t.value === '(') return `p b${(state.depth++) % 3}`;
        state.depth = Math.max(0, state.depth - 1);
        return `p b${state.depth % 3}`;
      case 'comment': return 't-com';
      case 'str': return 't-str';
      case 'qid': return t.value[0] === '[' ? 't-id' : 't-qid';
      case 'num': return 't-num';
      case 'comma': case 'semi': return 't-punct';
      case 'op': return 't-op';
      default: {
        const u = t.value.toUpperCase();
        if (style.literals.has(u)) return 't-lit';
        let next = null;
        for (let j = i + 1; j < tokens.length; j++) {
          if (tokens[j].type !== 'comment') { next = tokens[j]; break; }
        }
        if (next && next.type === 'paren' && next.value === '(' && style.functions.has(u)) return 't-fn';
        if (style.keywords.has(u)) return 't-kw';
        return 't-id';
      }
    }
  }

  /* One <div class="oline"> per line so the panes can number them; a token
     that spans lines (a block comment) is split across rows, and a mark is
     closed at the row edge and reopened on the next one. */
  function highlightHtml(text, tokens, markOf) {
    let html = '<div class="oline">', pos = 0, openClass = null, empty = true;
    const state = { depth: 0 };
    const close = () => { if (openClass) { html += '</mark>'; openClass = null; } };
    const newline = () => { close(); html += (empty ? '<br>' : '') + '</div><div class="oline">'; empty = true; };
    const emitPlain = str => {
      str.split('\n').forEach((piece, i) => {
        if (i) newline();
        if (piece) { html += escapeHtml(piece); empty = false; }
      });
    };
    tokens.forEach((t, i) => {
      const ws = text.slice(pos, t.start);
      const hit = markOf(t.start);
      if (ws) {
        if (openClass && (hit !== openClass || /\n/.test(ws))) close();
        emitPlain(ws);
      }
      const cls = tokenClass(t, tokens, i, state);
      if (hit && hit !== openClass) { close(); html += `<mark class="${hit}">`; openClass = hit; }
      else if (!hit) close();
      t.value.split('\n').forEach((piece, j) => {
        if (j) {
          const was = openClass;
          newline();
          if (was) { html += `<mark class="${was}">`; openClass = was; }
        }
        if (piece) { html += `<span class="${cls}">${escapeHtml(piece)}</span>`; empty = false; }
      });
      /* Keep long comma-separated lists readable without adding whitespace
         to either copied SQL value. */
      if (t.type === 'comma') html += '<wbr>';
      pos = t.end;
    });
    close();
    emitPlain(text.slice(pos));
    html += (empty ? '<br>' : '') + '</div>';
    return html;
  }

  function fitGutter(pre, text) {
    const digits = String(text.split('\n').length).length;
    pre.style.setProperty('--ogut', `${digits + 2.5}ch`);
  }

  function updateGroupColumnButton() {
    groupColumnButton.setAttribute('aria-pressed', String(groupColumnEnabled));
    groupColumnLong.textContent = `Group by ${groupColumn}`;
    groupColumnShort.textContent = groupColumn;
    const label = `Group by ${groupColumn} conditions`;
    groupColumnButton.title = label;
    groupColumnButton.setAttribute('aria-label', label);
  }

  const noChange = text => ({
    text, removedCount: 0, addedCount: 0,
    unified: { text, removedStarts: new Set(), addedStarts: new Set() },
  });

  function paintOptimizedSql() {
    const result = optimiseSql(currentOldText, { groupColumn: groupColumnEnabled ? groupColumn : '' });
    const laid = result.error
      ? noChange(currentOldText)
      : layoutOnOriginal(currentOldText, lex(currentOldText), significant(lex(result.optimizedOneLine || result.optimized)));
    /* What the pane shows is the merge; what it copies is only the new side. */
    currentNewText = laid.text;
    const merged = laid.unified;
    code.innerHTML = highlightHtml(merged.text, lex(merged.text), at =>
      (merged.removedStarts.has(at) ? 'diff-removed' : merged.addedStarts.has(at) ? 'diff-added' : ''));
    fitGutter(code, merged.text);
    addedCount.textContent = `+${laid.addedCount}`;
    removedCount.textContent = `-${laid.removedCount}`;
  }

  /* The pane cannot be empty while the transform runs, and the only text that
     exists at that point is the SQL that was handed over. Enough lines to
     overfill the pane, held twice, so the scroll can loop without a seam. */
  const LOADING_LINES = 64;

  function startLoading() {
    const lines = currentOldText ? currentOldText.split('\n') : [''];
    const sample = [];
    while (sample.length < LOADING_LINES) sample.push(...lines);
    const text = sample.slice(0, LOADING_LINES).join('\n');
    loadingCopies.forEach(copy => { copy.textContent = text; });
    loading.hidden = false;
    modal.classList.add('is-optimising');
    code.setAttribute('aria-busy', 'true');
    /* Nothing to copy yet, and a second transform cannot be queued on top. */
    copyNew.disabled = true;
    groupColumnButton.disabled = true;
  }

  function stopLoading() {
    loading.hidden = true;
    loadingCopies.forEach(copy => { copy.textContent = ''; });
    modal.classList.remove('is-optimising');
    code.removeAttribute('aria-busy');
    copyNew.disabled = false;
    groupColumnButton.disabled = false;
  }

  /* Opening waits for nothing: the overlay is on screen in the frame the click
     lands in, and the parse, rewrite and diff behind it - which grow with the
     SQL, and on a long query are felt - start only once it has been painted. */
  let renderRun = 0;

  function renderOptimizedSql() {
    const run = ++renderRun;
    startLoading();
    /* Two frames: the first paints the overlay and the loop, the second is
       free to block for however long the transform takes. */
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (run !== renderRun) return;
      /* The overlay now opens on SQL the checker has not passed, so the
         transform can meet anything. Whatever it makes of it, the loop stops:
         a stuck placeholder would be the one failure with no way out. */
      try { paintOptimizedSql(); } finally { stopLoading(); }
    }));
  }

  function show(sql) {
    currentOldText = String(sql || '').trim();
    currentNewText = '';
    groupColumnEnabled = false;
    updateGroupColumnButton();
    /* Whatever was optimised last must not sit behind the loop as if it were
       this query's answer. */
    code.innerHTML = '';
    addedCount.textContent = '+0';
    removedCount.textContent = '-0';
    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('optimizer-is-open');
    lastFocus = document.activeElement;
    code.focus();
    renderOptimizedSql();
  }

  function hide() {
    /* A run still waiting on its frames would otherwise paint into a closed
       overlay, or land on whatever is opened next. */
    renderRun++;
    stopLoading();
    modal.hidden = true;
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('optimizer-is-open');
    if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
  }

  function selectAll() {
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(code);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  /* Struck tokens are user-select:none, so a drag already skips them and the
     browser's own copy of a partial selection is right. A selection covering
     the whole pane is a different intent - "give me the result" - and the
     marks alone cannot express it, because the whitespace between a kept and
     a struck token is selectable and the layout differs anyway. So a
     select-all copy hands over exactly what the copy button does. */
  function wholePaneSelected() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return false;
    const range = selection.getRangeAt(0);
    if (!code.contains(range.commonAncestorContainer)) return false;
    const all = document.createRange();
    all.selectNodeContents(code);
    return range.compareBoundaryPoints(Range.START_TO_START, all) <= 0
      && range.compareBoundaryPoints(Range.END_TO_END, all) >= 0;
  }

  /* The button carries three faces - copy, tick, cross - and CSS crossfades
     between them off data-state. Only the state and the screen-reader line
     change here; nothing rewrites the label text. */
  const COPY_RESET_MS = 2000;
  let copyResetTimer = null;

  function setCopyState(button, state) {
    button.dataset.state = state;
    const live = button.querySelector('[role="status"]');
    if (live) live.textContent = state === 'copied' ? 'Copied' : state === 'error' ? 'Copy failed' : '';
    clearTimeout(copyResetTimer);
    if (state !== 'idle') copyResetTimer = setTimeout(() => setCopyState(button, 'idle'), COPY_RESET_MS);
  }

  async function copySql(text, button) {
    let ok = true;
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      /* No clipboard permission: select the pane and let the copy handler
         below substitute the optimised SQL for what is on screen. */
      try {
        selectAll();
        ok = document.execCommand('copy');
        window.getSelection().removeAllRanges();
      } catch (__) {
        ok = false;
      }
    }
    setCopyState(button, ok ? 'copied' : 'error');
  }

  /* ---- double click selects one word, exactly as the panes behind do ---- */

  /* The same word separators the editor panes use. Chrome's own
     breaker reads "119410,119422" as one number - comma and all - and reaches
     past a closing bracket for the line break behind it, so a double click in
     here would take something a double click in the source pane never would. */
  const SELECT_WORD_BREAK = '`~!@#$%^&*()-=+[{]}\\|;:\'",.<>/?';
  const isSelectWordChar = ch => ch > ' ' && !SELECT_WORD_BREAK.includes(ch);

  /* One rendered line's text, with the text node every character came from.
     Struck runs are mapped too but flagged: they are user-select:none, so a
     drag skips them and a double click must not reach into them either. */
  function lineMap(row) {
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    const parts = [];
    let text = '', node;
    while ((node = walker.nextNode())) {
      const value = node.nodeValue;
      if (!value) continue;
      parts.push({
        node, at: text.length, len: value.length,
        selectable: !node.parentElement.closest('.diff-removed'),
      });
      text += value;
    }
    return { text, parts };
  }

  function selectableAt(map, col) {
    for (const part of map.parts) {
      if (col >= part.at && col < part.at + part.len) return part.selectable;
    }
    return false;
  }

  /* Column -> the DOM point a range boundary goes at. */
  function pointAt(map, col) {
    for (const part of map.parts) {
      if (col <= part.at + part.len) return { node: part.node, offset: col - part.at };
    }
    return null;
  }

  /* A collapsed range at that column, for measuring where the character sits. */
  function caretRect(map, col) {
    const point = pointAt(map, col);
    if (!point) return null;
    const range = document.createRange();
    range.setStart(point.node, point.offset);
    range.collapse(true);
    return range.getBoundingClientRect();
  }

  /* Which character the pointer is over, as a column in the line it is on. The
     caret the browser would leave behind cannot answer that: it snaps to the
     nearer boundary, so pressing on `)` and on the character in front of it
     both land on the offset between them - fine for a word, wrong for picking
     out one bracket. The line boxes are the real layout, so read it off them.
     Returns null above, below or past the end of the text. */
  function characterAtPoint(clientX, clientY) {
    const rows = code.children;
    let lo = 0, hi = rows.length - 1, row = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = rows[mid].getBoundingClientRect();
      if (clientY < r.top) hi = mid - 1;
      else if (clientY >= r.bottom) lo = mid + 1;
      else { row = mid; break; }
    }
    if (row < 0) return null;

    const rowEl = rows[row];
    const map = lineMap(rowEl);
    if (!map.parts.length) return null;                 // a blank line: only a <br>
    const rowTop = rowEl.getBoundingClientRect().top;
    const lh = parseFloat(getComputedStyle(code).lineHeight);
    const wrapped = Math.max(0, Math.floor((clientY - rowTop) / lh));

    /* Character boundaries run left to right within a wrapped row and top to
       bottom between them, so they are ordered and can be searched. The last
       boundary at or before the pointer is where the character under it
       starts. */
    const atOrBefore = col => {
      const r = caretRect(map, col);
      if (!r) return false;
      const line = Math.round((r.top - rowTop) / lh);
      return line < wrapped || (line === wrapped && r.left <= clientX);
    };
    lo = 0; hi = map.text.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (atOrBefore(mid)) lo = mid; else hi = mid - 1;
    }
    return { map, col: lo };
  }

  /* What a double click on that character should take. A word if it is part of
     one, and otherwise just itself: a separator is its own word, so clicking a
     bracket takes that bracket. Whitespace is left to the browser, which
     already selects the run of it and has nothing to get wrong. A word never
     grows into struck text, so a rewritten value sitting against the one it
     replaced still gives one word per click. */
  function doubleClickRange(map, at) {
    const ch = map.text[at];
    if (ch === undefined || ch <= ' ') return null;
    if (!isSelectWordChar(ch)) return [at, at + 1];
    let start = at, end = at + 1;
    while (start > 0 && isSelectWordChar(map.text[start - 1]) && selectableAt(map, start - 1)) start--;
    while (end < map.text.length && isSelectWordChar(map.text[end]) && selectableAt(map, end)) end++;
    return [start, end];
  }

  /* The browser widens the selection on the second mousedown. Correcting that
     on dblclick means correcting it on mouseup, so the wrong word stays on
     screen for as long as the button is held down; a frame callback instead
     runs in the rendering steps, before the browser paints, and the wider word
     is never actually shown.

     The default is deliberately left to run. Preventing it would take the
     wrong word off the screen too, but it also cancels double-click-drag -
     holding the button after the second click and pulling down to extend the
     selection - and that is the browser's to do, not ours. */
  code.addEventListener('mousedown', event => {
    if (event.button !== 0 || event.detail !== 2) return;
    const selection = window.getSelection();
    if (!selection || !selection.isCollapsed) return;   // the pair began as a drag
    const hit = characterAtPoint(event.clientX, event.clientY);
    if (!hit) return;
    if (!selectableAt(hit.map, hit.col)) return;        // struck text is scenery
    const take = doubleClickRange(hit.map, hit.col);
    if (!take) return;                    // on whitespace: let the browser decide

    /* Once the pointer starts moving the selection belongs to the drag, not to
       the browser's guess at a word, so leave it alone. A drag that creeps off
       slowly enough to be missed here corrects itself: the next mousemove
       overwrites whatever this put back. */
    const stop = new AbortController();
    let dragged = false;
    window.addEventListener('mousemove', m => {
      if (Math.abs(m.clientX - event.clientX) > 2 || Math.abs(m.clientY - event.clientY) > 2) dragged = true;
    }, { capture: true, signal: stop.signal });
    window.addEventListener('mouseup', () => stop.abort(), { capture: true, signal: stop.signal });

    requestAnimationFrame(() => {
      stop.abort();
      if (dragged) return;
      const from = pointAt(hit.map, take[0]), to = pointAt(hit.map, take[1]);
      if (!from || !to) return;
      const range = document.createRange();
      range.setStart(from.node, from.offset);
      range.setEnd(to.node, to.offset);
      const live = window.getSelection();
      if (!live) return;
      const current = live.rangeCount === 1 ? live.getRangeAt(0) : null;
      if (current
        && current.compareBoundaryPoints(Range.START_TO_START, range) === 0
        && current.compareBoundaryPoints(Range.END_TO_END, range) === 0) return;
      live.removeAllRanges();
      live.addRange(range);
    });
  });

  window.addEventListener('sqlviewer-open-optimizer', event => {
    const detail = event.detail || {};
    if (Array.isArray(detail.commentMarkers)) lineCommentMarkers = detail.commentMarkers.slice();
    if (detail.style) style = detail.style;
    groupColumn = String(detail.groupColumn || '').trim() || DEFAULT_GROUP_COLUMN;
    show(detail.sql);
  });
  close.addEventListener('click', hide);
  close.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); hide(); }
  });
  copyNew.addEventListener('click', () => copySql(currentNewText, copyNew));
  groupColumnButton.addEventListener('click', () => {
    groupColumnEnabled = !groupColumnEnabled;
    updateGroupColumnButton();
    renderOptimizedSql();
  });
  modal.addEventListener('click', event => { if (event.target === modal) hide(); });
  document.addEventListener('keydown', event => {
    if (modal.hidden) return;
    if (event.key === 'Escape') { hide(); return; }
    /* Ctrl+A would otherwise select the page behind the overlay. */
    if ((event.ctrlKey || event.metaKey) && !event.altKey && (event.key === 'a' || event.key === 'A')) {
      event.preventDefault();
      selectAll();
    }
  });
  document.addEventListener('copy', event => {
    if (modal.hidden || !wholePaneSelected() || !event.clipboardData) return;
    event.preventDefault();
    event.clipboardData.setData('text/plain', currentNewText);
  });
})();
