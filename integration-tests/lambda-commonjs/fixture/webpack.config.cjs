'use strict';

const path = require('node:path');
const nodeExternals = require('webpack-node-externals');
const slsw = require('serverless-webpack');

// No allowlist: the LaunchDarkly AI packages stay external and are loaded through `require()`
// from the deployment package, which is the resolution path AIC-3370 broke.
module.exports = {
  mode: 'none',
  target: 'node22',
  entry: slsw.lib.entries,
  externals: [nodeExternals()],
  output: {
    path: path.join(__dirname, '.webpack'),
    filename: '[name].js',
    libraryTarget: 'commonjs2',
  },
};
