'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { lex, optimiseSql, layoutOnOriginal } = require('../optimizer.js');

const CLAUSE_STOP = new Set([
  'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'INTERSECT', 'EXCEPT',
  'RETURNING', 'WINDOW', 'QUALIFY', 'FETCH', 'FOR', 'OPTION'
]);

const UNKNOWN = 'UNKNOWN';

function codeTokens(sql) {
  return lex(sql).filter(token => token.type !== 'comment');
}

function tokenKey(token) {
  return `${token.type}:${token.type === 'word' ? token.value.toUpperCase() : token.value}`;
}

function tokenKeys(sql) {
  return codeTokens(sql).map(tokenKey);
}

/* This deliberately has its own target finder. It checks that formatting and
   statement assembly do not change the expression that is being evaluated. */
function predicateTokens(sql) {
  const code = codeTokens(sql);
  let depth = 0;
  let whereIndex = -1;

  for (let index = 0; index < code.length; index++) {
    const token = code[index];
    if (token.type === 'paren') {
      depth += token.value === '(' ? 1 : -1;
      continue;
    }
    if (depth === 0 && token.type === 'word' && token.value.toUpperCase() === 'WHERE') {
      whereIndex = index;
      break;
    }
  }

  if (whereIndex < 0) {
    return code[code.length - 1]?.type === 'semi' ? code.slice(0, -1) : code;
  }

  depth = 0;
  let end = code.length;
  for (let index = whereIndex + 1; index < code.length; index++) {
    const token = code[index];
    if (token.type === 'paren') {
      depth += token.value === '(' ? 1 : -1;
      continue;
    }
    if (depth === 0 && token.type === 'semi') { end = index; break; }
    if (depth === 0 && token.type === 'word' && CLAUSE_STOP.has(token.value.toUpperCase())) {
      end = index;
      break;
    }
  }
  return code.slice(whereIndex + 1, end);
}

class PredicateParser {
  constructor(tokens) {
    this.tokens = tokens;
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
    if (!this.tokens.length) throw new Error('empty predicate');
    const node = this.parseOr();
    if (this.peek()) throw new Error(`unexpected ${this.peek().value}`);
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
    if (token?.type === 'paren' && token.value === '(') {
      this.index++;
      const child = this.parseOr();
      const close = this.peek();
      if (!close || close.type !== 'paren' || close.value !== ')') throw new Error('missing closing parenthesis');
      this.index++;
      return child;
    }
    return { kind: 'atom', tokens: this.readAtom() };
  }

  readAtom() {
    const start = this.index;
    let depth = 0;
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
        if (depth === 0 && (word === 'AND' || word === 'OR')) {
          if (word === 'AND' && betweenNeedsAnd) betweenNeedsAnd = false;
          else break;
        }
        if (word === 'BETWEEN' && depth === 0) betweenNeedsAnd = true;
      }
      this.index++;
    }

    if (this.index === start) throw new Error('expected predicate');
    return this.tokens.slice(start, this.index);
  }
}

function fieldName(tokens) {
  const fields = [];
  let index = 0;
  while (tokens[index] && (tokens[index].type === 'word' || tokens[index].type === 'qid')) {
    fields.push(tokens[index].value);
    index++;
    if (tokens[index]?.value !== '.') break;
    fields.push('.');
    index++;
  }
  return { name: fields.join(''), next: index };
}

