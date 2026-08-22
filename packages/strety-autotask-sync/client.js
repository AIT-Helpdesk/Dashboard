// This package's OWN Strety connection -- deliberately separate from the
// rest of the dashboard's (packages/strety-client's default export), with
// its own limited-access Strety account, own OAuth client id/secret (this
// package's own .env, NOT the repo-root one every other package shares),
// and its own token file. See this package's README for why.
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const path = require('path');
const { createClient } = require('@dashboard/strety-client');

module.exports = createClient({
  clientId: process.env.STRETY_AUTOMATION_CLIENT_ID,
  clientSecret: process.env.STRETY_AUTOMATION_CLIENT_SECRET,
  tokenStorePath: path.join(__dirname, '.tokens.json'),
  connectPath: '/auth/strety-automation/connect',
});
