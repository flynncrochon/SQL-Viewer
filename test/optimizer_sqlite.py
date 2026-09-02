"""Differential tests for the optimiser against SQLite.

The optimiser is intentionally conservative and only rewrites WHERE logic.
This test generates a bounded exhaustive predicate corpus, asks the real
JavaScript implementation for its output, and executes the original and
optimised statements against the same in-memory SQLite data.

SQLite is used as an executable reference for the common SQL subset exercised
here. The test does not claim that SQLite proves every T-SQL or Access rule;
the normal mode requires exact equality, while grouped mode additionally
checks that explicit prodid overrides collapse to at most one positive and
one negative predicate. Grouped mode is intentionally allowed to change row
selection because it discards the connected conditions around overrides.
"""

from __future__ import annotations

import itertools
import json
import os
import re
import sqlite3
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BRIDGE = ROOT / "test-support" / "optimizer_bridge.js"
NODE = os.environ.get("NODE", "node")

FIELDS = ("a", "b", "prodid")
OPERATORS = ("=", "!=", "<>", "IN", "NOT IN")
BOOLEAN_OPERATORS = ("AND", "OR")

# Values used in generated predicates. The data domain deliberately includes
# values outside this set so an overly broad prodid override is observable.
PREDICATE_VALUES = (0, 1, 2)
COLUMN_VALUES = (None, 0, 1, 2, 3, 10)
PRODID_VALUES = (0, 1, 2, 3, 10)
PRODID_PREDICATE = re.compile(
    r"(?i)(?:\bprodid\b|\[\s*prodid\s*\]|`\s*prodid\s*`|\"\s*prodid\s*\")"
    r"\s*(NOT\s+IN|IN|<>|!=|=)"
)


@dataclass(frozen=True)
class Expression:
    text: str
    # Literal prodid values that grouped mode is allowed to affect. A NOT
    # wrapper clears this set because the production pass deliberately leaves
    # negated subtrees intact.
    affected_prodid: frozenset[int] = frozenset()
    contains_prodid: bool = False
    grouped_prodid_kinds: frozenset[str] = frozenset()
    ungrouped_prodid: bool = False


@dataclass(frozen=True)
class Case:
    sql: str
    affected_prodid: frozenset[int] = frozenset()
    contains_prodid: bool = False
    grouped_prodid_kinds: frozenset[str] = frozenset()
    ungrouped_prodid: bool = False


def wrap(expression: Expression) -> Expression:
    return Expression(
        f"({expression.text})",
        expression.affected_prodid,
        expression.contains_prodid,
        expression.grouped_prodid_kinds,
        expression.ungrouped_prodid,
    )


def negate(expression: Expression) -> Expression:
    return Expression(
        f"NOT ({expression.text})",
        frozenset(),
        expression.contains_prodid,
        frozenset(),
        expression.contains_prodid or expression.ungrouped_prodid,
    )


def atom(field: str, operator: str, seed: int) -> Expression:
    value = PREDICATE_VALUES[seed % len(PREDICATE_VALUES)]
    if operator in ("IN", "NOT IN"):
        values = (value, value + 1)
        text = f"{field} {operator} ({values[0]}, {values[1]})"
    else:
        values = (value,)
        text = f"{field} {operator} {value}"

    contains_prodid = field.lower() == "prodid"
    affected = (
        frozenset(values)
        if contains_prodid and operator in ("=", "IN")
        else frozenset()
    )
    grouped_kind = (
        frozenset({"positive" if operator in ("=", "IN") else "negative"})
        if contains_prodid
        else frozenset()
    )
    return Expression(text, affected, contains_prodid, grouped_kind)


def pair_forms(left: Expression, operator: str, right: Expression) -> list[Expression]:
    """All leaf/whole-parenthesis combinations at depth 0..1."""

    forms: list[Expression] = []
    for left_depth, right_depth, outer_depth in itertools.product((0, 1), repeat=3):
        left_text = f"({left.text})" if left_depth else left.text
        right_text = f"({right.text})" if right_depth else right.text
        text = f"{left_text} {operator} {right_text}"
        if outer_depth:
            text = f"({text})"
        forms.append(Expression(
            text,
            left.affected_prodid | right.affected_prodid,
            left.contains_prodid or right.contains_prodid,
            left.grouped_prodid_kinds | right.grouped_prodid_kinds,
            left.ungrouped_prodid or right.ungrouped_prodid,
        ))
    return forms


