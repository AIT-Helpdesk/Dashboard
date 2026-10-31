// Shared, generic tabbed-page mount factory -- extracted from what was
// originally ticket-info-tabs' own client.js (a from-scratch experiment:
// show a handful of existing pages as tabs on one page instead of as
// separate sidebar entries). Now used by every tabbed page on this
// dashboard -- including anything published later via Tab Page Builder --
// so a fix here (like the real effectAllowed: 'copyMove' cross-browser
// drag/drop bug this went through) fixes every tabbed page at once, not
// just one. Which tabs exist, their order, and removing them is entirely
// admin-only and shared (by request, 2026-11-01: "only allow admin to
// make those changes... everyone sees admin's version") -- an earlier
// version let anyone drag in their own per-browser personal tabs/order;
// that's gone.
import { pages as registeredPages } from '/pages-registry.js';
const PAGES_BY_ID = new Map(registeredPages.map((p) => [p.id, p]));

// The MIME-ish type app.js's own sidebar drag sets via
// e.dataTransfer.setData() on every nav item's dragstart, regardless of
// who's signed in -- shared convention with app.js's renderPageItem(),
// not an import (app.js is the shell, loaded before any page; this
// module is loaded by whichever tabbed page is currently mounted).
const SIDEBAR_DRAG_TYPE = 'application/x-dashboard-page-id';

// Not a real page id -- handled directly in selectTab() below instead of
// going through the dynamic import path every other tab uses. Rendered
// narrower (.tab-button--small) and pushed to the far right via CSS
// (margin-left: auto), and deliberately NOT draggable/reorderable/
// removable -- a fixed utility tab, not one of the content tabs.
const HELP_TAB = { id: 'help', label: 'Help', small: true };