function rowValue(row, name) {
  const key = Object.keys(row).find(candidate => candidate.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : row[key];
}

function literalAt(tokens, index) {
  const token = tokens[index];
  if (!token) return null;
  if (token.type === 'num' || token.type === 'str') return { value: literalValue(token), next: index + 1 };
  if (token.type === 'op' && (token.value === '-' || token.value === '+') && tokens[index + 1]?.type === 'num') {
    const value = literalValue(tokens[index + 1]);
    return { value: token.value === '-' ? -value : value, next: index + 2 };
  }
  if (token.type === 'word') {
    const word = token.value.toUpperCase();
    if (word === 'NULL') return { value: null, next: index + 1 };
    if (word === 'TRUE') return { value: true, next: index + 1 };
    if (word === 'FALSE') return { value: false, next: index + 1 };
  }
  return null;
}

function literalValue(token) {
  if (token.type === 'num') return Number(token.value);
  const quote = token.value[0];
  return token.value.slice(1, -1).replace(new RegExp(`${quote}${quote}`, 'g'), quote);
}

function sqlCompare(left, operator, right) {
  if (operator === '<=>') {
    if (left === null || right === null) return left === right ? 'TRUE' : 'FALSE';
  } else if (left === null || right === null || left === undefined || right === undefined) {
    return UNKNOWN;
  }

  if (typeof left !== typeof right) return UNKNOWN;
  if (operator === '=') return left === right ? 'TRUE' : 'FALSE';
  if (operator === '!=' || operator === '<>') return left !== right ? 'TRUE' : 'FALSE';
  if (operator === '>') return left > right ? 'TRUE' : 'FALSE';
  if (operator === '>=') return left >= right ? 'TRUE' : 'FALSE';
  if (operator === '<') return left < right ? 'TRUE' : 'FALSE';
  if (operator === '<=') return left <= right ? 'TRUE' : 'FALSE';
  return UNKNOWN;
}

function andValue(left, right) {
  if (left === 'FALSE' || right === 'FALSE') return 'FALSE';
  if (left === UNKNOWN || right === UNKNOWN) return UNKNOWN;
  return 'TRUE';
}

function orValue(left, right) {
  if (left === 'TRUE' || right === 'TRUE') return 'TRUE';
  if (left === UNKNOWN || right === UNKNOWN) return UNKNOWN;
  return 'FALSE';
}

function notValue(value) {
  if (value === UNKNOWN) return UNKNOWN;
  return value === 'TRUE' ? 'FALSE' : 'TRUE';
}

function evaluateAtom(tokens, row) {
  if (tokens.length === 1 && tokens[0].type === 'word') {
    const word = tokens[0].value.toUpperCase();
    if (word === 'TRUE') return 'TRUE';
    if (word === 'FALSE') return 'FALSE';
    const value = rowValue(row, tokens[0].value);
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    return value === null ? UNKNOWN : UNKNOWN;
  }

  const field = fieldName(tokens);
  const value = rowValue(row, field.name);
  const operatorToken = tokens[field.next];
  if (!operatorToken) return UNKNOWN;
  const operator = operatorToken.type === 'word' ? operatorToken.value.toUpperCase() : operatorToken.value;
  let index = field.next + 1;

  if (operator === 'IS') {
    const not = tokens[index]?.type === 'word' && tokens[index].value.toUpperCase() === 'NOT';
    if (not) index++;
    if (tokens[index]?.type === 'word' && tokens[index].value.toUpperCase() === 'NULL') {
      return (value === null) === !not ? 'TRUE' : 'FALSE';
    }
    return UNKNOWN;
  }

  if (operator === 'IN' || (operator === 'NOT' && tokens[index]?.type === 'word' && tokens[index].value.toUpperCase() === 'IN')) {
    const negative = operator === 'NOT';
    if (negative) index++;
    if (tokens[index]?.value !== '(') return UNKNOWN;
    index++;
    const comparisons = [];
    while (index < tokens.length && tokens[index].value !== ')') {
      const literal = literalAt(tokens, index);
      if (!literal) return UNKNOWN;
      comparisons.push(sqlCompare(value, '=', literal.value));
      index = literal.next;
      if (tokens[index]?.value === ',') index++;
      else if (tokens[index]?.value !== ')') return UNKNOWN;
    }
    let result = comparisons.reduce(orValue, 'FALSE');
    if (negative) result = notValue(result);
    return result;
  }

  if (operator === 'BETWEEN') {
    const low = literalAt(tokens, index);
    if (!low || tokens[low.next]?.value !== 'AND') return UNKNOWN;
    const high = literalAt(tokens, low.next + 1);
    if (!high) return UNKNOWN;
    return andValue(sqlCompare(value, '>=', low.value), sqlCompare(value, '<=', high.value));
  }

  const literal = literalAt(tokens, index);
  if (!literal) return UNKNOWN;
  return sqlCompare(value, operator, literal.value);
}

function evaluate(node, row) {
  if (node.kind === 'atom') return evaluateAtom(node.tokens, row);
  if (node.kind === 'not') return notValue(evaluate(node.child, row));
  if (node.kind === 'and') return node.children.reduce((result, child) => andValue(result, evaluate(child, row)), 'TRUE');
  if (node.kind === 'or') return node.children.reduce((result, child) => orValue(result, evaluate(child, row)), 'FALSE');
  throw new Error(`unknown node ${node.kind}`);
}

function evaluateSql(sql, row) {
  return evaluate(new PredicateParser(predicateTokens(sql)).parse(), row);
}

function rowsFor(domains) {
  return Object.entries(domains).reduce(
    (rows, [field, values]) => rows.flatMap(row => values.map(value => ({ ...row, [field]: value }))),
    [{}],
  );
}

function assertEquivalent(sql, domains, options = {}) {
  const result = optimiseSql(sql, options);
  assert.equal(result.error, undefined, `${sql}\noptimiser error: ${result.error || 'unknown error'}`);
  assert.ok(result.optimizedOneLine, `${sql}\noptimiser did not return a one-line result`);

  const rows = rowsFor(domains);
  /* The optimiser only rewrites WHERE predicates. SQL WHERE keeps TRUE rows;
     FALSE and UNKNOWN are both filtered out, so compare row selection rather
     than treating those two rejected states as different query results. */
  const before = rows.map(row => evaluateSql(sql, row) === 'TRUE');
  const after = rows.map(row => evaluateSql(result.optimizedOneLine, row) === 'TRUE');
  assert.deepEqual(after, before, `${sql}\n=> ${result.optimizedOneLine}`);
  return result;
}

const numericRows = { a: [null, -1, 0, 1, 2, 5, 10, 20, 21], b: [null, 0, 1, 2] };

const COMPARISON_OPERATORS = ['=', '!=', '<>', 'IN', 'NOT IN'];
const BOOLEAN_OPERATORS = ['AND', 'OR'];
const TWO_FIELD_PATTERNS = [
  ['a', 'a'], ['a', 'b'], ['b', 'a'], ['b', 'b'],
];
const THREE_FIELD_PATTERNS = [
  ['a', 'a', 'a'], ['a', 'a', 'b'], ['a', 'b', 'a'], ['a', 'b', 'b'],
];
const COMBINATORIAL_ROWS = { a: [null, -1, 0, 1, 2, 3], b: [null, -1, 0, 1, 2, 3] };

function generatedAtom(field, operator, seed) {
  const value = seed % 3;
  if (operator === 'IN' || operator === 'NOT IN') return `${field} ${operator} (${value}, ${value + 1})`;
  return `${field} ${operator} ${value}`;
}

function twoTermForms(left, booleanOperator, right) {
  return [
    `${left} ${booleanOperator} ${right}`,
    `(${left} ${booleanOperator} ${right})`,
    `${left} ${booleanOperator} (${right})`,
    `(${left}) ${booleanOperator} (${right})`,
    `((${left} ${booleanOperator} ${right}))`,
  ];
}

function threeTermForms(first, firstOperator, second, secondOperator, third) {
  return [
    `${first} ${firstOperator} ${second} ${secondOperator} ${third}`,
    `(${first} ${firstOperator} ${second}) ${secondOperator} ${third}`,
    `${first} ${firstOperator} (${second} ${secondOperator} ${third})`,
    `((${first} ${firstOperator} ${second}) ${secondOperator} ${third})`,
    `(${first} ${firstOperator} (${second} ${secondOperator} ${third}))`,
  ];
}

function generatedCombinations() {
  const expressions = [];

  for (const fields of TWO_FIELD_PATTERNS) {
    for (const firstOperator of COMPARISON_OPERATORS) {
      for (const secondOperator of COMPARISON_OPERATORS) {
        for (const firstBoolean of BOOLEAN_OPERATORS) {
          const first = generatedAtom(fields[0], firstOperator, 0);
          const second = generatedAtom(fields[1], secondOperator, 1);
          expressions.push(...twoTermForms(first, firstBoolean, second));
        }
      }
    }
  }

  for (const fields of THREE_FIELD_PATTERNS) {
    for (const firstOperator of COMPARISON_OPERATORS) {
      for (const secondOperator of COMPARISON_OPERATORS) {
        for (const thirdOperator of COMPARISON_OPERATORS) {
          for (const firstBoolean of BOOLEAN_OPERATORS) {
            for (const secondBoolean of BOOLEAN_OPERATORS) {
              expressions.push(...threeTermForms(
                generatedAtom(fields[0], firstOperator, 0), firstBoolean,
                generatedAtom(fields[1], secondOperator, 1), secondBoolean,
                generatedAtom(fields[2], thirdOperator, 2),
              ));
            }
          }
        }
      }
    }
  }

  return [...new Set(expressions)];
}

/* NOT is where UNKNOWN stops behaving like FALSE, so every two-term shape is
   replayed under one. */
function negatedCombinations() {
  const expressions = [];
  for (const fields of TWO_FIELD_PATTERNS) {
    for (const firstOperator of COMPARISON_OPERATORS) {
      for (const secondOperator of COMPARISON_OPERATORS) {
        for (const booleanOperator of BOOLEAN_OPERATORS) {
          const left = generatedAtom(fields[0], firstOperator, 0);
          const right = generatedAtom(fields[1], secondOperator, 1);
          expressions.push(`NOT (${left} ${booleanOperator} ${right})`);
          expressions.push(`NOT (${left} ${booleanOperator} ${right}) ${booleanOperator} ${left}`);
        }
      }
    }
  }
  return [...new Set(expressions)];
}

test('optimiser preserves WHERE row selection for every supported simplification', () => {
  const cases = [
    ['duplicate predicates', 'a = 1 AND a = 1', { a: numericRows.a }],
    ['constant folding', '(a = 1 AND TRUE) OR (b = 2 AND FALSE)', numericRows],
    ['absorbing covered branch', 'a = 2 OR (a = 2 AND b = 1)', numericRows],
    ['implication through OR', 'a >= 20 AND (a >= 10 OR b = 1)', numericRows],
    ['tightened range', 'a >= 10 AND a > 20 AND a <= 30 AND a < 30', { a: numericRows.a }],
    ['contradictory range', 'a >= 10 AND a < 10', { a: numericRows.a }],
    ['equality constrained by set', 'a = 2 AND a IN (1, 2, 3)', { a: numericRows.a }],
    ['intersection of sets', 'a IN (1, 2, 3) AND a IN (2, 3, 4)', { a: numericRows.a }],
    ['union of equality alternatives', 'a = 1 OR a = 2 OR a IN (2, 3)', { a: numericRows.a }],
    ['null contradiction', 'a IS NULL AND a IS NOT NULL', { a: numericRows.a }],
    ['null-safe duplicate', 'a IS NULL OR a IS NULL', { a: numericRows.a }],
    ['between plus bound', 'a BETWEEN 1 AND 10 AND a >= 5', { a: numericRows.a }],
    ['qualified field', 'orders.a = 1 AND orders.a >= 1', { 'orders.a': [null, 0, 1, 2] }],
    ['string equality set', "status = 'new' OR status = 'paid'", { status: [null, 'new', 'paid', 'closed'] }],
    ['three-valued NOT', 'NOT (a = 1 OR b = 2)', numericRows],
    ['parent constraint into nested OR', 'a > 10 AND (a > 5 OR b = 1)', numericRows],
    ['parent constraint kills nested branch', 'a = 1 AND (a = 2 OR b = 1)', numericRows],
    ['parent constraint through two levels', 'a = 1 AND (b = 1 AND (a = 1 OR b = 2))', numericRows],
    ['factored common predicate', '(a = 1 AND b = 2) OR (a = 1 AND b = 0)', numericRows],
    ['NOT IN union', 'a NOT IN (1, 2) AND a NOT IN (2, 3)', { a: numericRows.a }],
    ['NOT IN intersection', 'a NOT IN (1, 2) OR a NOT IN (2, 3)', { a: numericRows.a }],
    ['IN minus NOT IN', 'a IN (1, 2, 3) AND a NOT IN (3)', { a: numericRows.a }],
    ['IN union NOT IN', 'a IN (1, 2) OR a NOT IN (2, 3)', { a: numericRows.a }],
    ['exclusion contradicting equality', 'a = 1 AND a <> 1', { a: numericRows.a }],
    ['exclusion implied by a bound', 'a > 5 AND a <> 3', { a: numericRows.a }],
    ['exhaustive alternatives', 'a = 1 OR a <> 1', { a: numericRows.a }],
    ['literal constants', 'a = 1 AND TRUE AND (b = 2 OR FALSE)', numericRows],
    /* UNKNOWN and FALSE are interchangeable under WHERE but not under NOT. */
    ['negated exhaustive alternatives', 'NOT (a = 1 OR a <> 1)', { a: numericRows.a }],
    ['negated contradiction', 'NOT (a > 5 AND a < 3)', { a: numericRows.a }],
    ['negated impossible set', 'NOT (a IN (1, 2) AND a IN (3, 4))', { a: numericRows.a }],
    ['full statement with suffix', 'SELECT id FROM orders WHERE a = 1 OR a = 2 ORDER BY id;', { a: numericRows.a }],
  ];

  for (const [name, sql, domains] of cases) {
    assertEquivalent(sql, domains);
    assert.ok(name.length > 0);
  }
});

test('optimiser applies the expected safe rewrites', () => {
  const cases = [
    ['a = 1 OR a = 2', 'a IN (1, 2)', 'Merged equality checks into IN'],
    ['a >= 10 AND a > 20 AND a <= 30 AND a < 30', 'a > 20\nAND\na < 30', 'Tightened ranges'],
    ['a = 2 AND a IN (1, 2, 3)', 'a = 2', 'Tightened ranges'],
    ['a >= 10 AND a < 10', 'FALSE', 'Removed impossible conditions'],
    ['a = 2 OR (a = 2 AND b = 1)', 'a = 2', 'Removed covered branches'],
    ['a BETWEEN 1 AND 10 AND a >= 5', 'a >= 5\nAND\na <= 10', null],
    ['a > 10 AND (a > 5 OR b = 1)', 'a > 10', 'Removed conditions guaranteed by outer filters'],
    ['a = 1 AND (a = 2 OR b = 1)', 'a = 1\nAND\nb = 1', 'Removed impossible conditions'],
    ['a = 1 AND (b = 1 AND (a = 1 OR b = 2))', 'a = 1\nAND\nb = 1', 'Removed conditions guaranteed by outer filters'],
    /* Factoring hands the OR back to the set merge, which folds it further. */
    ['(a = 1 AND b = 2) OR (a = 1 AND b = 0)', 'a = 1\nAND\nb IN (2, 0)', 'Factored shared conditions out of OR'],
    ['(a = 1 AND b = 2) OR (a = 1 AND c = 3)', 'a = 1\nAND\n(\n  b = 2\n  OR\n  c = 3\n)', 'Factored shared conditions out of OR'],
    /* Factoring a one-token predicate does not pay for the parentheses. */
    ['(flag AND b = 2) OR (flag AND c = 3)', 'flag\nAND\nb = 2\nOR\nflag\nAND\nc = 3', null],
    ['a NOT IN (1, 2) AND a NOT IN (2, 3)', 'a NOT IN (1, 2, 3)', 'Tightened ranges'],
    ['a NOT IN (1, 2) OR a NOT IN (2, 3)', 'a <> 2', 'Merged equality checks into IN'],
    ['a IN (1, 2, 3) AND a NOT IN (3)', 'a IN (1, 2)', 'Tightened ranges'],
    ['a IN (1, 2) OR a NOT IN (2, 3)', 'a <> 3', 'Merged equality checks into IN'],
    ['a = 1 AND a <> 1', 'FALSE', 'Removed impossible conditions'],
    ['a > 5 AND a <> 3', 'a > 5', 'Tightened ranges'],
    ['a = 1 OR a <> 1', 'a IS NOT NULL', 'Merged equality checks into IN'],
    ['a = 1 AND TRUE AND (b = 2 OR FALSE)', 'a = 1\nAND\nb = 2', 'Folded constant conditions'],
    /* NOT over a single comparison flips the operator; groups stay untouched. */
    ["NOT region NOT IN ('NSW', 'VIC')", "region IN ('NSW', 'VIC')", 'Pushed NOT into the comparison'],
    ["NOT account_status <> 'Active'", "account_status = 'Active'", 'Pushed NOT into the comparison'],
    ['NOT a IS NULL', 'a IS NOT NULL', 'Pushed NOT into the comparison'],
    ['NOT a > 5', 'a <= 5', 'Pushed NOT into the comparison'],
    ['NOT (a = 1 AND b = 2)', 'NOT (\n  a = 1\n  AND\n  b = 2\n)', null],
    ['NOT a IN (1, NULL)', 'NOT a IN (1, NULL)', null],
    /* Both of these are UNKNOWN when a is NULL, so neither may collapse. */
    ['NOT (a = 1 OR a <> 1)', 'NOT (\n  a = 1\n  OR\n  a <> 1\n)', null],
    ['NOT (a > 5 AND a < 3)', 'NOT (\n  a > 5\n  AND\n  a < 3\n)', null],
  ];

  for (const [sql, expected, ruleTitle] of cases) {
    const result = assertEquivalent(sql, numericRows);
    assert.equal(result.optimized, expected, sql);
    if (ruleTitle) assert.ok(result.rules.some(rule => rule.title === ruleTitle), `${sql}\nmissing rule: ${ruleTitle}`);
  }
});

test('matches column identifiers case-insensitively, including bracketed names', () => {
  const cases = [
    ['a = 1 AND A = 1', 'a = 1'],
    ['[a] = 1 OR A = 2', '[a] IN (1, 2)'],
    ['[a] >= 1 AND A > 2', 'A > 2'],
    ['[a] IS NULL AND A IS NOT NULL', 'FALSE'],
  ];

  for (const [sql, expected] of cases) {
    const result = optimiseSql(sql);
    assert.equal(result.error, undefined, sql);
    assert.equal(result.optimizedOneLine, expected, sql);
  }
});

test('folds case-insensitive text literals when merging sets', () => {
  const list = optimiseSql('Brand IN ("Dermaveen Daily Nourish", "Goat", "GOAT", "The Goat Skincare")');
  assert.equal(list.error, undefined);
  assert.equal(list.optimizedOneLine, 'Brand IN ("Dermaveen Daily Nourish", "Goat", "The Goat Skincare")');

  const alternatives = optimiseSql('brand = "Goat" OR BRAND = "GOAT"');
  assert.equal(alternatives.error, undefined);
  assert.equal(alternatives.optimizedOneLine, 'brand = "Goat"');
});

test('preserves unsupported predicate logic and statement tokens', () => {
  const cases = [
    'SELECT * FROM t WHERE a <> 1 AND b != 2;',
    'SELECT * FROM t WHERE a NOT IN (1, 2) OR b = 3 ORDER BY id;',
    'SELECT * FROM t WHERE func(a, 1) = 2 GROUP BY a HAVING COUNT(*) > 1;',
    'SELECT * FROM t WHERE CASE WHEN a BETWEEN 1 AND 2 THEN b ELSE c END = 1;',
    'SELECT * FROM t;',
  ];

  for (const sql of cases) {
    const result = optimiseSql(sql);
    if (result.error) {
      assert.equal(result.optimized, sql);
    } else {
      assert.deepEqual(tokenKeys(result.optimizedOneLine), tokenKeys(sql), sql);
    }
  }
});

test('returns the original SQL when it cannot safely optimise it', () => {
  for (const sql of ['   ', 'SELECT * FROM t;', 'a = 1 AND']) {
    const result = optimiseSql(sql);
    assert.ok(result.error, sql);
    assert.equal(result.optimized, sql.trim(), sql);
    assert.deepEqual(result.rules, [], sql);
  }
});

test('does not enable the documented prodid override implicitly', () => {
  const sql = "prodid = 'A' AND status = 'active'";
  const result = optimiseSql(sql);
  assert.equal(result.error, undefined);
  assert.deepEqual(tokenKeys(result.optimizedOneLine), tokenKeys(sql));
});

test('preserves every AND/OR, IN, NOT IN, =, !=, <> and parenthesis combination', () => {
  const expressions = generatedCombinations();
  assert.equal(expressions.length, 11000, 'the exhaustive matrix should cover every generated combination');

  for (const sql of expressions) assertEquivalent(sql, COMBINATORIAL_ROWS);
});

test('keeps UNKNOWN distinct from FALSE underneath NOT', () => {
  const expressions = negatedCombinations();
  assert.ok(expressions.length > 200, 'the negated matrix should cover every two-term shape');

  for (const sql of expressions) assertEquivalent(sql, COMBINATORIAL_ROWS);
});
test('drops an AND branch whose prodid list was hoisted instead of widening it', () => {
  const sql = "(Prodcode = 31 AND prodid IN (1, 2)) OR prodid IN (3) OR (Prodcode = 56 AND Brand = 'x')";
  const result = optimiseSql(sql, { groupProdid: true });
  assert.equal(result.error, undefined);

  const keys = tokenKeys(result.optimizedOneLine);
  /* Prodcode = 31 only ever selected prodid 1 and 2, and both moved into the
     hoisted override, so no bare Prodcode = 31 may survive. */
  assert.ok(!keys.includes('num:31'), result.optimizedOneLine);
  for (const value of ['1', '2', '3']) {
    assert.ok(keys.includes(`num:${value}`), `${value} should stay in the override: ${result.optimizedOneLine}`);
  }
  /* A branch with no prodid conjunct is untouched. */
  assert.ok(keys.includes('num:56'), result.optimizedOneLine);
});

test('keeps the siblings of a hoisted NOT IN and of a stripped OR arm', () => {
  const negated = optimiseSql("Prodcode = 31 AND prodid NOT IN (1, 2)", { groupProdid: true });
  assert.equal(negated.error, undefined);
  assert.ok(tokenKeys(negated.optimizedOneLine).includes('num:31'), negated.optimizedOneLine);

  const arm = optimiseSql("Prodcode = 31 AND (Brand = 'x' OR prodid IN (1))", { groupProdid: true });
  assert.equal(arm.error, undefined);
  assert.ok(tokenKeys(arm.optimizedOneLine).includes('num:31'), arm.optimizedOneLine);
});

test('groups all prodid exclusions into one global NOT IN', () => {
  const result = optimiseSql('a = 0 OR prodid != 1 OR [PRODID] NOT IN (2, 3)', { groupProdid: true });
  assert.equal(result.error, undefined);
  assert.equal(result.optimizedOneLine, 'a = 0 AND prodid NOT IN (1, 2, 3)');
});

test('emits one positive and one negative prodid group across branches', () => {
  const sql = `
    (Prodcode = 28 AND Brand IN ("Dermaveen") OR Prodid IN (1, 2, 2))
      AND Prodid NOT IN (3, 4)
    OR (Prodcode = 56 AND Brand IN ("Dermaveen Daily Nourish")
      AND PRODID NOT IN (5, 6))
    OR [prodid] IN (7, 8)
  `;
  const result = optimiseSql(sql, { groupProdid: true });
  assert.equal(result.error, undefined);
  assert.match(result.optimizedOneLine, /Prodid IN \(1, 2, 7, 8\)/i);
  assert.match(result.optimizedOneLine, /Prodid NOT IN \(3, 4, 5, 6\)/i);
  assert.equal((result.optimizedOneLine.match(/(?:\bprodid\b|\[prodid\])/gi) || []).length, 2);
});

/* ------------------------------------------------------- layout on original */

/* What the modal does: optimise, then lay the new tokens back over the text
   that was pasted in, so untouched lines stay exactly as they were written. */
function layout(sql, options = {}) {
  const trimmed = sql.trim();
  const result = optimiseSql(trimmed, options);
  assert.equal(result.error, undefined);
  return layoutOnOriginal(trimmed, lex(trimmed), codeTokens(result.optimizedOneLine));
}

function countOf(text, pattern) {
  return (text.match(pattern) || []).length;
}

test('keeps the original lines of a long predicate it barely changed', () => {
  /* Well past the token count that used to force the coarse diff. Only the
     redundant parentheses around each branch go, so every line, blank line
     and comment has to come through. */
  const lines = [];
  for (let i = 0; i < 220; i++) {
    if (i && i % 25 === 0) lines.push('', `-- section ${i / 25}`);
    lines.push(`([Level2] IN ("cat ${i}") AND [Prodcode] IN (${i}, ${i + 1}, ${i + 2}))${i < 219 ? ' OR' : ''}`);
  }
  const sql = lines.join('\n');
  assert.ok(codeTokens(sql).length > 3000, 'input should exceed the old diff cap');

  const laid = layout(sql);
  assert.equal(laid.addedCount, 0);
  assert.ok(laid.removedCount > 0, 'the redundant parentheses should still be struck');
  assert.equal(laid.text.split('\n').length, sql.split('\n').length);
  assert.equal(countOf(laid.text, /^-- section \d$/gm), countOf(sql, /^-- section \d$/gm));
  assert.equal(countOf(laid.text, /^$/gm), countOf(sql, /^$/gm));
  assert.equal(countOf(laid.text, /[()]/g), countOf(sql, /[()]/g) - laid.removedCount);
});

test('lifts a comment out of the expression that swallowed its branch', () => {
  const laid = layout(`[a] IN (1) OR
-- fruit
[a] IN (2) OR
[a] IN (3) OR
-- veg
[b] IN (9)`);

  /* "fruit" labelled a branch that is now part of the list on the line above.
     Left where it falls due it would sit between "1" and ", 2", splitting the
     IN list, so it belongs at the top of that line instead. */
  assert.equal(laid.text, `-- fruit
[a] IN (1, 2, 3) OR
-- veg
[b] IN (9)`);
});

test('leaves a comment where it was when the rewrite starts on a fresh line', () => {
  const laid = layout(`[a] IN (1, 2, 3) OR
-- redundant
[a] IN (2) OR
-- kept
[b] IN (9)`);

  assert.equal(laid.text, `[a] IN (1, 2, 3) OR
-- redundant
-- kept
[b] IN (9)`);
});
