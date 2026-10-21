'use strict';

// Invokes a bundled handler the way Lambda would and reports the outcome on stdout/stderr.
const { handler } = require(process.argv[2]);

handler()
  .then((result) => {
    process.stdout.write(JSON.stringify(result));
  })
  .catch((err) => {
    process.stderr.write(`${err.code ?? 'NO_ERROR_CODE'}\n${err.message}\n`);
    process.exitCode = 1;
  });