def triple_forms(
    first: Expression,
    first_operator: str,
    second: Expression,
    second_operator: str,
    third: Expression,
) -> list[Expression]:
    """Three-term precedence and association forms with extra wrappers."""

    forms: list[Expression] = []
    affected = first.affected_prodid | second.affected_prodid | third.affected_prodid
    contains_prodid = first.contains_prodid or second.contains_prodid or third.contains_prodid
    grouped_prodid_kinds = (
        first.grouped_prodid_kinds
        | second.grouped_prodid_kinds
        | third.grouped_prodid_kinds
    )
    ungrouped_prodid = (
        first.ungrouped_prodid
        or second.ungrouped_prodid
        or third.ungrouped_prodid
    )
    # Pair forms cover every combination of leaf and whole-expression
    # parentheses. For three terms, these are the distinct SQL precedence and
    # association shapes; extra redundant wrappers are covered by the pair
    # matrix and the nested forms below.
    raw = f"{first.text} {first_operator} {second.text} {second_operator} {third.text}"
    left = f"({first.text} {first_operator} {second.text}) {second_operator} {third.text}"
    right = f"{first.text} {first_operator} ({second.text} {second_operator} {third.text})"
    texts = (raw, left, right, f"({left})", f"({right})")
    for text in texts:
        forms.append(Expression(text, affected, contains_prodid, grouped_prodid_kinds, ungrouped_prodid))
    return forms


def statement(expression: Expression) -> Case:
    return Case(
        "SELECT id "
        f"FROM sample_rows WHERE {expression.text} ORDER BY id;",
        expression.affected_prodid,
        expression.contains_prodid,
        expression.grouped_prodid_kinds,
        expression.ungrouped_prodid,
    )


def unique_cases(expressions: list[Expression]) -> list[Case]:
    seen: dict[str, Case] = {}
    for expression in expressions:
        case = statement(expression)
        seen.setdefault(case.sql, case)
    return list(seen.values())


def pair_corpus(fields: tuple[str, ...]) -> list[Case]:
    expressions: list[Expression] = []
    for left_field, right_field in itertools.product(fields, repeat=2):
        for left_operator, right_operator in itertools.product(OPERATORS, repeat=2):
            left = atom(left_field, left_operator, 0)
            right = atom(right_field, right_operator, 1)
            for boolean_operator in BOOLEAN_OPERATORS:
                # Every choice of a NOT around either leaf.
                for left_not, right_not in itertools.product((False, True), repeat=2):
                    current_left = negate(left) if left_not else left
                    current_right = negate(right) if right_not else right
                    for form in pair_forms(current_left, boolean_operator, current_right):
                        expressions.append(form)
                        # And a NOT around the whole boolean group.
                        expressions.append(negate(form))
    return unique_cases(expressions)


def triple_corpus(
    field_patterns: tuple[tuple[str, str, str], ...],
    not_masks: tuple[int, ...] = tuple(range(8)),
) -> list[Case]:
    expressions: list[Expression] = []
    for fields in field_patterns:
        for operators in itertools.product(OPERATORS, repeat=3):
            first = atom(fields[0], operators[0], 0)
            second = atom(fields[1], operators[1], 1)
            third = atom(fields[2], operators[2], 2)
            for boolean_operators in itertools.product(BOOLEAN_OPERATORS, repeat=2):
                for not_mask in not_masks:
                    current = [
                        negate(first) if not_mask & 1 else first,
                        negate(second) if not_mask & 2 else second,
                        negate(third) if not_mask & 4 else third,
                    ]
                    forms = triple_forms(
                        current[0], boolean_operators[0],
                        current[1], boolean_operators[1],
                        current[2],
                    )
                    for form in forms:
                        expressions.append(form)
                        expressions.append(negate(form))
    return unique_cases(expressions)


