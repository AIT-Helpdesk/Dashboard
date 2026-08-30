const express = require('express');
const fs = require('fs');
const path = require('path');
const { isDashboardAdmin } = require('./registry.js');

// Shared, generic tabbed-page settings router factory -- extracted from
// what was originally ticket-info-tabs' own server.js, now reused by
// every tabbed page on this dashboard (including anything published
// later via Tab Page Builder). createTabPageRouter(storageDir) is called
// once per tabbed page's own server.js, passing that package's own
// __dirname, so each tabbed page gets its own independent settings files
// living alongside it -- same "runtime-configured state" shape as
// shell/nav-layout.json, read/write via the same plain fs pattern.
//
// Covers two admin-editable, genuinely SHARED (every viewer sees the
// same thing) settings for one tabbed page:
//   - permanent-tabs.json -- which extra tabs the admin has made
//     permanent for everyone (see tab-page-client.js's own comment).
//   - help-text.json -- free-form custom notes the admin can add to that
//     page's own Help tab, on top of the always-generated "how this
//     works" explanation.
function createTabPageRouter(storageDir) {
  const permanentTabsPath = path.join(storageDir, 'permanent-tabs.json');
  const helpTextPath = path.join(storageDir, 'help-text.json');

  function readPermanentTabIds() {
    try {
      const data = JSON.parse(fs.readFileSync(permanentTabsPath, 'utf8'));
      return Array.isArray(data) ? data : [];
    } catch {
      return []; // no file yet, or unreadable -- nothing permanent yet
    }
  }

  function writePermanentTabIds(ids) {
    fs.writeFileSync(permanentTabsPath, JSON.stringify(ids, null, 2));
  }

  function readHelpText() {
    try {
      const data = JSON.parse(fs.readFileSync(helpTextPath, 'utf8'));
      return typeof data === 'string' ? data : '';
    } catch {
      return ''; // no file yet, or unreadable -- no custom notes yet
    }
  }

  function writeHelpText(text) {
    fs.writeFileSync(helpTextPath, JSON.stringify(text));
  }

  const router = express.Router();
  router.use(express.json());

  // `editable` mirrors /api/nav-layout's own response shape (shell's own
  // server.js) -- lets a tabbed page's client.js know whether THIS viewer
  // is the dashboard admin, so it can show the extra "this is permanent,
  // remove it" affordances only to them, and route a drag-add straight to
  // the shared list instead of their own personal one.
  router.get('/permanent-tabs', (req, res) => {
    res.json({ tabIds: readPermanentTabIds(), editable: isDashboardAdmin(req) });
  });

  router.put('/permanent-tabs', (req, res) => {
    // Enforced here too, not just hidden in the UI -- a request to
    // change the shared permanent-tab list from anyone but the
    // dashboard admin is rejected outright, regardless of what the
    // client sent.
    if (!isDashboardAdmin(req)) {
      return res.status(403).json({ error: 'Only Amber can change permanent tabs.' });
    }
    if (!Array.isArray(req.body?.tabIds)) {
      return res.status(400).json({ error: 'Body must be { tabIds: [...] }.' });
    }
    writePermanentTabIds(req.body.tabIds);
    res.json({ ok: true });
  });

  router.get('/help-text', (req, res) => {
    res.json({ text: readHelpText(), editable: isDashboardAdmin(req) });
  });

  router.put('/help-text', (req, res) => {
    if (!isDashboardAdmin(req)) {
      return res.status(403).json({ error: 'Only Amber can edit this page\'s notes.' });
    }
    if (typeof req.body?.text !== 'string') {
      return res.status(400).json({ error: 'Body must be { text: string }.' });
    }
    writeHelpText(req.body.text);
    res.json({ ok: true });
  });

  return router;
}

module.exports = { createTabPageRouter };