// The one thing every tabbed page provides: its own id/label (for
// self-reference exclusion and the generic Help text), where its own
// permanent-tabs/help-text GET/PUT live (apiBase, backed by
// @dashboard/shell/tab-page-server.js's createTabPageRouter on that
// page's own server.js), and its fixed, permanent starting tabs
// (defaultTabs -- {id, label} pairs, e.g. Ticket Info's four reports).
// Returns a real mount(container) function, same shape every other
// page's client.js exports.
export function createTabbedPageMount({ id, label, apiBase, defaultTabs }) {
  const DEFAULT_TABS = defaultTabs;
  const DEFAULT_TAB_IDS = new Set(DEFAULT_TABS.map((t) => t.id));
  const DEFAULT_TABS_BY_ID = new Map(DEFAULT_TABS.map((t) => [t.id, t]));

  // Whether THIS viewer is the dashboard admin -- the one person who can
  // add/remove/reorder tabs at all (by request, "only allow admin to make
  // those changes... everyone sees admin's version"). Every admin-gated
  // GET below (/permanent-tabs, /removed-default-tabs, /tab-order) checks
  // the identical isDashboardAdmin(req) server-side and returns the same
  // `editable` value for this viewer, so ONE shared flag here (set by
  // whichever of those fetches resolves first) is enough -- no need for a
  // separate per-endpoint admin flag.
  let isTabAdmin = false;

  // Serializes every admin action that round-trips to the server (add/
  // remove/restore/reorder) so a second action started before the first
  // one's PUT has actually completed waits for it, instead of both
  // reading the same stale "current" array and one silently overwriting
  // the other's change when their responses land out of order -- real
  // bug, confirmed live: removing several tabs in quick succession could
  // lose some of them, and a refresh would bring the "removed" ones back
  // since the server never actually got the final state. Wrap every
  // mutating action in queueAction(() => ...) rather than calling it
  // directly.
  let actionQueue = Promise.resolve();
  function queueAction(fn) {
    const result = actionQueue.then(fn, fn);
    actionQueue = result.then(
      () => {},
      () => {}
    );
    return result;
  }

  // Tabs the dashboard admin has added, beyond the built-in defaults.
  // Genuinely shared (every viewer sees the same tabs), lives server-side
  // (GET/PUT <apiBase>/permanent-tabs, backed by a small JSON file per
  // tabbed page). Starts empty and gets filled in by fetchPermanentTabs()
  // once mount() runs.
  let permanentTabIds = [];

  // Built-in tabs the admin has removed for everyone -- by request
  // ("give me the ability to remove tabs from a tab page"). DEFAULT_TABS/
  // DEFAULT_TAB_IDS themselves never change (that's this page's own
  // generated client.js's fixed defaultTabs config); this is a separate,
  // shared exclusion list layered on top (GET/PUT <apiBase>/removed-
  // default-tabs, backed by its own small JSON file, same admin-gated
  // shape permanentTabIds already uses). Starts empty, filled in by
  // fetchRemovedDefaultTabs() once mount() runs -- same "render
  // immediately with what's already known, let the fetch fill in once it
  // resolves" pattern as permanentTabIds.
  let removedDefaultTabIds = [];

  // Reorderable (drag-and-drop, see wireDragReorder below), by request --
  // admin-only (isTabAdmin, above), genuinely shared (tab-order.json,
  // GET/PUT <apiBase>/tab-order, same admin-only-write shape
  // permanentTabIds/removedDefaultTabIds already use) -- no per-viewer
  // override of any kind. savedTabOrderIds is the raw array as last
  // fetched/pushed; tabOrder (below) is always DERIVED from it plus the
  // current permanentTabIds/removedDefaultTabIds via computeTabOrder(),
  // never patched incrementally -- confirmed the hard way this matters:
  // fetchPermanentTabs()/fetchRemovedDefaultTabs()/fetchSharedTabOrder()
  // all fire concurrently on mount and each used to read-modify-write
  // the SAME tabOrder array independently, so whichever one resolved
  // last could silently stomp the other two's changes (a tab "vanishing"
  // or a reorder "dropping back to where it was" -- real bug, confirmed
  // live). Recomputing fresh from the three raw inputs every time, no
  // matter which order the fetches land in, is idempotent and immune to
  // this.
  let savedTabOrderIds = [];
  function computeTabOrder() {
    const knownIds = [...DEFAULT_TAB_IDS].filter((tabId) => !removedDefaultTabIds.includes(tabId));
    for (const tabId of permanentTabIds) knownIds.push(tabId);
    const ordered = savedTabOrderIds.filter((tabId) => knownIds.includes(tabId));
    for (const tabId of knownIds) {
      if (!ordered.includes(tabId)) ordered.push(tabId);
    }
    return ordered;
  }
  // Module scope so it survives a remount (navigate away and back within
  // the same browser session), same convention every other page's
  // lastData uses -- recomputed, not reassigned directly, everywhere
  // below (see computeTabOrder() above).
  let tabOrder = computeTabOrder();

  // Which tab was active, PERSONAL to this browser (localStorage) -- by
  // request, "when refreshing a tabbed page, go back to the tab you were
  // on before clicking refresh", applied to every tabbed page at once
  // since they all share this one factory. This is just navigation
  // memory (which tab YOU were looking at), not a customization of which
  // tabs exist or their order, so it's unaffected by removing the
  // personal-tabs/personal-order concepts above -- validated against the
  // known-at-this-point id set (plus the Help tab) -- a stale id (a
  // permanent tab removed since, or one not yet known this early) just
  // falls back to the first tab, same as a brand-new visit, rather than
  // erroring.
  const LAST_ACTIVE_TAB_KEY = `${id}.lastActiveTab`;
  function loadLastActiveTabId(knownIds) {
    let saved;
    try {
      saved = localStorage.getItem(LAST_ACTIVE_TAB_KEY);
    } catch {
      saved = null;
    }
    return saved && knownIds.has(saved) ? saved : tabOrder[0];
  }
  function saveLastActiveTabId(tabId) {
    try {
      localStorage.setItem(LAST_ACTIVE_TAB_KEY, tabId);
    } catch {
      // localStorage unavailable -- a refresh just lands on the first tab again, same as before this existed.
    }
  }
  let lastActiveTabId = loadLastActiveTabId(new Set([...DEFAULT_TAB_IDS, HELP_TAB.id]));

  // Minimize the tab strip down to just a toggle button, by request --
  // for small screens, where a whole row of tabs eats a lot of vertical
  // space. Per-BROWSER (localStorage, same "personal viewing preference"
  // pattern the sidebar's own collapsed/pinned toggles use in app.js),
  // defaults to NOT minimized, by request.
  const TAB_BAR_MINIMIZED_KEY = `${id}.tabBarMinimized`;
  function loadTabBarMinimized() {
    try {
      return localStorage.getItem(TAB_BAR_MINIMIZED_KEY) === 'true';
    } catch {
      return false;
    }
  }
  function saveTabBarMinimized(value) {
    try {
      localStorage.setItem(TAB_BAR_MINIMIZED_KEY, String(value));
    } catch {
      // localStorage unavailable -- the choice still applies for this page load, just won't persist.
    }
  }
  let tabBarMinimized = loadTabBarMinimized();

  // Custom, admin-editable notes shown on this page's own Help tab, on
  // top of the always-generated "how this works" explanation below --
  // by request. Genuinely shared (every viewer sees the same notes), so
  // fetched from the server (<apiBase>/help-text) the same way
  // permanentTabIds is, not stored locally.
  let customHelpText = '';
  let isHelpEditable = false;
  // Whether the inline textarea editor is currently open -- reset
  // whenever a non-Help tab is selected (see selectTab() below), so
  // coming back to Help later never reopens a stale editor.
  let helpEditing = false;

  return function mount(container) {
    container.innerHTML = `
      <div class="tab-bar" id="tab-page-bar"></div>
      <div id="tab-page-content"></div>
    `;

    const tabBarEl = container.querySelector('#tab-page-bar');
    const tabContentEl = container.querySelector('#tab-page-content');

    // Wired ONCE per mount, not inside renderTabBar() -- tabBarEl itself
    // persists across re-renders (only its own children get replaced by
    // innerHTML each time), so attaching this every render would stack
    // up duplicate listeners and fire a single real drop more than once.
    wireSidebarDropTarget();

    // Renders immediately with whatever permanentTabIds/isTabAdmin
    // already are (empty/false on a first-ever load this session, or
    // already-populated on a same-session remount) rather than waiting
    // on the fetch below -- built-in tabs show with no delay; permanent
    // ones pop in once fetchPermanentTabs() resolves.
    renderTabBar();
    selectTab(lastActiveTabId);
    fetchPermanentTabs();
    fetchRemovedDefaultTabs();
    fetchSharedTabOrder();
    fetchHelpText();

    // Recomputes tabOrder fresh from the three current raw inputs
    // (computeTabOrder(), factory scope) and re-renders -- called after
    // EVERY state change below instead of patching tabOrder directly, so
    // the three independent, concurrent fetchX() calls below can never
    // stomp each other regardless of which order they resolve in (see
    // computeTabOrder()'s own comment). Jumps off the active tab first
    // if it's no longer in the new order (can happen if a tab was
    // removed from a DIFFERENT browser since this one last loaded).
    function syncTabOrder() {
      tabOrder = computeTabOrder();
      if (!tabOrder.includes(lastActiveTabId) && lastActiveTabId !== HELP_TAB.id) {
        selectTab(tabOrder[0] ?? HELP_TAB.id);
      } else {
        renderTabBar();
      }
    }

    async function fetchSharedTabOrder() {
      try {
        const res = await fetch(`${apiBase}/tab-order`);
        const data = await res.json();
        if (!res.ok) return;
        isTabAdmin = !!data.editable;
        savedTabOrderIds = Array.isArray(data.tabIds) ? data.tabIds : [];
        syncTabOrder();
      } catch {
        // Best-effort, same reasoning as the other fetchX() functions here.
      }
    }

    async function fetchPermanentTabs() {
      try {
        const res = await fetch(`${apiBase}/permanent-tabs`);
        const data = await res.json();
        if (!res.ok) return;
        permanentTabIds = (data.tabIds || []).filter((tabId) => PAGES_BY_ID.has(tabId) && !DEFAULT_TAB_IDS.has(tabId) && tabId !== id);
        isTabAdmin = !!data.editable;
        syncTabOrder();
      } catch {
        // Best-effort -- permanent tabs just won't show for this load if
        // the fetch fails; built-in tabs still work regardless.
      }
    }

    async function fetchRemovedDefaultTabs() {
      try {
        const res = await fetch(`${apiBase}/removed-default-tabs`);
        const data = await res.json();
        if (!res.ok) return;
        removedDefaultTabIds = (data.tabIds || []).filter((tabId) => DEFAULT_TAB_IDS.has(tabId));
        syncTabOrder();
      } catch {
        // Best-effort -- same reasoning as fetchPermanentTabs() above;
        // every built-in tab just shows as normal if this fails.
      }
    }

    async function fetchHelpText() {
      try {
        const res = await fetch(`${apiBase}/help-text`);
        const data = await res.json();
        if (!res.ok) return;
        customHelpText = data.text || '';
        isHelpEditable = !!data.editable;
        // Only re-render if the Help tab is what's actually showing right
        // now -- this fetch can resolve well after the viewer has already
        // moved on to a different tab, and overwriting THAT with Help's
        // own content would be wrong.
        if (lastActiveTabId === HELP_TAB.id) renderHelpTab();
      } catch {
        // Best-effort -- custom notes just won't show for this load if
        // the fetch fails; the generated explanation still works regardless.
      }
    }

    // Combines the built-in tabs with whatever the admin has added,
    // resolving each one's real label fresh from PAGES_BY_ID every time
    // -- recomputed rather than cached, since both sources can change at
    // runtime.
    function allTabsById() {
      const map = new Map(DEFAULT_TABS_BY_ID);
      for (const tabId of removedDefaultTabIds) map.delete(tabId);
      for (const tabId of permanentTabIds) {
        const page = PAGES_BY_ID.get(tabId);
        if (page) map.set(tabId, { id: tabId, label: page.label });
      }
      return map;
    }

    // Renders the tab strip in tabOrder's current order (draggable for
    // the admin only -- see wireDragReorder below, a non-admin's strip is
    // read-only) plus HELP_TAB fixed at the end, with a minimize toggle
    // BEFORE all of them (by request -- "put it before the 1st menu item
    // so that it's easily accessible on small screens"). Called again
    // after every reorder, add, remove, or minimize toggle.
    function renderTabBar() {
      // Minimizing "collapses upward" -- by request, not a shrink-in-
      // place to a smaller strip but every tab button vanishing entirely,
      // leaving only this one tiny toggle, to actually reclaim vertical
      // space on a small screen. A downward chevron reads as "pull this
      // open"; the mirror upward chevron shown once expanded reads as
      // "push this back up" -- .tab-bar--minimized (styles.css) also
      // drops the strip's own bottom padding/divider in this state so
      // there's really nothing left but the button.
      tabBarEl.classList.toggle('tab-bar--minimized', tabBarMinimized);

      if (tabBarMinimized) {
        tabBarEl.innerHTML = `<button type="button" class="tab-bar-toggle" id="tab-bar-toggle" title="Expand tabs" aria-label="Expand tabs">&#9662;</button>`;
      } else {
        const toggleBtnHtml = `<button type="button" class="tab-bar-toggle" id="tab-bar-toggle" title="Minimize tabs" aria-label="Minimize tabs">&#9652;</button>`;
        const tabsById = allTabsById();
        const orderedTabs = tabOrder.map((tabId) => tabsById.get(tabId)).filter(Boolean);
        tabBarEl.innerHTML =
          toggleBtnHtml +
          orderedTabs
            .map((t) => `<button type="button" class="tab-button" draggable="${isTabAdmin}" data-tab-id="${t.id}">${escapeHtml(t.label)}</button>`)
            .join('') +
          `<button type="button" class="tab-button tab-button--small" data-tab-id="${HELP_TAB.id}">${escapeHtml(HELP_TAB.label)}</button>`;

        tabBarEl.querySelectorAll('.tab-button').forEach((btn) => {
          const tabId = btn.dataset.tabId;
          btn.classList.toggle('active', tabId === lastActiveTabId);
          btn.addEventListener('click', () => selectTab(tabId));
          // Admin-only right-click: remove this tab (a built-in one, or
          // one the admin added -- see showTabContextMenu() below) --
          // never on Help, which is always fixed.
          if (isTabAdmin && tabId !== HELP_TAB.id) {
            btn.addEventListener('contextmenu', (e) => {
              e.preventDefault();
              showTabContextMenu(e.clientX, e.clientY, tabId);
            });
          }
        });

        wireDragReorder();
      }

      tabBarEl.querySelector('#tab-bar-toggle').addEventListener('click', () => {
        tabBarMinimized = !tabBarMinimized;
        saveTabBarMinimized(tabBarMinimized);
        renderTabBar();
      });
    }

    // Plain HTML5 drag-and-drop, same event set (dragstart/dragover/drop,
    // .dragging/.drag-over classes) the sidebar's own nav-layout editor
    // uses in app.js, for a consistent interaction feel across the
    // dashboard -- drop on another tab REORDERS the shared tabOrder;
    // dropping OUTSIDE any valid target entirely (dragend's dropEffect
    // comes back 'none') REMOVES the tab (a built-in one via
    // removeDefaultTab(), an admin-added one via removePermanent()),
    // "dragging it back out", by request -- same effect right-click's
    // own "Remove This Tab" has. Admin-only: only an admin's own tab
    // buttons render draggable="true" at all (see renderTabBar() above),
    // so this whole function only ever wires up real listeners for them;
    // a non-admin's tab bar is read-only. Uses a plain closure variable
    // (dragSrcId), NOT the sidebar's own dataTransfer-based channel -- a
    // completely separate drag operation from "drag a page in from the
    // sidebar" below, so the two never interfere with each other (see
    // the dataTransfer.types check in both handlers here, which lets a
    // sidebar-page drag fall through/bubble up to the tab bar's own drop
    // target instead of being swallowed here).
    function wireDragReorder() {
      let dragSrcId = null;
      tabBarEl.querySelectorAll('.tab-button[draggable="true"]').forEach((btn) => {
        const tabId = btn.dataset.tabId;
        btn.addEventListener('dragstart', (e) => {
          dragSrcId = tabId;
          btn.classList.add('dragging');
          e.dataTransfer.effectAllowed = 'move';
        });
        btn.addEventListener('dragend', (e) => {
          btn.classList.remove('dragging');
          if (e.dataTransfer.dropEffect !== 'none') return; // dropped somewhere valid -- already handled by that drop
          if (tabId === HELP_TAB.id) return; // Help is always fixed
          if (DEFAULT_TAB_IDS.has(tabId)) removeDefaultTab(tabId);
          else removePermanent(tabId);
        });
        btn.addEventListener('dragover', (e) => {
          if (e.dataTransfer.types.includes(SIDEBAR_DRAG_TYPE)) return; // a sidebar-page drag -- let it bubble to wireSidebarDropTarget() instead
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          btn.classList.add('drag-over');
        });
        btn.addEventListener('dragleave', () => btn.classList.remove('drag-over'));
        btn.addEventListener('drop', (e) => {
          if (e.dataTransfer.types.includes(SIDEBAR_DRAG_TYPE)) return; // same -- handled by wireSidebarDropTarget() once this bubbles up
          e.preventDefault();
          btn.classList.remove('drag-over');
          const targetId = tabId;
          if (!dragSrcId || dragSrcId === targetId) return;
          const fromIndex = tabOrder.indexOf(dragSrcId);
          const toIndex = tabOrder.indexOf(targetId);
          if (fromIndex === -1 || toIndex === -1) return; // dropped on the (non-draggable) Help tab -- no-op
          const next = [...tabOrder];
          next.splice(fromIndex, 1);
          next.splice(toIndex, 0, dragSrcId);
          // Applied locally straight away (savedTabOrderIds too, not just
          // tabOrder -- so a still-in-flight fetchX() from page load that
          // resolves AFTER this drag recomputes from this fresh value,
          // never a stale one that would silently undo it) for instant
          // feedback; the network push is queued (see queueAction's own
          // comment) so a second rapid drag can't have its PUT overwritten
          // by this one's if the responses land out of order.
          savedTabOrderIds = next;
          tabOrder = next;
          renderTabBar();
          queueAction(() => pushSharedTabOrder(next));
        });
      });
    }

    async function pushSharedTabOrder(order) {
      try {
        await fetch(`${apiBase}/tab-order`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tabIds: order }),
        });
      } catch {
        // Best-effort -- this viewer's own order already applied locally
        // regardless, only the SHARED push failed.
      }
    }

    // Dragging a page in FROM the sidebar (app.js's own .nav-item
    // dragstart) adds it as a tab for EVERYONE -- admin-only, same as
    // reordering/removing above; a non-admin dropping a page that isn't
    // already a tab here is a no-op (dropping one that already IS a tab
    // still just jumps to it, harmless for anyone).
    //
    // Wired on the WHOLE mounted page (`container`), not just the thin
    // tab strip -- dropping anywhere on this page while dragging a
    // sidebar page adds it as a tab, which is far more forgiving to
    // actually land than just the compact bar itself. Plain bubble-phase
    // listeners (confirmed working against a real browser -- an earlier
    // capture-phase version never actually fired, for reasons that
    // weren't fully pinned down, so this sticks to the simpler pattern
    // that's proven to work). A drop landing directly on an existing tab
    // button still reaches this handler by bubbling up -- that button's
    // own dragover/drop handlers above explicitly skip a sidebar-page
    // drag via the same dataTransfer.types check, letting it pass
    // through untouched.
    function wireSidebarDropTarget() {
      container.addEventListener('dragover', (e) => {
        if (!e.dataTransfer.types.includes(SIDEBAR_DRAG_TYPE)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        tabBarEl.classList.add('tab-bar--drop-target');
      });
      container.addEventListener('dragleave', (e) => {
        if (!container.contains(e.relatedTarget)) tabBarEl.classList.remove('tab-bar--drop-target');
      });
      container.addEventListener('drop', (e) => {
        if (!e.dataTransfer.types.includes(SIDEBAR_DRAG_TYPE)) return;
        e.preventDefault();
        tabBarEl.classList.remove('tab-bar--drop-target');
        const pageId = e.dataTransfer.getData(SIDEBAR_DRAG_TYPE);
        if (pageId) addTab(pageId);
      });
    }

    function addTab(pageId) {
      if (pageId === id) return; // dragging this page itself onto its own tab bar -- no-op
      // A removed built-in tab dragged back in from the sidebar restores
      // it, rather than treating it as "already a tab here" (it isn't,
      // any more) -- a second, more discoverable way back besides the
      // Help tab's own "Restore" button below, for whichever page still
      // independently has a sidebar entry of its own.
      if (DEFAULT_TAB_IDS.has(pageId) && removedDefaultTabIds.includes(pageId)) {
        if (isTabAdmin) restoreDefaultTab(pageId);
        return;
      }
      if (DEFAULT_TAB_IDS.has(pageId) || permanentTabIds.includes(pageId)) {
        selectTab(pageId); // already a tab here -- just jump to it, harmless for anyone
        return;
      }
      if (!isTabAdmin || !PAGES_BY_ID.has(pageId)) return; // only the admin can add a genuinely NEW tab
      makePermanent(pageId);
    }

    // The two admin-only actions -- see the module-level comment on
    // permanentTabIds above for why these are a server round trip
    // rather than a local-only change.
    async function savePermanentTabIds(nextIds) {
      try {
        const res = await fetch(`${apiBase}/permanent-tabs`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tabIds: nextIds }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        return true;
      } catch (err) {
        alert(`Error: ${err.message}`);
        return false;
      }
    }

    // The one way a genuinely new tab ever gets added (from addTab()
    // above, admin-only) -- shared immediately for everyone, there's no
    // separate "personal, not yet permanent" state any more. Wrapped in
    // queueAction() (see its own comment) -- every mutating action below
    // is, same reasoning throughout.
    function makePermanent(pageId) {
      return queueAction(async () => {
        if (permanentTabIds.includes(pageId)) return;
        const next = [...permanentTabIds, pageId];
        if (!(await savePermanentTabIds(next))) return;
        permanentTabIds = next;
        tabOrder = computeTabOrder();
        savedTabOrderIds = tabOrder;
        await pushSharedTabOrder(tabOrder);
        // Auto-expand if minimized -- otherwise a drag-drop while
        // minimized would silently succeed with nothing visibly
        // different on screen.
        if (tabBarMinimized) {
          tabBarMinimized = false;
          saveTabBarMinimized(false);
        }
        renderTabBar();
        selectTab(pageId); // jump straight to the newly added tab
      });
    }

    function removePermanent(pageId) {
      return queueAction(async () => {
        if (!permanentTabIds.includes(pageId)) return;
        const next = permanentTabIds.filter((tabId) => tabId !== pageId);
        if (!(await savePermanentTabIds(next))) return;
        permanentTabIds = next;
        tabOrder = computeTabOrder();
        savedTabOrderIds = tabOrder;
        await pushSharedTabOrder(tabOrder);
        if (lastActiveTabId === pageId) selectTab(tabOrder[0] ?? HELP_TAB.id);
        else renderTabBar();
      });
    }

    // Removing/restoring a BUILT-IN tab, by request -- DEFAULT_TAB_IDS
    // membership never changes (that's the page's own fixed defaultTabs
    // config), only whether a given id is currently excluded via
    // removedDefaultTabIds, so removing one simply drops it from view
    // for everyone until an admin restores it (right-click here, drag it
    // back in from the sidebar if it still has its own entry there --
    // see addTab() -- or the Help tab's own "Removed tabs" list below).
    async function saveRemovedDefaultTabIds(nextIds) {
      try {
        const res = await fetch(`${apiBase}/removed-default-tabs`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tabIds: nextIds }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        return true;
      } catch (err) {
        alert(`Error: ${err.message}`);
        return false;
      }
    }

    function removeDefaultTab(pageId) {
      return queueAction(async () => {
        if (removedDefaultTabIds.includes(pageId)) return;
        const next = [...removedDefaultTabIds, pageId];
        if (!(await saveRemovedDefaultTabIds(next))) return;
        removedDefaultTabIds = next;
        tabOrder = computeTabOrder();
        savedTabOrderIds = tabOrder;
        await pushSharedTabOrder(tabOrder);
        if (lastActiveTabId === pageId) selectTab(tabOrder[0] ?? HELP_TAB.id);
        else renderTabBar();
      });
    }

    function restoreDefaultTab(pageId) {
      return queueAction(async () => {
        if (!removedDefaultTabIds.includes(pageId)) return;
        const next = removedDefaultTabIds.filter((tabId) => tabId !== pageId);
        if (!(await saveRemovedDefaultTabIds(next))) return;
        removedDefaultTabIds = next;
        tabOrder = computeTabOrder();
        savedTabOrderIds = tabOrder;
        await pushSharedTabOrder(tabOrder);
        renderTabBar();
        if (lastActiveTabId === HELP_TAB.id) renderHelpTab(); // "Removed tabs" list needs to drop this one too
      });
    }

    // Admin-only right-click menu (just "Remove This Tab" -- same
    // underlying action, drag-out, already covers the only other case
    // this used to handle) -- a small, self-contained popup, same visual language
    // (.nav-context-menu/.nav-context-menu-item) the sidebar's own
    // hide/unhide/rename right-click menu uses (see app.js's
    // showNavContextMenu), but re-implemented locally here rather than
    // imported -- this module and the shell's app.js are separate,
    // unrelated JS modules with no shared code path between them.
    let openTabMenu = null;
    let tabMenuDismiss = null;
    function closeTabContextMenu() {
      if (!openTabMenu) return;
      openTabMenu.remove();
      openTabMenu = null;
      if (tabMenuDismiss) {
        document.removeEventListener('click', tabMenuDismiss.onDismiss);
        document.removeEventListener('scroll', tabMenuDismiss.onDismiss, true);
        document.removeEventListener('keydown', tabMenuDismiss.onKeydown);
        tabMenuDismiss = null;
      }
    }
    function showTabContextMenu(x, y, pageId) {
      closeTabContextMenu();
      const isDefault = DEFAULT_TAB_IDS.has(pageId);

      const menu = document.createElement('div');
      menu.className = 'nav-context-menu';
      menu.style.left = `${x}px`;
      menu.style.top = `${y}px`;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'nav-context-menu-item';
      btn.textContent = 'Remove This Tab';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeTabContextMenu();
        if (isDefault) removeDefaultTab(pageId);
        else removePermanent(pageId);
      });
      menu.appendChild(btn);

      document.body.appendChild(menu);
      openTabMenu = menu;

      const onDismiss = () => closeTabContextMenu();
      const onKeydown = (e) => {
        if (e.key === 'Escape') closeTabContextMenu();
      };
      tabMenuDismiss = { onDismiss, onKeydown };
      setTimeout(() => {
        document.addEventListener('click', onDismiss);
        document.addEventListener('scroll', onDismiss, true);
        document.addEventListener('keydown', onKeydown);
      }, 0);
    }

    async function selectTab(tabId) {
      if (!tabId) tabId = HELP_TAB.id; // every real tab removed -- Help is always there
      lastActiveTabId = tabId;
      saveLastActiveTabId(tabId);
      // Dashboard-wide Help button (app.js's openHelpModal()) reads this
      // to know which real page's README to show for a "-tabs" wrapper
      // page -- the active TAB's own underlying page id, not this
      // wrapper's own (app.js's loadPage() already set it to the
      // wrapper's id by default; this overrides it). Guarded to skip
      // HELP_TAB itself ('help') -- that's this page's own built-in Help
      // TAB (admin-editable notes, see renderHelpTab() below), a
      // different, unrelated feature; if it weren't guarded, viewing that
      // tab would wrongly clobber this with the literal string 'help',
      // which isn't a real page id anywhere.
      if (tabId !== HELP_TAB.id) container.dataset.helpPageId = tabId;
      tabBarEl.querySelectorAll('.tab-button').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.tabId === tabId);
      });

      if (tabId === 'help') {
        renderHelpTab();
        return;
      }
      helpEditing = false; // leaving Help -- don't come back to a stale open editor later

      tabContentEl.innerHTML = '<p class="status">Loading...</p>';
      try {
        // Dynamic import of the REAL page module, same path the shell's
        // own sidebar navigation loads -- not a copy, not a separate
        // fetch of the same data. The browser's own module cache means
        // visiting this tab and that page's own sidebar entry in the
        // same session share one live module instance (and its
        // module-scope lastData-style caching), which is a feature
        // here, not a bug.
        const mod = await import(`/pages/${tabId}/client.js`);
        tabContentEl.innerHTML = '';
        mod.mount(tabContentEl);
      } catch (err) {
        tabContentEl.innerHTML = `<p class="status error">Error loading this tab: ${escapeHtml(err.message)}</p>`;
      }
    }

    // True once stripped of tags/whitespace -- customHelpText is HTML
    // now (see renderHelpTab() below), so a "no notes yet" check can't
    // just be `!customHelpText`: contenteditable's own habit of leaving
    // an empty `<div><br></div>` behind after the last character is
    // deleted would otherwise still count as "has notes".
    function isHelpTextBlank(html) {
      if (!html) return true;
      const probe = document.createElement('div');
      probe.innerHTML = html;
      return probe.textContent.trim() === '';
    }

    // Toolbar commands for the rich-text editor below -- Bold/Italic/
    // Bulleted list/Numbered list/Link, by request ("rich text
    // formatting" over a plain textarea). document.execCommand() is
    // deprecated but still functional in every browser this dashboard
    // actually runs in for exactly this small a command set (no rich-
    // text library pulled in for what's a handful of admin notes --
    // same "zero new runtime dependencies where a simple native option
    // exists" reasoning as this dashboard's own server-side sqlite
    // choice). `prompt` for the link URL is the simplest reliable input
    // for a one-off value, same reasoning renamePage()/etc. elsewhere on
    // this dashboard already use prompt() for.
    const HELP_TOOLBAR_COMMANDS = [
      { label: 'B', title: 'Bold', command: 'bold', style: 'font-weight:700;' },
      { label: 'I', title: 'Italic', command: 'italic', style: 'font-style:italic;' },
      { label: '• List', title: 'Bulleted list', command: 'insertUnorderedList' },
      { label: '1. List', title: 'Numbered list', command: 'insertOrderedList' },
      { label: '🔗 Link', title: 'Link', command: 'createLink', promptForUrl: true },
    ];

    // Generic (not hand-written per tab) -- built-in tab NAMES are listed
    // (so it's still a useful orientation), but the mechanism itself
    // (drag to add, right-click for admin) is what's explained, since
    // this same generated explanation is shared by every tabbed page on
    // the dashboard rather than maintained separately per page. On top
    // of it, an admin-editable CUSTOM notes section -- by request, "the
    // capability to edit the help pages" -- fetched via fetchHelpText()
    // above, shown first, with its own inline rich-text editor (admin
    // only) toggled by helpEditing. customHelpText holds real HTML (a
    // contenteditable div's own innerHTML), not plain text -- rendered
    // directly (trusted, admin-authored content, same "server/admin-
    // supplied HTML is trusted" model this dashboard's own link-building
    // helpers already use elsewhere), not escaped.
    function renderHelpTab() {
      if (helpEditing) {
        const toolbarHtml = HELP_TOOLBAR_COMMANDS.map(
          (c) => `<button type="button" class="button-link button-link--small" data-help-command="${c.command}" data-help-prompt="${!!c.promptForUrl}" title="${escapeHtml(c.title)}" style="${c.style || ''}">${c.label}</button>`
        ).join(' ');
        tabContentEl.innerHTML = `
          <div class="resource-group" style="padding: 0.25rem 1.25rem 1.25rem;">
            <h2 style="font-size: 1rem;">Edit notes for this page</h2>
            <div style="margin-bottom:0.4rem;">${toolbarHtml}</div>
            <div id="help-text-input" contenteditable="true" style="display:block; width:100%; max-width:40rem; min-height:8rem; font:inherit; box-sizing:border-box; border:1px solid var(--border); border-radius:6px; padding:0.5rem 0.75rem; background:var(--bg);">${customHelpText}</div>
            <div class="date-form" style="margin-top:0.5rem;">
              <button type="button" id="save-help-btn">Save</button>
              <button type="button" id="cancel-help-btn">Cancel</button>
            </div>
          </div>
        `;
        const editableEl = tabContentEl.querySelector('#help-text-input');
        // preventDefault on mousedown (not click) is what actually keeps
        // the contenteditable's current text selection alive -- a button
        // click alone would blur the editable div FIRST (losing the
        // selection execCommand needs to act on) before the click handler
        // even runs.
        tabContentEl.querySelectorAll('[data-help-command]').forEach((btn) => {
          btn.addEventListener('mousedown', (e) => e.preventDefault());
          btn.addEventListener('click', () => {
            const command = btn.dataset.helpCommand;
            if (btn.dataset.helpPrompt === 'true') {
              const url = prompt('Link URL:', 'https://');
              if (!url) return;
              document.execCommand(command, false, url);
            } else {
              document.execCommand(command, false, null);
            }
            editableEl.focus();
          });
        });
        tabContentEl.querySelector('#cancel-help-btn').addEventListener('click', () => {
          helpEditing = false;
          renderHelpTab();
        });
        tabContentEl.querySelector('#save-help-btn').addEventListener('click', async () => {
          const text = editableEl.innerHTML;
          try {
            const res = await fetch(`${apiBase}/help-text`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
            customHelpText = text;
            helpEditing = false;
            renderHelpTab();
          } catch (err) {
            alert(`Error: ${err.message}`);
          }
        });
        return;
      }

      // By request (2026-11-01): tabs are admin-only to add/remove/
      // reorder now, shared for everyone -- no more per-viewer "personal"
      // tabs or order. These explanations only show for the admin;
      // everyone else just sees whatever tabs the admin has set, with no
      // affordance to change them.
      const adminNote = isTabAdmin
        ? `<p class="inline-subtext">You're the dashboard admin: drag any other page from the sidebar onto the
            tab strip above to add it here for everyone (it stays in its own place in the sidebar too, this just
            adds a shortcut), drag any tab in the strip to reorder it, or right-click a tab (or drag it out) to
            remove it -- a removed BUILT-IN tab can be restored from the list below, or by dragging that page
            back in from the sidebar if it still has its own entry there. You can also rename this page itself
            from the sidebar (right-click "${escapeHtml(label)}").</p>`
        : '';
      // Admin-only, by request -- a removed built-in tab doesn't
      // necessarily still have its own sidebar entry to drag back in
      // from (see addTab()'s own restore path), so this is the
      // guaranteed way back regardless. Only ever lists ids still in
      // removedDefaultTabIds -- resolved against DEFAULT_TABS_BY_ID
      // (not allTabsById(), which excludes them) since that's the one
      // map that still carries a removed tab's own label.
      const removedDefaultTabsHtml =
        isTabAdmin && removedDefaultTabIds.length > 0
          ? `<p class="inline-subtext">Removed tabs: ${removedDefaultTabIds
              .map((tabId) => {
                const tab = DEFAULT_TABS_BY_ID.get(tabId);
                return tab ? `${escapeHtml(tab.label)} <button type="button" class="button-link button-link--small" data-restore-tab-id="${tabId}">Restore</button>` : '';
              })
              .join(' &middot; ')}</p>`
          : '';
      const hasNotes = !isHelpTextBlank(customHelpText);
      const customSectionHtml = hasNotes ? `<div style="margin-bottom: 0.75rem;">${customHelpText}</div>` : '';
      const editButtonHtml = isHelpEditable
        ? `<button type="button" id="edit-help-btn" class="button-link button-link--small" style="margin-bottom:0.75rem;">${hasNotes ? 'Edit Notes' : 'Add Notes'}</button>`
        : '';

      // The "About this page" heading, the "Each tab above mounts..."
      // paragraph, and the built-in-tabs list were removed, by request --
      // just boilerplate ahead of the actually-useful bits (the custom
      // notes, and the admin explanation right below).
      tabContentEl.innerHTML = `
        <div class="resource-group" style="padding: 0.25rem 1.25rem 1.25rem;">
          ${customSectionHtml}
          ${editButtonHtml}
          ${adminNote}
          ${removedDefaultTabsHtml}
        </div>
      `;
      const editBtn = tabContentEl.querySelector('#edit-help-btn');
      if (editBtn) {
        editBtn.addEventListener('click', () => {
          helpEditing = true;
          renderHelpTab();
        });
      }
      tabContentEl.querySelectorAll('[data-restore-tab-id]').forEach((btn) => {
        btn.addEventListener('click', () => restoreDefaultTab(btn.dataset.restoreTabId));
      });
    }

    function escapeHtml(str) {
      if (str === null || str === undefined) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }
  };
}