def extra_cases() -> list[Case]:
    expressions = [
        Expression("a IS NULL AND a IS NOT NULL"),
        Expression("a IS NULL OR a IS NOT NULL"),
        Expression("NOT (a IS NULL OR a IS NOT NULL)"),
        Expression("a IN (1, NULL)"),
        Expression("a NOT IN (1, NULL)"),
        Expression("NOT (a IN (1, NULL))"),
        Expression("a BETWEEN 0 AND 2 AND a >= 1"),
        Expression("NOT (a BETWEEN 0 AND 2 OR b <> 1)"),
        Expression("(prodid = 1 AND prodcode = 1) OR prodid IN (2, 3)"),
        Expression("(prodcode = 1 AND prodid NOT IN (1, 2)) OR brand = 1"),
        Expression("NOT (prodid = 1 OR prodid <> 2)"),
        Expression("(prodcode = 1 OR prodid IN (1, 2, 3)) AND prodid NOT IN (2)"),
        Expression("a = 1 AND A = 1"),
        Expression("[a] = 1 OR A = 2"),
        Expression("[a] >= 1 AND A > 2"),
        Expression("[a] IS NULL AND A IS NOT NULL"),
        Expression("[a] IN (1, 2) AND A NOT IN (2, 3)"),
        Expression("[prodid] = 1 OR PRODID IN (2, 3) OR prodid = 3"),
        Expression("a = 0 OR [prodid] != 1"),
        Expression('Brand IN ("Dermaveen Daily Nourish", "Goat", "GOAT", "The Goat Skincare")'),
        Expression('brand = "Goat" OR BRAND = "GOAT"'),
    ]
    # The explicit expressions above are eligible for prodid grouping only
    # when the prodid atom is not inside a NOT wrapper. Their metadata is
    # annotated directly to keep the test oracle independent of SQL text
    # extraction.
    expressions[8] = Expression(expressions[8].text, frozenset({1, 2, 3}), True, frozenset({"positive"}))
    expressions[9] = Expression(expressions[9].text, frozenset(), True, frozenset({"negative"}))
    expressions[10] = Expression(expressions[10].text, frozenset(), True, frozenset(), True)
    expressions[11] = Expression(expressions[11].text, frozenset({1, 2, 3}), True, frozenset({"positive", "negative"}))
    expressions[17] = Expression(expressions[17].text, frozenset({1, 2, 3}), True, frozenset({"positive"}))
    expressions[18] = Expression(expressions[18].text, frozenset(), True, frozenset({"negative"}))
    return [statement(expression) for expression in expressions]


def build_cases() -> list[Case]:
    # The first matrix covers all pair combinations across all three fields.
    cases = pair_corpus(FIELDS)

    # Three-term exhaustive coverage uses ordinary columns and several
    # prodid placements. This covers both optimizer modes without exploding
    # into an unbounded grammar.
    patterns = (
        ("a", "a", "a"),
        ("a", "a", "b"),
        ("a", "b", "a"),
        ("a", "b", "b"),
        ("prodid", "prodid", "prodid"),
        ("prodid", "prodid", "a"),
        ("prodid", "a", "prodid"),
        ("a", "prodid", "prodid"),
    )
    cases.extend(triple_corpus(patterns))
    cases.extend(extra_cases())

    unique: dict[str, Case] = {}
    for case in cases:
        unique.setdefault(case.sql, case)
    return list(unique.values())


def optimiser_results(cases: list[Case], group_prodid: bool) -> list[dict]:
    jobs = [{"sql": case.sql, "groupColumn": "prodid" if group_prodid else ""} for case in cases]
    try:
        completed = subprocess.run(
            [NODE, str(BRIDGE)],
            cwd=ROOT,
            input=json.dumps(jobs),
            text=True,
            capture_output=True,
            check=False,
        )
    except OSError as error:
        raise AssertionError(f"could not start Node ({NODE}): {error}") from error
    if completed.returncode:
        raise AssertionError(
            f"optimiser bridge failed with exit code {completed.returncode}:\n"
            f"{completed.stderr}"
        )
    try:
        results = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise AssertionError(
            f"optimiser bridge returned invalid JSON: {completed.stdout[:500]}"
        ) from error
    if len(results) != len(cases):
        raise AssertionError(f"bridge returned {len(results)} results for {len(cases)} cases")
    return results


