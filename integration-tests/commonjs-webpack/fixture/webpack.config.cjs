'use strict';

const path = require('node:path');
const nodeExternals = require('webpack-node-externals');

const allowlisted = process.env.LD_AI_ALLOWLIST === '1';

module.exports = {
  mode: 'none',
  target: 'node22',
  entry: './handler.cjs',
  externals: [nodeExternals({ allowlist: allowlisted ? [/^@launchdarkly\/ai-/] : [] })],
  output: {
    path: path.join(__dirname, allowlisted ? 'dist-allowlisted' : 'dist-externalized'),
    filename: 'handler.js',
    libraryTarget: 'commonjs2',
  },
};
