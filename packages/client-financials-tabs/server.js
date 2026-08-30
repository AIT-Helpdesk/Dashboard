// Permanent-tabs and help-text GET/PUT for this one tabbed page -- see
// @dashboard/shell/tab-page-server.js for the actual implementation
// (shared by every tabbed page on this dashboard). This file's own
// __dirname is what gives THIS page its own independent settings files,
// separate from every other tabbed page's.
module.exports = require('@dashboard/shell/tab-page-server.js').createTabPageRouter(__dirname);