def make_database() -> tuple[sqlite3.Connection, dict[int, int | None]]:
    connection = sqlite3.connect(":memory:")
    connection.execute(
        "CREATE TABLE sample_rows ("
        "id INTEGER PRIMARY KEY, a, b, prodid INTEGER NOT NULL, prodcode, "
        "brand TEXT COLLATE NOCASE)"
    )
    rows = []
    prodid_by_id: dict[int, int] = {}
    row_id = 1
    brand_by_b = {
        None: None,
        0: "Goat",
        1: "GOAT",
        2: "The Goat Skincare",
        3: "Other",
        10: "Other",
    }
    for a_value, b_value, prodid_value in itertools.product(COLUMN_VALUES, COLUMN_VALUES, PRODID_VALUES):
        rows.append((row_id, a_value, b_value, prodid_value, a_value, brand_by_b[b_value]))
        prodid_by_id[row_id] = prodid_value
        row_id += 1
    connection.executemany(
        "INSERT INTO sample_rows (id, a, b, prodid, prodcode, brand) VALUES (?, ?, ?, ?, ?, ?)",
        rows,
    )
    connection.commit()
    return connection, prodid_by_id


def selected_rows(connection: sqlite3.Connection, sql: str) -> tuple[int, ...]:
    try:
        return tuple(row[0] for row in connection.execute(sql).fetchall())
    except sqlite3.Error as error:
        raise AssertionError(f"SQLite rejected SQL:\n{sql}\n{error}") from error


def grouped_prodid_spots(sql: str) -> tuple[int, int]:
    positive = 0
    negative = 0
    for match in PRODID_PREDICATE.finditer(sql):
        operator = match.group(1).upper().replace(" ", "")
        if operator in ("IN", "="):
            positive += 1
        else:
            negative += 1
    return positive, negative


def check_mode(
    connection: sqlite3.Connection,
    prodid_by_id: dict[int, int],
    cases: list[Case],
    results: list[dict],
    group_prodid: bool,
) -> tuple[int, int]:
    exact = 0
    changed_rows = 0
    for case, result in zip(cases, results):
        if result.get("error"):
            raise AssertionError(
                f"optimiser rejected generated SQL:\n{case.sql}\n"
                f"{result['error']}"
            )
        optimized = result.get("optimized")
        if not optimized:
            raise AssertionError(f"optimiser returned no SQL for:\n{case.sql}")

        before = selected_rows(connection, case.sql)
        after = selected_rows(connection, optimized)

        if group_prodid and case.grouped_prodid_kinds and not case.ungrouped_prodid:
            positive_spots, negative_spots = grouped_prodid_spots(optimized)
            if positive_spots > 1 or negative_spots > 1:
                raise AssertionError(
                    "grouped mode emitted more than one grouped prodid predicate:\n"
                    f"input:\n{case.sql}\noutput:\n{optimized}\n"
                    f"positive spots: {positive_spots}; negative spots: {negative_spots}"
                )

        if before == after:
            exact += 1
            continue

        if not group_prodid:
            raise AssertionError(
                "optimiser changed query results in normal mode:\n"
                f"input:\n{case.sql}\noutput:\n{optimized}\n"
                f"before rows: {before[:10]}\nafter rows: {after[:10]}"
            )

        changed_rows += len(set(before) ^ set(after))
    return exact, changed_rows


def main() -> int:
    cases = build_cases()
    group_cases = [case for case in cases if case.contains_prodid]
    connection, prodid_by_id = make_database()
    try:
        normal_results = optimiser_results(cases, False)
        normal_exact, _ = check_mode(connection, prodid_by_id, cases, normal_results, False)

        group_results = optimiser_results(group_cases, True)
        group_exact, group_changes = check_mode(connection, prodid_by_id, group_cases, group_results, True)
    finally:
        connection.close()

    print(
        f"SQLite differential tests passed: {len(cases)} cases; "
        f"normal exact={normal_exact}; "
        f"group cases={len(group_cases)}, exact={group_exact}; "
        f"intentional grouped row changes={group_changes}"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except AssertionError as error:
        print(f"FAIL: {error}", file=sys.stderr)
        raise SystemExit(1)
