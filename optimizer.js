/* SQL Viewer - conservative, readability-first boolean predicate optimiser. */

(() => {
  'use strict';

  const CLAUSE_STOP = new Set([
    'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'INTERSECT', 'EXCEPT',
    'RETURNING', 'WINDOW', 'QUALIFY', 'FETCH', 'FOR', 'OPTION'
  ]);
  const COMPARATORS = new Set(['=', '!=', '<>', '<=>', '<', '<=', '>', '>=']);
  const OPS2 = ['<=>', '<=', '>=', '<>', '!=', '||', '&&', '::', ':=', '->', '=>', '<<', '>>'];
  const OPS3 = ['<=>'];

  /* --------------------------------------------------------------- lexer */

  function isWordStart(c) {
    if (!c) return false;
    const code = c.charCodeAt(0);
    return /[A-Za-z_@$]/.test(c) || code > 127;
  }

  function isWordChar(c) {
    if (!c) return false;
    const code = c.charCodeAt(0);
    return /[A-Za-z0-9_@$#]/.test(c) || code > 127;
  }

  function pushToken(out, type, value, start, end) {
    out.push({ type, value, start, end });
  }

  function lex(sql) {
    const out = [];
    let i = 0;

    while (i < sql.length) {
      const c = sql[i];

      if (/\s/.test(c)) { i++; continue; }

      if ((c === '-' && sql[i + 1] === '-') || c === '#') {
        const start = i;
        let end = sql.indexOf('\n', i);
        if (end < 0) end = sql.length;
        pushToken(out, 'comment', sql.slice(start, end), start, end);
        i = end;
        continue;
      }

      if (c === '/' && sql[i + 1] === '*') {
        const start = i;
        let end = sql.indexOf('*/', i + 2);
        end = end < 0 ? sql.length : end + 2;
        pushToken(out, 'comment', sql.slice(start, end), start, end);
        i = end;
        continue;
      }

      if (c === "'" || c === '"' || c === '`' || c === '[') {
        const start = i;
        const close = c === '[' ? ']' : c;
        i++;
        while (i < sql.length) {
          if (sql[i] === '\\' && c !== '`' && c !== '[') { i += 2; continue; }
          if (sql[i] === close) {
            if (sql[i + 1] === close && c !== '[') { i += 2; continue; }
            i++;
            break;
          }
          i++;
        }
        pushToken(out, c === '`' || c === '[' ? 'qid' : 'str', sql.slice(start, i), start, i);
        continue;
      }

      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(sql[i + 1] || ''))) {
        const start = i;
        if (c === '0' && (sql[i + 1] === 'x' || sql[i + 1] === 'X')) {
          i += 2;
          while (/[0-9a-fA-F]/.test(sql[i] || '')) i++;
        } else {
          while (/[0-9.]/.test(sql[i] || '')) i++;
          if (sql[i] === 'e' || sql[i] === 'E') {
            let j = i + 1;
            if (sql[j] === '+' || sql[j] === '-') j++;
            if (/[0-9]/.test(sql[j] || '')) {
              i = j + 1;
              while (/[0-9]/.test(sql[i] || '')) i++;
            }
          }
        }
        pushToken(out, 'num', sql.slice(start, i), start, i);
        continue;
      }

      if (isWordStart(c)) {
        const start = i++;
        while (isWordChar(sql[i])) i++;
        pushToken(out, 'word', sql.slice(start, i), start, i);
        continue;
      }

      if (c === '(' || c === ')') { pushToken(out, 'paren', c, i, i + 1); i++; continue; }
      if (c === ',') { pushToken(out, 'comma', c, i, i + 1); i++; continue; }
      if (c === ';') { pushToken(out, 'semi', c, i, i + 1); i++; continue; }

      const three = sql.slice(i, i + 3), two = sql.slice(i, i + 2);
      if (OPS3.includes(three)) { pushToken(out, 'op', three, i, i + 3); i += 3; continue; }
      if (OPS2.includes(two)) { pushToken(out, 'op', two, i, i + 2); i += 2; continue; }
      pushToken(out, 'op', c, i, i + 1);
      i++;
    }
    return out;
  }

  function significant(tokens) {
    return tokens.filter(t => t.type !== 'comment');
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
    return significant(tokens).map(t => {
      if (t.type === 'qid') return `word:${identifierName(t).toUpperCase()}`;
      if (t.type === 'str') return `str:${stringLiteralName(t.value).toUpperCase()}`;
      return `${t.type}:${canonicalToken(t)}`;
    }).join('|');
  }

  function needsSpace(prev, cur, compact = false) {
    if (!prev) return false;
    if (cur.type === 'comma' || cur.type === 'semi' || (cur.type === 'paren' && cur.value === ')')) return false;
    if (prev.type === 'paren' && prev.value === '(') return false;
    if (cur.value === '.' || prev.value === '.') return false;
    if (cur.type === 'paren' && cur.value === '(' && (prev.type === 'word' || prev.type === 'qid') && !/^(IN|EXISTS|WHERE|NOT|AND|OR|ON|FROM|SELECT|VALUES|AS|CASE)$/i.test(prev.value)) return false;
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

    matchWord(word) {
      const token = this.peek();
      if (token && token.type === 'word' && token.value.toUpperCase() === word) {
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
        if (token.type === 'word') {
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
    if (node.kind === 'atom') return `a:${tokenKey(node.tokens)}`;
    if (node.kind === 'const') return node.value ? 'true' : 'false';
    if (node.kind === 'not') return `not(${nodeSignature(node.child)})`;
    const parts = node.children.map(nodeSignature).sort();
    return `${node.kind}(${parts.join(',')})`;
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
    prodid: { title: 'Grouped prodid conditions', detail: 'Literal prodid filters were collected into one positive override and one global exclusion.' },
  };

  function addRule(ctx, key) {
    if (!ctx.rules.has(key)) ctx.rules.set(key, RULES[key]);
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
    if (token.type === 'word' && /^(TRUE|FALSE|NULL)$/i.test(token.value)) return { tokens: [token], next: index + 1 };
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

  function valueComparable(value) {
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
      if (strong.kind === 'notSet') return weak.values.every(w => strong.values.some(s => equalityValue(s, w)));
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
      if (weak.kind === 'set') return weak.values.some(v => equalityValue(strong.value, v));
      if (weak.kind === 'lower' || weak.kind === 'upper') return satisfies(strong.value, weak.op, weak.value) === true;
      if (weak.kind === 'range') return satisfies(strong.value, weak.lower.op, weak.lower.value) === true && satisfies(strong.value, weak.upper.op, weak.upper.value) === true;
      return false;
    }
    if (strong.kind === 'set') {
      if (weak.kind === 'set') return strong.values.every(s => weak.values.some(w => equalityValue(s, w)));
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

  function nodeImplies(stronger, weaker) {
    if (nodeSignature(stronger) === nodeSignature(weaker)) return true;
    const strongTerms = nodeTerms(stronger);
    const weakTerms = nodeTerms(weaker);
    if (!strongTerms || !weakTerms) return false;

    const strongConstraints = strongTerms.map(term => parseConstraint(term)).filter(Boolean);
    for (const weakTerm of weakTerms) {
      const weakConstraint = parseConstraint(weakTerm);
      if (weakConstraint) {
        if (!strongConstraints.some(strong => constraintImplies(strong, weakConstraint))) return false;
      } else if (!strongTerms.some(term => nodeSignature(term) === nodeSignature(weakTerm))) {
        return false;
      }
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

  function valueListDifference(values, removed) {
    return values.filter(value => !removed.some(other => equalityValue(value, other)));
  }

  function valueListIntersection(left, right) {
    return left.filter(value => right.some(other => equalityValue(value, other)));
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
    return left.length === right.length && left.every(value => right.some(other => equalityValue(value, other)));
  }

  function exclusionNodes(fieldTokens, values, state) {
    if (values === null) return state.nodes;
    if (!values.length) return [];
    if (state.single && sameValueSet(state.single.values, values)) return [state.single.node];
    return [makeSetAtom(fieldTokens, values, true)];
  }

  /* ------------------------------------------------------ prodid grouping */

  /* The regular constraint simplifier intentionally leaves NOT IN, <> and !=
     alone. This optional pass extracts those explicit literal prodid filters
     as manual OR overrides; arbitrary SQL is left untouched. */

  function isProdidField(field) {
    const last = field && field.tokens && field.tokens[field.tokens.length - 1];
    return identifierName(last).toUpperCase() === 'PRODID';
  }

  function hasNullValue(values) {
    return values.some(value => value.tokens.length === 1 && value.tokens[0].type === 'word' && value.tokens[0].value.toUpperCase() === 'NULL');
  }

  function parseProdidConstraint(node) {
    if (!node || node.kind !== 'atom') return null;
    const tokens = significant(node.tokens);
    const field = fieldAt(tokens);
    if (!field || !isProdidField(field)) return null;

    let index = field.next;
    const operator = tokens[index];
    if (!operator) return null;
    const word = operator.type === 'word' ? operator.value.toUpperCase() : operator.value;

    if (word === 'IN' || (word === 'NOT' && tokens[index + 1] && tokens[index + 1].type === 'word' && tokens[index + 1].value.toUpperCase() === 'IN')) {
      const negative = word === 'NOT';
      const list = parseList(tokens, index + (negative ? 2 : 1));
      if (!list || list.next !== tokens.length || !list.values.length || hasNullValue(list.values)) return null;
      return prodidCondition(negative ? 'negative' : 'positive', { field: field.key, fieldTokens: field.tokens }, list.values);
    }

    if (word !== '=' && word !== '<>' && word !== '!=') return null;
    const value = literalAt(tokens, index + 1);
    if (!value || value.next !== tokens.length || value.tokens[0].type === 'word' && value.tokens[0].value.toUpperCase() === 'NULL') return null;
    return prodidCondition(word === '=' ? 'positive' : 'negative', { field: field.key, fieldTokens: field.tokens }, [{ tokens: value.tokens, key: tokenKey(value.tokens) }]);
  }

  function valueListUnique(values) {
    const out = [];
    values.forEach(value => {
      if (!out.some(existing => equalityValue(existing, value))) out.push(value);
    });
    return out;
  }

  function valueListUnion(left, right) {
    return valueListUnique([...left, ...right]);
  }

  function prodidCondition(kind, source, values = []) {
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

  function makeProdidSetAtom(condition) {
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

  /* Remove recognized prodid predicates from the clean expression. A branch
     containing only prodid predicates has no clean counterpart, so it returns
     null instead of becoming TRUE. Both positive manual overrides and
     negative exclusions are collected from every boolean branch so grouped
     mode emits one global IN and one global NOT IN. NOT expressions are left
     intact because their prodid predicate is not an explicit form of this
     toggle. */
  function stripProdidConditions(node, collected) {
    if (node.kind === 'atom') {
      const condition = parseProdidConstraint(node);
      if (condition) { collected.push(condition); return null; }
      return node;
    }
    if (node.kind === 'const' || node.kind === 'not') return node;

    const children = node.children.map(child => {
      const mark = collected.length;
      const result = stripProdidConditions(child, collected);
      const tookPositive = result === null && collected.slice(mark).some(condition => condition.kind === 'positive');
      return { result, tookPositive };
    });
    /* An AND that lost a positive prodid list is dropped whole. Its rows are a
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

  function groupProdid(node, ctx) {
    const collected = [];
    const clean = stripProdidConditions(node, collected);
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
      if (group.positive.length) positiveConditions.push(prodidCondition('positive', group, group.positive));
      if (group.negative.length) negativeConditions.push(prodidCondition('negative', group, group.negative));
    });

    const positiveParts = clean ? [clean] : [];
    positiveConditions.forEach(condition => positiveParts.push(makeProdidSetAtom(condition)));
    const positiveTree = positiveParts.length ? combineLogicNodes('or', positiveParts) : null;
    const negativeNodes = negativeConditions.map(makeProdidSetAtom);
    addRule(ctx, 'prodid');
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
        allowed = allowed ? allowed.filter(old => c.values.some(next => equalityValue(old, next))) : c.values.slice();
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
      if (excluded && valueComparable(eq.value) !== null && excluded.some(value => equalityValue(eq.value, value))) {
        addRule(ctx, 'impossible');
        return { impossible: true };
      }
      if (allowed && !allowed.some(value => equalityValue(eq.value, value))) {
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
      const children = raw.map(child =>
        simplify(child, ctx, !env || child.kind === 'atom' ? env : env.concat(local)));
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
    if (node.kind === 'atom') return significant(node.tokens).length;
    if (node.kind === 'not') return 1 + nodeCost(node.child) + (node.child.kind === 'and' || node.child.kind === 'or' ? 2 : 0);
    return node.children.reduce(
      (total, child) => total + nodeCost(child) + (node.kind === 'and' && child.kind === 'or' ? 2 : 0),
      node.children.length - 1,
    );
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
    for (let i = 0; i < children.length; i++) {
      if (children[i].kind !== 'or') continue;
      if (children[i].children.some(option => children.some((other, j) => j !== i && nodeImplies(other, option)))) covered.add(i);
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
    const negativeLists = [];

    for (const entry of entries) {
      const constraint = entry.constraint;
      if (constraint.kind === 'notSet') { negativeLists.push(constraint.values); continue; }
      const values = constraint.kind === 'eq' ? [constraint.value] : constraint.values;
      values.forEach(value => {
        if (!positives.some(existing => equalityValue(existing, value))) positives.push(value);
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

    const remove = new Set();
    for (let i = 0; i < children.length; i++) {
      if (remove.has(i)) continue;
      for (let j = 0; j < children.length; j++) {
        if (i === j || remove.has(i) || remove.has(j)) continue;
        if (nodeImplies(children[i], children[j])) {
          remove.add(i); addRule(ctx, 'covered');
        }
      }
    }
    if (remove.size) children = children.filter((_, index) => !remove.has(index));

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
    const finalRemove = new Set();
    for (let i = 0; i < children.length; i++) {
      for (let j = 0; j < children.length; j++) {
        if (i === j || finalRemove.has(i)) continue;
        if (nodeImplies(children[i], children[j])) { finalRemove.add(i); addRule(ctx, 'covered'); }
      }
    }
    if (finalRemove.size) children = children.filter((_, index) => !finalRemove.has(index));
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
    const prepared = options.groupProdid ? groupProdid(tree, ctx) : tree;
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
    module.exports = { lex, renderTokens, optimiseSql };
  }

  /* The optimiser is also loaded directly by index.html. In a non-browser
     test process there is no modal to initialise. */
  if (typeof document === 'undefined') return;

  /* ----------------------------------------------------------- modal diff */

  const modal = document.getElementById('optimizerModal');
  const oldCode = document.getElementById('optimizerOld');
  const newCode = document.getElementById('optimizerNew');
  const close = document.getElementById('optimizerClose');
  const copyOld = document.getElementById('optimizerCopyOld');
  const copyNew = document.getElementById('optimizerCopyNew');
  const groupProdidButton = document.getElementById('optimizerGroupProdid');
  const addedCount = document.getElementById('optimizerAdded');
  const removedCount = document.getElementById('optimizerRemoved');
  let lastFocus = null;
  let currentOldText = '';
  let currentNewText = '';
  let groupProdidEnabled = false;

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
  function diffSequence(oldItems, newItems) {
    if (!oldItems.length || !newItems.length) return coarseSequence(oldItems, newItems);
    if (oldItems.length * newItems.length > 8000000 || oldItems.length + newItems.length > 6000) {
      return coarseSequence(oldItems, newItems);
    }

    const max = oldItems.length + newItems.length;
    const trace = [];
    let frontier = new Map([[1, 0]]);

    for (let distance = 0; distance <= max; distance++) {
      trace.push(new Map(frontier));
      for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
        const down = frontier.get(diagonal + 1) ?? -1;
        const right = frontier.get(diagonal - 1) ?? -1;
        let x;
        if (diagonal === -distance || (diagonal !== distance && down > right)) x = down;
        else x = right + 1;
        let y = x - diagonal;
        while (x < oldItems.length && y < newItems.length && oldItems[x] === newItems[y]) { x++; y++; }
        frontier.set(diagonal, x);
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
      const diagonal = x - y;
      const down = frontier.get(diagonal + 1) ?? -1;
      const right = frontier.get(diagonal - 1) ?? -1;
      const previousDiagonal = diagonal === -distance || (diagonal !== distance && down > right)
        ? diagonal + 1
        : diagonal - 1;
      const previousX = frontier.get(previousDiagonal) ?? 0;
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

  /* Lexer offsets are UTF-16 offsets, while Array.from() gives us code-point
     indexes for safe rendering. Convert the token ranges once so a non-ASCII
     string literal cannot shift every mark after it by one position. */
  function tokenCharRanges(text, tokens) {
    const chars = Array.from(text);
    const ranges = [];
    let unitOffset = 0;
    let charOffset = 0;

    for (const token of tokens) {
      while (charOffset < chars.length && unitOffset < token.start) {
        unitOffset += chars[charOffset].length;
        charOffset++;
      }
      const start = charOffset;
      while (charOffset < chars.length && unitOffset < token.end) {
        unitOffset += chars[charOffset].length;
        charOffset++;
      }
      ranges.push({ start, end: charOffset });
    }
    return ranges;
  }

  function markTokenRange(marks, range) {
    for (let index = range.start; index < range.end; index++) marks.add(index);
  }

  /* Join adjacent changed tokens with their plain horizontal whitespace. It
     makes a removed predicate read as one Diffchecker-style change, but it
     never paints a newline and it never treats whitespace alone as a change.
     In particular, `IN (32,323)` and `IN (32, 323)` have identical tokens and
     therefore produce no marks at all. */
  function bridgeChangedWhitespace(chars, marks) {
    const bridged = new Set(marks);
    let index = 0;
    while (index < chars.length) {
      if (chars[index] !== ' ' && chars[index] !== '\t') { index++; continue; }
      const start = index;
      while (index < chars.length && (chars[index] === ' ' || chars[index] === '\t')) index++;
      if (start > 0 && index < chars.length && marks.has(start - 1) && marks.has(index)) {
        for (let space = start; space < index; space++) bridged.add(space);
      }
    }
    return bridged;
  }

  function charDiff(oldText, newText) {
    const oldChars = Array.from(oldText);
    const newChars = Array.from(newText);

    const oldTokens = lex(oldText);
    const newTokens = lex(newText);
    const oldRanges = tokenCharRanges(oldText, oldTokens);
    const newRanges = tokenCharRanges(newText, newTokens);
    const parts = diffSequence(oldTokens.map(tokenDiffKey), newTokens.map(tokenDiffKey));
    const oldRemoved = new Set();
    const newAdded = new Set();
    let oldAt = 0, newAt = 0;

    for (const part of parts) {
      const itemCount = part.items.length;
      if (part.type === 'equal') { oldAt += itemCount; newAt += itemCount; continue; }
      if (part.type === 'remove') {
        for (let i = 0; i < itemCount; i++) markTokenRange(oldRemoved, oldRanges[oldAt + i]);
        oldAt += itemCount;
      } else {
        for (let i = 0; i < itemCount; i++) markTokenRange(newAdded, newRanges[newAt + i]);
        newAt += itemCount;
      }
    }

    const markText = (chars, marks, className) => {
      const visualMarks = bridgeChangedWhitespace(chars, marks);
      let html = '', marked = false;
      chars.forEach((char, index) => {
        const shouldMark = visualMarks.has(index);
        if (shouldMark && !marked) { html += `<mark class="${className}">`; marked = true; }
        if (!shouldMark && marked) { html += '</mark>'; marked = false; }
        html += escapeHtml(char);
        /* Keep long comma-separated lists readable without adding whitespace
           to either copied SQL value. */
        if (char === ',') html += '<wbr>';
      });
      if (marked) html += '</mark>';
      return html || '<br>';
    };

    return {
      oldHtml: markText(oldChars, oldRemoved, 'diff-removed'),
      newHtml: markText(newChars, newAdded, 'diff-added'),
      removedCount: [...oldRemoved].filter(index => !/\s/.test(oldChars[index])).length,
      addedCount: [...newAdded].filter(index => !/\s/.test(newChars[index])).length,
    };
  }

  function compactSql(sql) {
    return renderTokens(lex(sql), { compact: true }).trim();
  }

  function updateGroupProdidButton() {
    groupProdidButton.setAttribute('aria-pressed', String(groupProdidEnabled));
  }

  function renderOptimizedSql() {
    const result = optimiseSql(currentOldText, { groupProdid: groupProdidEnabled });
    const newText = result.error ? compactSql(currentOldText) : (renderTokens(lex(result.optimizedOneLine || result.optimized), { compact: true }).trim());
    const diff = charDiff(currentOldText, newText);
    currentNewText = newText;
    oldCode.innerHTML = diff.oldHtml;
    newCode.innerHTML = diff.newHtml;
    addedCount.textContent = `+${diff.addedCount}`;
    removedCount.textContent = `-${diff.removedCount}`;
  }

  function show(sql) {
    currentOldText = String(sql || '').trim();
    groupProdidEnabled = false;
    updateGroupProdidButton();
    renderOptimizedSql();
    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('optimizer-is-open');
    lastFocus = document.activeElement;
    newCode.focus();
  }

  function hide() {
    modal.hidden = true;
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('optimizer-is-open');
    if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
  }

  async function copySql(text, button) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(button === copyOld ? oldCode : newCode);
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand('copy');
      selection.removeAllRanges();
    }
    const label = button.textContent;
    button.textContent = 'copied';
    button.classList.add('copied');
    setTimeout(() => { button.textContent = label; button.classList.remove('copied'); }, 1000);
  }

  window.addEventListener('sqlviewer-open-optimizer', event => show(event.detail && event.detail.sql));
  close.addEventListener('click', hide);
  close.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); hide(); }
  });
  copyOld.addEventListener('click', () => copySql(currentOldText, copyOld));
  copyNew.addEventListener('click', () => copySql(currentNewText, copyNew));
  groupProdidButton.addEventListener('click', () => {
    groupProdidEnabled = !groupProdidEnabled;
    updateGroupProdidButton();
    renderOptimizedSql();
  });
  modal.addEventListener('click', event => { if (event.target === modal) hide(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !modal.hidden) hide(); });
})();
