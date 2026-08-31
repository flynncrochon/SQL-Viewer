<p align="center">
  <a href="https://flynncrochon.github.io/SQL-Viewer/">
    <img src="icons/sql-viewer-brackets-vscode-balanced.svg" alt="SQL Viewer bracket icon" width="96">
  </a>
</p>

<h1 align="center">SQL Viewer</h1>

<p align="center">
  View, edit, format, and safely optimise long SQL statements locally in the browser.
</p>

<p align="center">
  <a href="https://github.com/flynncrochon/SQL-Viewer/actions/workflows/test.yml"><img src="https://github.com/flynncrochon/SQL-Viewer/actions/workflows/test.yml/badge.svg" alt="Tests"></a>
  <a href="https://flynncrochon.github.io/SQL-Viewer/"><img src="https://img.shields.io/website?url=https%3A%2F%2Fflynncrochon.github.io%2FSQL-Viewer%2F" alt="Live website status"></a>
  <img src="https://img.shields.io/badge/JavaScript-ES2020%2B-f7df1e?logo=javascript&logoColor=000000" alt="JavaScript ES2020 or newer required">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2ea44f" alt="MIT License"></a>
</p>

<p align="center">
  <a href="https://flynncrochon.github.io/SQL-Viewer/">https://flynncrochon.github.io/SQL-Viewer/</a>
</p>

<p align="center">
  <a href="https://flynncrochon.github.io/SQL-Viewer/"><img src="assets/sql-viewer-editor.png" alt="SQL Viewer editor showing complicated one-line SQL and its formatted explanation" width="100%"></a>
</p>

<p align="center">
  <a href="https://flynncrochon.github.io/SQL-Viewer/"><img src="assets/sql-viewer-optimiser.png" alt="SQL Viewer optimiser showing extensive SQL simplification" width="100%"></a>
</p>

## Features

- SQL syntax highlighting and bracket folding.
- Live T-SQL and Access SQL validation.
- `WHERE` optimisation for duplicates, ranges, constants, and equality sets.
- Optional `prodid` grouping for literal `OR` overrides.

## Tests

The optimiser has an exhaustive equivalence matrix covering `AND`, `OR`, `IN`,
`=`, `!=`, `<>`, `NULL`, and multiple parenthesis layouts.

Run the tests locally with:

```bash
npm test
```
