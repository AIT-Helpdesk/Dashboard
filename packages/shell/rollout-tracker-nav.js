// Small shared helper for filing a generated rollout tracker into the
// sidebar's "Trackers" / "Trackers - Complete" categories -- used by both
// rollout-tracker-builder/server.js (a freshly published tracker lands in
// "Trackers", not at sidebar root like every other builder here) and
// rollout-tracker-server.js (its own Hide Complete / Un-Complete This
// buttons move a tracker between the two). Kept separate from
// rollout-tracker-nav's callers rather than duplicated -- unlike the
// three-line slugify() every builder here happily copies, moving a node
// between categories has enough real logic (find-and-remove, category
// creation) that a shared home is worth it.
const TRACKERS_CATEGORY_ID = 'trackers';
const TRACKERS_CATEGORY_LABEL = 'Trackers';
const TRACKERS_COMPLETE_CATEGORY_ID = 'trackers-complete';
const TRACKERS_COMPLETE_CATEGORY_LABEL = 'Trackers - Complete';

// Removes a { type: 'page', id: pageId } node from wherever it currently
// sits (sidebar root, or one level deep inside any category's children --
// nav-layout.json is never nested deeper than that) and returns it,
// preserving any admin-set fields on it (e.g. a `label` rename override)
// rather than discarding them. Returns null if the page isn't in the tree
// at all yet (e.g. the very first time a freshly-published tracker is
// filed into "Trackers").
function removePageNode(tree, pageId) {
  const rootIdx = tree.findIndex((n) => n.type === 'page' && n.id === pageId);
  if (rootIdx !== -1) return tree.splice(rootIdx, 1)[0];
  for (const node of tree) {
    if (node.type === 'category' && Array.isArray(node.children)) {
      const idx = node.children.findIndex((c) => c.type === 'page' && c.id === pageId);
      if (idx !== -1) return node.children.splice(idx, 1)[0];
    }
  }
  return null;
}

// Finds an existing category by id, or creates and appends an empty one at
// the end of the tree -- same "created on first use, not pre-seeded"
// approach as every other runtime-configured nav state on this dashboard.
function ensureCategory(tree, categoryId, label) {
  let category = tree.find((n) => n.type === 'category' && n.id === categoryId);
  if (!category) {
    category = { type: 'category', id: categoryId, label, children: [] };
    tree.push(category);
  }
  return category;
}

// Moves (or, for a brand-new tracker, places for the first time) one
// page's nav node into the named category. Mutates `tree` in place --
// caller is responsible for writeNavLayout(tree) afterward, same as every
// other nav-layout mutation on this dashboard.
function movePageToCategory(tree, pageId, categoryId, categoryLabel) {
  const node = removePageNode(tree, pageId) || { type: 'page', id: pageId };
  ensureCategory(tree, categoryId, categoryLabel).children.push(node);
}

module.exports = {
  TRACKERS_CATEGORY_ID,
  TRACKERS_CATEGORY_LABEL,
  TRACKERS_COMPLETE_CATEGORY_ID,
  TRACKERS_COMPLETE_CATEGORY_LABEL,
  removePageNode,
  ensureCategory,
  movePageToCategory,
};
