// Shared, generic tabbed-page mount factory -- extracted from what was
// originally ticket-info-tabs' own client.js (a from-scratch experiment:
// show a handful of existing pages as tabs on one page instead of as
// separate sidebar entries, with drag-to-add-a-tab from the sidebar and
// an admin-only "make this tab permanent for everyone" escalation). Now
// used by every tabbed page on this dashboard -- including anything
// published later via Tab Page Builder -- so a fix here (like the real
// effectAllowed: 'copyMove' cross-browser drag/drop bug this went
// through) fixes every tabbed page at once, not just one.
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

  // Tabs dragged in from the sidebar, PERSONAL to this browser
  // (localStorage) -- by request, "leave it in its own place in the menu
  // too" (a copy, not a move: nothing about the sidebar itself changes
  // when a tab is added this way). Anyone, admin included, adding a tab
  // this way gets a personal shortcut only they see -- see
  // permanentTabIds below for the separate, admin-only, shared version
  // of this same idea. Keyed by this page's own id, so each tabbed page
  // keeps entirely separate personal state.
  const EXTRA_TABS_KEY = `${id}.extraTabs`;
  function loadExtraTabIds() {
    let saved;
    try {
      saved = JSON.parse(localStorage.getItem(EXTRA_TABS_KEY) || '[]');
    } catch {
      saved = [];
    }
    // Only ids that are still real, currently-visible pages, aren't
    // already one of the built-in tabs, and aren't this page itself -- a
    // page removed from the dashboard entirely, or one this viewer's own
    // account no longer sees, silently drops out rather than showing a
    // broken tab.
    return Array.isArray(saved) ? saved.filter((tabId) => PAGES_BY_ID.has(tabId) && !DEFAULT_TAB_IDS.has(tabId) && tabId !== id) : [];
  }
  function saveExtraTabIds(ids) {
    try {
      localStorage.setItem(EXTRA_TABS_KEY, JSON.stringify(ids));
    } catch {
      // localStorage unavailable -- extras just won't persist past this session.
    }
  }
  let extraTabIds = loadExtraTabIds();

  // Tabs the dashboard admin has explicitly made PERMANENT -- by request,
  // "force it to be permanent (permanent from a non-admin user point of
  // view)... only available to administrator". Genuinely shared (every
  // viewer sees these, not just the admin), so unlike extraTabIds above
  // this lives server-side (GET/PUT <apiBase>/permanent-tabs, backed by a
  // small JSON file per tabbed page) rather than localStorage. Starts
  // empty and gets filled in by fetchPermanentTabs() once mount() runs.
  let permanentTabIds = [];
  let isPermanentAdmin = false;

  // Reorderable (drag-and-drop, see wireDragReorder below), by request --
  // per-BROWSER, not shared -- everyone can arrange their OWN view of
  // whichever tabs they can currently see (built-in + permanent + their
  // own personal extras) however they like, independent of anyone
  // else's order. Kept in sync with extraTabIds/permanentTabIds by
  // whichever function adds or removes a tab, not just recomputed once
  // at load.
  const TAB_ORDER_KEY = `${id}.tabOrder`;
  function loadTabOrder(knownIds) {
    let saved;
    try {
      saved = JSON.parse(localStorage.getItem(TAB_ORDER_KEY) || 'null');
    } catch {
      saved = null;
    }
    const order = Array.isArray(saved) ? saved.filter((tabId) => knownIds.has(tabId)) : [];
    for (const tabId of knownIds) {
      if (!order.includes(tabId)) order.push(tabId);
    }
    return order;
  }
  function saveTabOrder(order) {
    try {
      localStorage.setItem(TAB_ORDER_KEY, JSON.stringify(order));
    } catch {
      // localStorage unavailable -- the new order still applies for this page load, just won't persist.
    }
  }

  // Survive a remount (navigate away and back within the same browser
  // session) -- module scope (of this factory CALL, i.e. per tabbed
  // page), same convention every other page's lastData uses.
  let tabOrder = loadTabOrder(new Set([...DEFAULT_TAB_IDS, ...extraTabIds]));
  let lastActiveTabId = tabOrder[0];

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

    // Renders immediately with whatever permanentTabIds/isPermanentAdmin
    // already are (empty/false on a first-ever load this session, or
    // already-populated on a same-session remount) rather than waiting
    // on the fetch below -- built-in + personal tabs show with no delay;
    // permanent ones pop in once fetchPermanentTabs() resolves.
    renderTabBar();
    selectTab(lastActiveTabId);
    fetchPermanentTabs();
    fetchHelpText();

    async function fetchPermanentTabs() {
      try {
        const res = await fetch(`${apiBase}/permanent-tabs`);
        const data = await res.json();
        if (!res.ok) return;
        permanentTabIds = (data.tabIds || []).filter((tabId) => PAGES_BY_ID.has(tabId) && !DEFAULT_TAB_IDS.has(tabId) && tabId !== id);
        isPermanentAdmin = !!data.editable;
        // A tab that's now permanent shouldn't also linger in this
        // viewer's own personal list (can happen if it was made
        // permanent from a DIFFERENT browser since this one last
        // loaded) -- dedupe in favour of the shared/permanent copy.
        const before = extraTabIds.length;
        extraTabIds = extraTabIds.filter((tabId) => !permanentTabIds.includes(tabId));
        if (extraTabIds.length !== before) saveExtraTabIds(extraTabIds);
        for (const tabId of permanentTabIds) {
          if (!tabOrder.includes(tabId)) tabOrder.push(tabId);
        }
        renderTabBar();
      } catch {
        // Best-effort -- permanent tabs just won't show for this load if
        // the fetch fails; built-in + personal tabs still work regardless.
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

    // Combines the built-in tabs with whatever's currently permanent and
    // whatever this viewer has personally added, resolving each one's
    // real label fresh from PAGES_BY_ID every time -- recomputed rather
    // than cached, since all three sources can change at runtime.
    function allTabsById() {
      const map = new Map(DEFAULT_TABS_BY_ID);
      for (const tabId of permanentTabIds) {
        const page = PAGES_BY_ID.get(tabId);
        if (page) map.set(tabId, { id: tabId, label: page.label });
      }
      for (const tabId of extraTabIds) {
        const page = PAGES_BY_ID.get(tabId);
        if (page) map.set(tabId, { id: tabId, label: page.label });
      }
      return map;
    }

    // Renders the tab strip in tabOrder's current order (draggable, plus
    // a remove "x" on a PERSONAL tab -- never on a permanent one, which
    // is managed exclusively via right-click below, admin-only) plus
    // HELP_TAB fixed at the end, with a minimize toggle BEFORE all of
    // them (by request -- "put it before the 1st menu item so that it's
    // easily accessible on small screens"). Called again after every
    // reorder, add, remove, or minimize toggle.
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
            .map((t) => {
              const removable = !DEFAULT_TAB_IDS.has(t.id) && !permanentTabIds.includes(t.id);
              const removeIcon = removable ? `<span class="tab-remove" data-remove-tab-id="${t.id}" title="Remove this tab">&times;</span>` : '';
              return `<button type="button" class="tab-button" draggable="true" data-tab-id="${t.id}">${escapeHtml(t.label)}${removeIcon}</button>`;
            })
            .join('') +
          `<button type="button" class="tab-button tab-button--small" data-tab-id="${HELP_TAB.id}">${escapeHtml(HELP_TAB.label)}</button>`;

        tabBarEl.querySelectorAll('.tab-button').forEach((btn) => {
          const tabId = btn.dataset.tabId;
          btn.classList.toggle('active', tabId === lastActiveTabId);
          btn.addEventListener('click', (e) => {
            if (e.target.closest('.tab-remove')) return; // handled by its own listener below instead
            selectTab(tabId);
          });
          // Admin-only right-click: make a personal tab permanent for
          // everyone, or remove an existing permanent tab's permanent
          // status -- never on the built-in tabs or Help, which are
          // always fixed either way.
          if (isPermanentAdmin && tabId !== HELP_TAB.id && !DEFAULT_TAB_IDS.has(tabId)) {
            btn.addEventListener('contextmenu', (e) => {
              e.preventDefault();
              showTabContextMenu(e.clientX, e.clientY, tabId);
            });
          }
        });
        tabBarEl.querySelectorAll('.tab-remove').forEach((removeBtn) => {
          removeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            removeExtraTab(removeBtn.dataset.removeTabId);
          });
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
    // dashboard -- drop on another tab REORDERS tabOrder; dropping
    // OUTSIDE any valid target entirely (dragend's dropEffect comes back
    // 'none') REMOVES the tab -- "dragging it back out", by request. A
    // personal tab drags out for anyone; a permanent one only actually
    // removes its permanent status for the admin (see removePermanent
    // below) -- a non-admin dragging a permanent tab out is a no-op,
    // they can't affect the shared list. Uses a plain closure variable
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
          if (DEFAULT_TAB_IDS.has(tabId) || tabId === HELP_TAB.id) return; // fixed tabs are never drag-removable
          if (permanentTabIds.includes(tabId)) {
            if (isPermanentAdmin) removePermanent(tabId);
          } else {
            removeExtraTab(tabId);
          }
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
          tabOrder.splice(fromIndex, 1);
          tabOrder.splice(toIndex, 0, dragSrcId);
          saveTabOrder(tabOrder);
          renderTabBar();
        });
      });
    }

    // Dragging a page in FROM the sidebar (app.js's own .nav-item
    // dragstart, available to every signed-in user, not just the admin)
    // to add it as a PERSONAL tab here -- "leave it in its current left
    // menu position as well ... so a copy really", by request. Always
    // personal, even for the admin -- making it permanent is a
    // deliberate SEPARATE step (right-click -> Make Permanent), not an
    // automatic side effect of dragging.
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
        if (pageId) addExtraTab(pageId);
      });
    }

    function addExtraTab(pageId) {
      if (pageId === id) return; // dragging this page itself onto its own tab bar -- no-op
      if (DEFAULT_TAB_IDS.has(pageId) || extraTabIds.includes(pageId) || permanentTabIds.includes(pageId)) {
        selectTab(pageId); // already a tab here -- just jump to it
        return;
      }
      if (!PAGES_BY_ID.has(pageId)) return; // not a real/visible page -- ignore
      extraTabIds.push(pageId);
      saveExtraTabIds(extraTabIds);
      if (!tabOrder.includes(pageId)) tabOrder.push(pageId);
      saveTabOrder(tabOrder);
      // Auto-expand if minimized -- otherwise a drag-drop while minimized
      // would silently succeed with nothing visibly different on screen.
      if (tabBarMinimized) {
        tabBarMinimized = false;
        saveTabBarMinimized(false);
      }
      renderTabBar();
      selectTab(pageId); // jump straight to the newly added tab
    }

    function removeExtraTab(pageId) {
      extraTabIds = extraTabIds.filter((tabId) => tabId !== pageId);
      saveExtraTabIds(extraTabIds);
      tabOrder = tabOrder.filter((tabId) => tabId !== pageId);
      saveTabOrder(tabOrder);
      if (lastActiveTabId === pageId) selectTab(tabOrder[0]);
      else renderTabBar();
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

    async function makePermanent(pageId) {
      if (permanentTabIds.includes(pageId)) return;
      const next = [...permanentTabIds, pageId];
      if (!(await savePermanentTabIds(next))) return;
      permanentTabIds = next;
      // Now tracked as permanent -- no longer needs its own personal entry.
      extraTabIds = extraTabIds.filter((tabId) => tabId !== pageId);
      saveExtraTabIds(extraTabIds);
      renderTabBar();
    }

    async function removePermanent(pageId) {
      if (!permanentTabIds.includes(pageId)) return;
      const next = permanentTabIds.filter((tabId) => tabId !== pageId);
      if (!(await savePermanentTabIds(next))) return;
      permanentTabIds = next;
      // Falls back to a personal tab for the admin who just removed it,
      // rather than just vanishing from their own view outright.
      if (!extraTabIds.includes(pageId)) {
        extraTabIds.push(pageId);
        saveExtraTabIds(extraTabIds);
      }
      renderTabBar();
    }

    // Admin-only right-click menu (Make Permanent / Remove Permanent
    // Status) -- a small, self-contained popup, same visual language
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
      const permanent = permanentTabIds.includes(pageId);

      const menu = document.createElement('div');
      menu.className = 'nav-context-menu';
      menu.style.left = `${x}px`;
      menu.style.top = `${y}px`;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'nav-context-menu-item';
      btn.textContent = permanent ? 'Remove Permanent Status' : 'Make Permanent for Everyone';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeTabContextMenu();
        if (permanent) removePermanent(pageId);
        else makePermanent(pageId);
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
      lastActiveTabId = tabId;
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

      const adminNote = isPermanentAdmin
        ? `<p class="inline-subtext">You're the dashboard admin: right-click any tab you've added to make it
            permanent for everyone (or remove that status again), or drag it back out of the strip entirely to
            the same effect. You can also rename this page itself from the sidebar (right-click "${escapeHtml(label)}").</p>`
        : '';
      // Hidden from normal users for now, by request -- still shown to the
      // admin (grouped with adminNote below it, same isPermanentAdmin
      // gate) since it's actually explaining THEIR own drag-to-add-a-
      // permanent-tab capability right there. The underlying drag-to-add-
      // a-PERSONAL-tab feature itself is unchanged and still works for
      // everyone -- only this explanation of it is hidden.
      const dragHelpHtml = isPermanentAdmin
        ? `<p>Drag any other page from the sidebar onto the tab strip above to add it here too -- it stays in its
            own place in the sidebar as well, this just adds a shortcut. Hover an added tab for a small "&times;"
            to remove it again (or drag it back out).</p>`
        : '';
      const hasNotes = !isHelpTextBlank(customHelpText);
      const customSectionHtml = hasNotes ? `<div style="margin-bottom: 0.75rem;">${customHelpText}</div>` : '';
      const editButtonHtml = isHelpEditable
        ? `<button type="button" id="edit-help-btn" class="button-link button-link--small" style="margin-bottom:0.75rem;">${hasNotes ? 'Edit Notes' : 'Add Notes'}</button>`
        : '';

      // The "About this page" heading, the "Each tab above mounts..."
      // paragraph, and the built-in-tabs list were removed, by request --
      // just boilerplate ahead of the actually-useful bits (the custom
      // notes, and the drag-to-add mechanism explanation right below).
      tabContentEl.innerHTML = `
        <div class="resource-group" style="padding: 0.25rem 1.25rem 1.25rem;">
          ${customSectionHtml}
          ${editButtonHtml}
          ${dragHelpHtml}
          ${adminNote}
        </div>
      `;
      const editBtn = tabContentEl.querySelector('#edit-help-btn');
      if (editBtn) {
        editBtn.addEventListener('click', () => {
          helpEditing = true;
          renderHelpTab();
        });
      }
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
