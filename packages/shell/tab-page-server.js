const express = require('express');
const fs = require('fs');
const path = require('path');
const { isDashboardAdmin, readNavLayout, writeNavLayout, unregisterPage } = require('./registry.js');

// Shared, generic tabbed-page settings router factory -- extracted from
// what was originally ticket-info-tabs' own server.js, now reused by
// every tabbed page on this dashboard (including anything published
// later via Tab Page Builder). createTabPageRouter(storageDir) is called
// once per tabbed page's own server.js, passing that package's own
// __dirname, so each tabbed page gets its own independent settings files
// living alongside it -- same "runtime-configured state" shape as
// shell/nav-layout.json, read/write via the same plain fs pattern.
//
// Covers three admin-editable, genuinely SHARED (every viewer sees the
// same thing) settings for one tabbed page:
//   - permanent-tabs.json -- which extra tabs the admin has made
//     permanent for everyone (see tab-page-client.js's own comment).
//   - removed-default-tabs.json -- which of the page's own ORIGINAL
//     built-in tabs (defaultTabs, baked in at creation by Tab Page
//     Builder) the admin has since removed for everyone -- by request
//     ("give me the ability to remove tabs from a tab page"). Built-in
//     tabs themselves never change (defaultTabs stays fixed in each
//     page's own generated client.js); this is just a shared exclusion
//     list layered on top, same "don't touch the generated file, persist
//     a small overlay instead" shape permanent-tabs.json already uses
//     for the opposite direction (adding, not removing).
//   - help-text.json -- free-form custom notes the admin can add to that
//     page's own Help tab, on top of the always-generated "how this
//     works" explanation.
function createTabPageRouter(storageDir) {
  const permanentTabsPath = path.join(storageDir, 'permanent-tabs.json');
  const removedDefaultTabsPath = path.join(storageDir, 'removed-default-tabs.json');
  const helpTextPath = path.join(storageDir, 'help-text.json');
  const defaultTabsPath = path.join(storageDir, 'default-tabs.json');

  // The page's own ORIGINAL built-in tabs ({id,label} pairs), written
  // once -- by Tab Page Builder's own POST /publish for anything created
  // from here on, backfilled by hand for the six tabbed pages that
  // predate this file. Read-only from here (defaultTabs itself never
  // changes; only which of its ids are currently removed, via
  // removed-default-tabs.json above, changes) -- used ONLY by the
  // DELETE route below, to know whether every built-in tab is actually
  // gone. Returns null (not []) when the file is missing/unreadable, so
  // that route can fail CLOSED (refuse to delete) rather than wrongly
  // treating "can't tell" as "zero default tabs, go ahead".
  function readDefaultTabs() {
    try {
      const data = JSON.parse(fs.readFileSync(defaultTabsPath, 'utf8'));
      return Array.isArray(data) ? data : null;
    } catch {
      return null;
    }
  }

  // Removes a page node from wherever it currently sits in the shared
  // nav tree -- root level, or inside a category's children (a tab page
  // could in principle have been dragged into a category since it was
  // created, even though every one so far lands at root by convention).
  // Mutates `tree` in place; the caller writes it back.
  function removeNodeById(tree, id) {
    const rootIndex = tree.findIndex((n) => n.id === id);
    if (rootIndex !== -1) {
      tree.splice(rootIndex, 1);
      return;
    }
    for (const node of tree) {
      if (node.type === 'category' && Array.isArray(node.children)) {
        const childIndex = node.children.findIndex((c) => c.id === id);
        if (childIndex !== -1) {
          node.children.splice(childIndex, 1);
          return;
        }
      }
    }
  }

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

  function readRemovedDefaultTabIds() {
    try {
      const data = JSON.parse(fs.readFileSync(removedDefaultTabsPath, 'utf8'));
      return Array.isArray(data) ? data : [];
    } catch {
      return []; // no file yet, or unreadable -- nothing removed yet
    }
  }

  function writeRemovedDefaultTabIds(ids) {
    fs.writeFileSync(removedDefaultTabsPath, JSON.stringify(ids, null, 2));
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

  router.get('/removed-default-tabs', (req, res) => {
    res.json({ tabIds: readRemovedDefaultTabIds(), editable: isDashboardAdmin(req) });
  });

  router.put('/removed-default-tabs', (req, res) => {
    // Same admin-only enforcement as /permanent-tabs above, for the same
    // reason -- removing one of a tab page's own built-in tabs changes
    // what EVERY viewer sees, not just this one.
    if (!isDashboardAdmin(req)) {
      return res.status(403).json({ error: 'Only Amber can remove a built-in tab.' });
    }
    if (!Array.isArray(req.body?.tabIds)) {
      return res.status(400).json({ error: 'Body must be { tabIds: [...] }.' });
    }
    writeRemovedDefaultTabIds(req.body.tabIds);
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

  // Deletes this whole tab page, by request -- with the one real safety
  // rule it was asked for: only when EVERY tab is actually gone. "Every
  // tab" means every built-in default tab (removed via
  // removed-default-tabs.json above) AND every permanent tab -- personal/
  // extra tabs deliberately don't count: they're per-browser
  // localStorage the server has no visibility into at all, so they'd
  // never be a reliable signal for a SHARED deletion decision anyway.
  // Validated server-side, not just hidden in the UI, same as every
  // other admin-only write above.
  router.delete('/', (req, res) => {
    if (!isDashboardAdmin(req)) {
      return res.status(403).json({ error: 'Only Amber can delete a tab page.' });
    }
    const defaultTabs = readDefaultTabs();
    if (!defaultTabs) {
      return res.status(409).json({ error: "Can't verify this page's tabs (missing default-tabs.json) -- refusing to delete." });
    }
    const removedIds = new Set(readRemovedDefaultTabIds());
    const remainingDefaultTabs = defaultTabs.filter((t) => !removedIds.has(t.id));
    const permanentTabIds = readPermanentTabIds();
    const remainingCount = remainingDefaultTabs.length + permanentTabIds.length;
    if (remainingCount > 0) {
      return res.status(409).json({
        error: `This page still has ${remainingCount} tab${remainingCount === 1 ? '' : 's'} -- remove every tab first (right-click each one, or drag it out), then try deleting again.`,
      });
    }

    // id == this package's own directory name -- same convention Tab
    // Page Builder's own POST /publish uses when it first creates this
    // directory (pageDir = path.join(packagesRoot, slug), slug === id).
    const id = path.basename(storageDir);

    // Nav-layout.json and the live in-memory registry both updated here,
    // server-side -- same "the server is the one that persists this, not
    // a client-side round trip" shape Tab Page Builder's own POST
    // /publish already uses for the opposite direction (adding this
    // exact kind of node).
    const tree = readNavLayout() || [];
    removeNodeById(tree, id);
    writeNavLayout(tree);
    unregisterPage(id);

    // Last, since it's the one actually irreversible step here -- the
    // nav-layout/registry bookkeeping above is cheap to redo by hand if
    // something below ever threw, the directory itself is not.
    fs.rmSync(storageDir, { recursive: true, force: true });

    res.json({ ok: true });
  });

  return router;
}

module.exports = { createTabPageRouter };
