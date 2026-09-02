/* Full SQL parsing lives off the UI thread. A validation is deliberately
   unbounded: the owner terminates this worker only when its SQL becomes stale. */
const PARSER_URL = './vendor/node-sql-parser-mysql.umd.js';

let parser = null;
let loadError = '';

try {
  importScripts(PARSER_URL);
  if (typeof self.Parser !== 'function') throw new Error('Parser did not load');
  parser = new self.Parser();
} catch (err) {
  loadError = String((err && err.message) || err || 'Parser did not load');
}

function serialiseError(err) {
  const start = err && err.location && err.location.start;
  return {
    message: String((err && err.message) || 'parse error'),
    found: err && err.found == null ? null : String(err.found),
    location: start ? {
      start: {
        line: Number(start.line) || 1,
        column: Number(start.column) || 1,
        offset: typeof start.offset === 'number' ? start.offset : undefined,
      },
    } : null,
  };
}

self.onmessage = event => {
  const { version, parseText, candidates } = event.data || {};
  if (!parser) {
    self.postMessage({ version, unavailable: true, message: loadError });
    return;
  }

  let first = null;
  for (const [prefix, label] of candidates || []) {
    try {
      parser.astify(prefix + parseText, { database: 'MySQL' });
      self.postMessage({ version, ok: true, label });
      return;
    } catch (err) {
      if (!first) first = { error: serialiseError(err), prefix };
    }
  }

  self.postMessage({
    version,
    ok: false,
    error: first ? first.error : serialiseError(new Error('parse error')),
    prefix: first ? first.prefix : '',
  });
};
