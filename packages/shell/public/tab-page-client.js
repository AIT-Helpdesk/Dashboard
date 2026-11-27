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

// The one thing every tabbed page provides: its own id/label (for
// self-reference exclusion), where its own permanent-tabs/removed-
// default-tabs/tab-order GET/PUT live (apiBase, backed by
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
  // known-at-this-point id set -- a stale id (a permanent tab removed
  // since, or one not yet known this early) just falls back to the first
  // tab, same as a brand-new visit, rather than erroring.
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
  let lastActiveTabId = loadLastActiveTabId(DEFAULT_TAB_IDS);

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
      if (!tabOrder.includes(lastActiveTabId)) {
        selectTab(tabOrder[0]);
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

    // Combines the built-in tabs with whatever the admin has added,
    // resolving each one's real label fresh from PAGES_BY_ID every time
    // -- recomputed rather than cached, since both sources can change at
    // runtime. This now includes the DEFAULT tabs too (not just
    // admin-added ones), by request/confirmed-live bug: a page renamed
    // after this tab page was first generated by Tab Page Builder kept
    // showing its OLD label forever here, no matter how many times the
    // page was removed + dragged back in -- removing then re-adding a
    // DEFAULT tab calls restoreDefaultTab() (just un-hides the frozen
    // snapshot), never makePermanent() (the live-label path), so there
    // was genuinely no way to ever see the new name short of hand-editing
    // this page's own generated default-tabs.json. DEFAULT_TAB_IDS
    // membership itself is still fixed (that part never needs live data,
    // only the label shown does) -- falls back to the frozen
    // defaultTabs label only if the page id no longer exists in the live
    // registry at all (e.g. a genuinely deleted page), same "degrade
    // gracefully" reasoning as every other missing-lookup on this
    // dashboard.
    function allTabsById() {
      const map = new Map(DEFAULT_TABS_BY_ID);
      for (const tabId of removedDefaultTabIds) map.delete(tabId);
      for (const tabId of map.keys()) {
        const page = PAGES_BY_ID.get(tabId);
        if (page) map.set(tabId, { id: tabId, label: page.label });
      }
      for (const tabId of permanentTabIds) {
        const page = PAGES_BY_ID.get(tabId);
        if (page) map.set(tabId, { id: tabId, label: page.label });
      }
      return map;
    }

    // Renders the tab strip in tabOrder's current order (draggable for
    // the admin only -- see wireDragReorder below, a non-admin's strip is
    // read-only). Called again after every reorder, add, or remove. (The
    // minimize-to-a-toggle-button state this used to have was removed by
    // request; the fixed Help tab that used to sit at the far right was
    // removed by request too.)
    function renderTabBar() {
      const tabsById = allTabsById();
      const orderedTabs = tabOrder.map((tabId) => tabsById.get(tabId)).filter(Boolean);
      tabBarEl.innerHTML = orderedTabs
        .map((t) => `<button type="button" class="tab-button" draggable="${isTabAdmin}" data-tab-id="${t.id}">${escapeHtml(t.label)}</button>`)
        .join('');

      tabBarEl.querySelectorAll('.tab-button').forEach((btn) => {
        const tabId = btn.dataset.tabId;
        btn.classList.toggle('active', tabId === lastActiveTabId);
        btn.addEventListener('click', () => selectTab(tabId));
        // Right-click -- wired for EVERY viewer now, not just the tab
        // admin (by request: "add that page to the current user's
        // favourites" needs to work for anyone, same as the sidebar's own
        // right-click Add/Remove Favourites). showTabContextMenu() below
        // is the one place that decides which actions actually show --
        // Remove This Tab stays admin-only there, Favourites doesn't.
        btn.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          showTabContextMenu(e.clientX, e.clientY, tabId);
        });
      });

      wireDragReorder();
    }

    // Plain HTML5 drag-and-drop, same event set (dragstart/dragover/drop,
    // .dragging/.drag-over classes) the sidebar's own nav-layout editor
    // uses in app.js, for a consistent interaction feel across the
    // dashboard -- drop on another tab REORDERS the shared tabOrder;
    // dropping OUTSIDE any valid target entirely (dragend's dropEffect
    // comes back 'none') asks confirmDeleteTab() below, then REMOVES the
    // tab on Confirm (a built-in one via removeDefaultTab(), an
    // admin-added one via removePermanent()) -- "dragging it back out",
    // by request, with a confirmation step added so an accidental drag
    // can't silently delete a tab. Same underlying effect right-click's
    // own "Remove This Tab" has (that one has no confirmation step, by
    // scope of the original request). Admin-only: only an admin's own tab
    // buttons render draggable="true" at all (see renderTabBar() above),
    // so this whole function only ever wires up real listeners for them;
    // a non-admin's tab bar is read-only. Uses a plain closure variable
    // (dragSrcId), NOT the sidebar's own dataTransfer-based channel -- a
    // completely separate drag operation from "drag a page in from the
    // sidebar" below, so the two never interfere with each other (see
    // the dataTransfer.types check in both handlers here, which lets a
    // sidebar-page drag fall through/bubble up to the tab bar's own drop
    // target instead of being swallowed here).
    // Same .history-modal-overlay/-panel shell + Promise<boolean> pattern
    // contract-checks/client.js's confirmReopenTicket() uses for its own
    // Confirm/Cancel dialogs. On Cancel/Escape/outside-click (all resolve
    // false), nothing needs undoing: the dragged button was never actually
    // moved in the DOM -- HTML5 drag only shows a ghost image -- so the
    // browser's own drag-return animation already snaps it back on its own.
    function confirmDeleteTab() {
      return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'history-modal-overlay';
        overlay.innerHTML = `
          <div class="history-modal-panel wsp-qa-modal-panel">
            <div class="history-modal-panel-header">
              <span>Delete Tab?</span>
            </div>
            <div class="history-modal-body">
              <p class="status">Do you want to delete this tab?</p>
              <div class="wsp-form-actions">
                <button type="button" class="button-link tab-delete-confirm-button">Confirm</button>
                <button type="button" class="tab-delete-cancel-button">Cancel</button>
              </div>
            </div>
          </div>
        `;
        document.body.appendChild(overlay);
        const finish = (value) => {
          overlay.remove();
          document.removeEventListener('keydown', onKeydown);
          resolve(value);
        };
        function onKeydown(e) {
          if (e.key === 'Escape') finish(false);
        }
        document.addEventListener('keydown', onKeydown);
        overlay.querySelector('.tab-delete-confirm-button').addEventListener('click', () => finish(true));
        overlay.querySelector('.tab-delete-cancel-button').addEventListener('click', () => finish(false));
        overlay.addEventListener('click', (e) => {
          if (e.target === overlay) finish(false);
        });
      });
    }

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
          confirmDeleteTab().then((confirmed) => {
            if (!confirmed) return;
            if (DEFAULT_TAB_IDS.has(tabId)) removeDefaultTab(tabId);
            else removePermanent(tabId);
          });
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
          if (fromIndex === -1 || toIndex === -1) return; // not a known draggable tab -- no-op
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
      // any more) -- the way back for whichever page still independently
      // has a sidebar entry of its own.
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
        if (lastActiveTabId === pageId) selectTab(tabOrder[0]);
        else renderTabBar();
      });
    }

    // Removing/restoring a BUILT-IN tab, by request -- DEFAULT_TAB_IDS
    // membership never changes (that's the page's own fixed defaultTabs
    // config), only whether a given id is currently excluded via
    // removedDefaultTabIds, so removing one simply drops it from view
    // for everyone until an admin restores it (right-click here, or drag
    // it back in from the sidebar if it still has its own entry there --
    // see addTab()).
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
        if (lastActiveTabId === pageId) selectTab(tabOrder[0]);
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

      // Admin-only, same as before this menu opened up to every viewer --
      // removing/reordering tabs stays a shared, admin-managed thing.
      if (isTabAdmin) {
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'nav-context-menu-item';
        removeBtn.textContent = 'Remove This Tab';
        removeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          closeTabContextMenu();
          if (isDefault) removeDefaultTab(pageId);
          else removePermanent(pageId);
        });
        menu.appendChild(removeBtn);
      }

      // Available to EVERY viewer, by request -- "add that page to the
      // current user's favourites menu category", the same personal,
      // server-side list the sidebar's own right-click Add/Remove
      // Favourites manages (app.js, exposed on window since this is a
      // separate module -- see app.js's own comment on toggleFavorite/
      // isPageFavorited for why). Both are only ever defined once app.js
      // itself has finished loading, which it always has by the time any
      // tabbed page mounts (app.js is the shell).
      if (window.toggleFavorite && window.isPageFavorited) {
        const favBtn = document.createElement('button');
        favBtn.type = 'button';
        favBtn.className = 'nav-context-menu-item';
        favBtn.textContent = window.isPageFavorited(pageId) ? 'Remove from Favourites' : 'Add to Favourites';
        favBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          closeTabContextMenu();
          window.toggleFavorite(pageId);
        });
        menu.appendChild(favBtn);
      }

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
      if (!tabId) {
        // Every real tab removed (an admin can empty every built-in and
        // permanent tab out) -- nothing left to show.
        lastActiveTabId = null;
        tabBarEl.querySelectorAll('.tab-button').forEach((btn) => btn.classList.remove('active'));
        tabContentEl.innerHTML = '<p class="status">No tabs available.</p>';
        return;
      }
      lastActiveTabId = tabId;
      saveLastActiveTabId(tabId);
      // Dashboard-wide Help button (app.js's openHelpModal()) reads this
      // to know which real page's README to show for a "-tabs" wrapper
      // page -- the active TAB's own underlying page id, not this
      // wrapper's own (app.js's loadPage() already set it to the
      // wrapper's id by default; this overrides it).
      container.dataset.helpPageId = tabId;
      tabBarEl.querySelectorAll('.tab-button').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.tabId === tabId);
      });

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
        tabContentEl.innerHTML = `<p class="status error">${escapeHtml(friendlyTabLoadError(err))}</p>`;
      }
    }

    // Same friendly substitution app.js's own loadPage() makes for a
    // dynamic-import failure (a copy, not a shared import -- see that
    // function's own comment for the full "why", including why this
    // deliberately doesn't try to tell a real permission block apart from
    // a session lost to a server restart -- both produce this exact same
    // opaque browser text, and a second probe fetch to distinguish them
    // isn't reliable). Any OTHER error (a real bug inside mount() itself)
    // still shows its own real message, unchanged.
    function friendlyTabLoadError(err) {
      if (/dynamically imported module/i.test(err.message)) {
        return 'This may be due to a recent update -- try refreshing the page. If it keeps happening, there may be a permission issue -- contact the administrator.';
      }
      return `Error loading this tab: ${err.message}`;
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
