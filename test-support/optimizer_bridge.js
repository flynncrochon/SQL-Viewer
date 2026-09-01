'use strict';

/* Small JSON bridge used by the Python differential tests. Keeping the
   optimiser itself in JavaScript means the Python test exercises the exact
   implementation shipped by the browser rather than a port of it. */

const fs = require('node:fs');
const { optimiseSql } = require('../optimizer.js');

const input = fs.readFileSync(0, 'utf8');
const jobs = JSON.parse(input);
const results = jobs.map(job => {
  const result = optimiseSql(job.sql, { groupProdid: Boolean(job.groupProdid) });
  return {
    optimized: result.optimized,
    optimizedOneLine: result.optimizedOneLine || null,
    error: result.error || null,
  };
});

process.stdout.write(JSON.stringify(results));
