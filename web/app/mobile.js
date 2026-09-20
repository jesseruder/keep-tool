// The phone layout. Not a second console: one markup tree, laid out by
// `html.mobile` rules in styles.css, plus the few things CSS cannot do — move
// the filter rail and the meters into sheets, put the mode switch at the
// bottom of the screen, and push the stage over the queue with a back control
// wired to the WebView's history so Android's back button pops it.
//
// Inert until `activate()`: the module installs its listeners on every page,
// but every one of them returns immediately while the console is on a desktop.
//
// What turns it on is the shell — `window.keepShell`, whether it was injected
// before the page's scripts or announced itself afterwards — or an explicit
// `?mobile=1` for testing and demos. Never a media query: the phone layout
// moves DOM and rewrites stored state (the Watch redirect), and a desktop window
// dragged narrow must not do either. The `max-width: 480px` rules in styles.css
// stay pure CSS, which is the only kind of narrow-window behaviour that is safe.
import { isMobileShell, postShell } from './shell.js';

let ctx = null;
let root = null;
let forced = false;
let active = false;
let built = false;
let collapsedBefore = null;

let stageBar = null;
let stageTitle = null;
let filterButton = null;
let statusButton = null;
let alertsTab = null;
let filterSheet = null;
let statusSheet = null;

// Where a node lived before a sheet borrowed it, so a shell that goes away puts
// the rail back in Triage instead of leaving it in a sheet nothing can open.
const borrowed = [];

// Overlays are strictly last-in-first-out (a sheet always covers the stage), so
// one history entry each is enough to make Android's back button unwind them.
// Standing on a tab other than Triage is an overlay too — the `tab` entry, at
// the bottom of the stack — because Back out of Fleet has to land on Triage
// rather than close the app.
//
// The entry at history depth k names the k-th overlay, so the destination's
// `keepOverlay` is always what the stack's top must be — which is how a Forward
// onto an entry we already closed is recognised and undone.
//
// Each entry records whether its pushState actually took: only entries that own
// a history entry may be unwound, or closing a sheet after a refused push would
// navigate out of the console. `swallow` counts the popstate events our own
// history calls will produce — one per call, whatever the distance, because a
// multi-step go() fires a single popstate.
const overlays = [];
let swallow = 0;
// A stage a notification tap asked for while one of our own history calls was
// still in flight; opened by the popstate that settles it.
let pendingStage = false;

const showing = (name) => overlays.some((entry) => entry.name === name);

function rewind(steps) {
  if (steps <= 0) return;
  swallow += 1;
  try { history.go(-steps); } catch { swallow -= 1; }
}

function element(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html != null) node.innerHTML = html;
  return node;
}

const alertsDialog = () => document.querySelector('#notificationsPanel');
let alertsObserver = null;

// The inbox is a <dialog> the console opens for its own reasons — the tab, the
// bar button, the preview banner, and a notification tap, which opens it
// straight after a refresh with no click and no render behind it. So the stack
// follows the dialog itself: the `open` attribute is the one signal every one of
// those paths goes through.
function watchAlerts() {
  const dialog = alertsDialog();
  if (!dialog || alertsObserver) return;
  alertsObserver = new MutationObserver(() => { if (dialog.open) adoptAlerts(); });
  alertsObserver.observe(dialog, { attributes: true, attributeFilter: ['open'] });
  // A shell that attaches while the inbox is already open (keep-shell-hello after
  // a late injection) would otherwise never see an open mutation for it.
  adoptAlerts();
}
function unwatchAlerts() {
  alertsObserver?.disconnect();
  alertsObserver = null;
}
// `showing` is also the guard for reopen(), which claims the entry before it
// reopens the dialog: the observer runs a microtask later and finds it taken.
function adoptAlerts() {
  if (active && alertsDialog()?.open && !showing('alerts')) open('alerts');
}
function closeDroppedAlerts() {
  if (showing('alerts')) return;
  const dialog = alertsDialog();
  if (dialog?.open) dialog.close();
}

// The stage's actions menu (Pin to Watch, Rename, Relay to…, the renderer) is a
// <details> the console opens and closes on its own. Without an entry of its own
// one Back took the menu and the stage with it, so it joins the stack the way
// the inbox does — by following the element, whichever path opened it.
function onMenuToggle(event) {
  if (!active || !(event.target instanceof Element) || !event.target.matches('.session-actions')) return;
  if (event.target.open) open('menu'); else close('menu');
}
function closeDroppedMenu() {
  if (showing('menu')) return;
  document.querySelectorAll('.session-actions[open]').forEach((menu) => menu.removeAttribute('open'));
}

function sheet(id, label) {
  const node = element('div', 'mobile-sheet');
  node.id = id;
  node.innerHTML = `<div class="mobile-sheet-backdrop" data-sheet-close></div>`
    + `<section class="mobile-sheet-card" role="dialog" aria-modal="true" aria-label="${label}">`
    + `<header><b>${label}</b><button type="button" class="btn" data-sheet-close>Done</button></header>`
    + '<div class="mobile-sheet-body"></div></section>';
  node.addEventListener('click', (event) => {
    if (event.target instanceof Element && event.target.closest('[data-sheet-close]')) {
      close(id === 'mobileFilterSheet' ? 'filter' : 'status');
    }
  });
  document.body.append(node);
  return node;
}

function build() {
  if (built) return;
  built = true;
  const bar = document.querySelector('.bar');
  const modes = document.querySelector('.bar .modes');
  const triage = document.querySelector('#triage');

  filterButton = element('button', 'mobile-filter', 'Filters');
  filterButton.type = 'button';
  filterButton.setAttribute('aria-haspopup', 'dialog');
  filterButton.setAttribute('aria-expanded', 'false');
  filterButton.addEventListener('click', () => toggle('filter'));
  bar.prepend(filterButton);

  statusButton = element('button', 'mobile-status', '<i></i><span class="mobile-status-label">connecting</span>');
  statusButton.type = 'button';
  statusButton.setAttribute('aria-haspopup', 'dialog');
  statusButton.setAttribute('aria-expanded', 'false');
  statusButton.addEventListener('click', () => toggle('status'));
  bar.append(statusButton);

  // The bottom tab bar is the console's own mode switch, moved by CSS. Alerts is
  // the one tab with no mode of its own: it opens the inbox dialog, which joins
  // the overlay stack like the sheets so Back closes it instead of walking out
  // of the console with it still up.
  alertsTab = element('button', 'mobile-alerts-tab', 'Alerts<span class="count zero"></span>');
  alertsTab.type = 'button';
  alertsTab.addEventListener('click', () => document.querySelector('#notificationsButton')?.click());
  modes.append(alertsTab);
  // Whatever closed it — the close button, Escape, the backdrop, or a link out
  // of it — the entry it owns goes with it.
  alertsDialog()?.addEventListener('close', () => { if (active) close('alerts'); });

  stageBar = element('div', 'mobile-stagebar',
    '<button type="button" class="mobile-back">‹ Queue</button><span class="mobile-stagebar-title"></span>');
  stageTitle = stageBar.querySelector('.mobile-stagebar-title');
  stageBar.querySelector('.mobile-back').addEventListener('click', () => {
    // Focus mode holds the stage open without a history entry of its own, so
    // there is nothing to pop: leaving it is leaving Focus.
    if (showing('stage')) close('stage');
    else if (ctx.state.focusMode) ctx.toggleFocus(false);
  });
  triage.prepend(stageBar);

  filterSheet = sheet('mobileFilterSheet', 'Filters');
  statusSheet = sheet('mobileStatusSheet', 'Status');
}

function borrow(selector, target) {
  const node = document.querySelector(selector);
  if (!node || node.parentElement === target) return;
  borrowed.push({ node, parent: node.parentElement, before: node.nextSibling });
  target.append(node);
}

function giveBack() {
  while (borrowed.length) {
    const { node, parent, before } = borrowed.pop();
    parent.insertBefore(node, before);
  }
}

function activate() {
  build();
  watchAlerts();
  borrow('#rail', filterSheet.querySelector('.mobile-sheet-body'));
  borrow('#meters', statusSheet.querySelector('.mobile-sheet-body'));
  borrow('#health', statusSheet.querySelector('.mobile-sheet-body'));
  // A collapsed rail or queue is a desktop gesture with no phone affordance:
  // the rail lives in a sheet and the queue is the screen. Remembered, not
  // discarded — giving the DOM back without the state would silently expand
  // panels Owner had collapsed.
  collapsedBefore = { rail: ctx.state.collapsed.rail, queue: ctx.state.collapsed.queue };
  ctx.state.collapsed.rail = false;
  ctx.state.collapsed.queue = false;
  // Watch has no tab on the phone; a remembered Watch would leave a blank screen.
  if (ctx.state.mode === 'watch') {
    ctx.state.mode = 'triage';
    try { localStorage.setItem('keep-mode', 'triage'); } catch {}
  }
}

function deactivate() {
  // Unwind before dropping the stack: forgetting the overlays without unwinding
  // leaves history entries nothing owns, so the first Back would look like a
  // no-op and a Forward would land on a `keepOverlay` state with nothing open.
  unwatchAlerts();
  const pops = overlays.filter((entry) => entry.pushed).length;
  overlays.length = 0;
  pendingStage = false;
  closeDroppedAlerts();
  closeDroppedMenu();
  // The mode is the desktop console's own again; only the entries go.
  rewind(pops);
  giveBack();
  if (collapsedBefore) {
    ctx.state.collapsed.rail = collapsedBefore.rail;
    ctx.state.collapsed.queue = collapsedBefore.queue;
    collapsedBefore = null;
  }
}

function apply({ booting = false } = {}) {
  const next = Boolean(isMobileShell() || forced);
  if (next === active) { sync(); return; }
  active = next;
  if (active) activate(); else deactivate();
  root.classList.toggle('mobile', active);
  sync();
  if (!booting) ctx.refresh();
}

function open(name, mode) {
  if (!active || showing(name)) return;
  let pushed = false;
  const entry = mode ? { keepOverlay: name, keepMode: mode } : { keepOverlay: name };
  try { history.pushState(entry, ''); pushed = true; } catch {}
  overlays.push({ name, pushed, mode });
  sync();
}

// Everything an entry owns is given up here, however it was dropped: by its own
// control, by Back, or by the console re-rendering it away.
function dropped(entries) {
  closeDroppedAlerts();
  closeDroppedMenu();
  // Losing the tab entry is landing back on Triage.
  if (entries.some((entry) => entry.name === 'tab') && ctx.state.mode !== 'triage') ctx.setMode('triage');
}

function close(name) {
  const index = overlays.findLastIndex((entry) => entry.name === name);
  if (index < 0) return;
  const gone = overlays.splice(index);
  const pops = gone.filter((entry) => entry.pushed).length;
  dropped(gone);
  sync();
  rewind(pops);
}

function toggle(name) {
  if (showing(name)) close(name); else open(name);
}

// Standing on an entry whose overlay is closed: put the overlay back rather than
// leave the entry dead. The sheets need nothing but themselves; the stage needs
// an item to show, and Triage to show it in; the inbox has to be reopened, and
// claims the entry first so adopting it does not push a second one.
function reopen(name, state) {
  // The tab entry carries the tab it was pushed for, so Forward puts that tab
  // back rather than guessing one.
  if (name === 'tab') {
    const mode = state?.keepMode;
    if (!mode || mode === 'triage') return false;
    overlays.push({ name, pushed: true, mode });
    reconciling = true;
    try { ctx.setMode(mode); } finally { reconciling = false; }
    sync();
    return true;
  }
  if (name === 'alerts') {
    const dialog = alertsDialog();
    if (!dialog) return false;
    overlays.push({ name, pushed: true });
    if (!dialog.open) document.querySelector('#notificationsButton')?.click();
    if (!dialog.open) { overlays.pop(); return false; }
    sync();
    return true;
  }
  if (name !== 'filter' && name !== 'status'
    && !(name === 'stage' && ctx.state.mode === 'triage' && ctx.state.currentItem)) return false;
  overlays.push({ name, pushed: true });
  sync();
  return true;
}

function onPopState(event) {
  // One of ours landing: the stack is already right, but anything held back
  // while it was in flight is settled now.
  if (swallow > 0) {
    swallow -= 1;
    // A stage a notification asked for while this was in flight: now it can own
    // an entry of its own. (Another call still pending puts it back on hold.)
    if (pendingStage) { pendingStage = false; openMobileStage(); }
    sync();
    return;
  }
  const wanted = event?.state?.keepOverlay || null;
  if (!active) {
    // An entry left over from a shell that went away. Undo it so the history
    // never holds an overlay entry with no overlay behind it.
    if (wanted) rewind(1);
    return;
  }
  if (!wanted) {
    // Back out of the last overlay, or a navigation that was never ours.
    if (!overlays.length) return;
    dropped(overlays.splice(overlays.length - 1));
    sync();
    return;
  }
  const top = overlays.length ? overlays[overlays.length - 1].name : null;
  if (top === wanted) return;
  const index = overlays.findLastIndex((entry) => entry.name === wanted);
  // Back over several at once.
  if (index >= 0) { dropped(overlays.splice(index + 1)); sync(); return; }
  if (!reopen(wanted, event?.state)) rewind(1);
}

// Called at the end of every top-bar render: the tab bar, the two bar buttons
// and the stage/queue swap all read state the console has just recomputed.
export function syncMobile() {
  if (!active) return;
  sync();
}

// Read by the console's key handler: a phone has no hardware keyboard by
// default, so the plain-key shortcuts must not fire behind a lost focus.
export function mobileActive() { return active; }

// A notification tap is a click on the row it names: the console selects the
// row and then asks for the same stage the row's own tap would have pushed.
// Called after the render that put the item on the stage, so `currentItem` is
// the row the tap named — without it there is nothing to show full-screen.
// Focus mode holds its own stage open with no entry behind it; pushing one over
// it would only make the next Back a dead press.
export function openMobileStage() {
  if (!active || ctx.state.mode !== 'triage' || !ctx.state.currentItem) return;
  // A tap rarely lands on Triage: coming back to it gives up the tab's entry,
  // and that rewind is still in flight here. Unwinding or pushing over a
  // traversal that has not landed would leave the stack naming an entry the
  // traversal is about to move off — and Back a dead press — so the swallowed
  // popstate calls back here instead, and finds the stack settled.
  if (swallow > 0) { pendingStage = true; return; }
  // Whatever the phone was left with open covers the stage: a sheet, the inbox,
  // a row's actions menu. The stage has to be the screen, and it is strictly
  // under them in the stack, so they go first — the way their own Back would
  // take them. Leaving them up hid the row the notification named behind a
  // sheet, and made the first Back a press with nothing to show for it.
  const covering = overlays.length && !(overlays.length === 1 && overlays[0].name === 'stage');
  if (covering) {
    const gone = overlays.splice(0);
    const pops = gone.filter((entry) => entry.pushed).length;
    dropped(gone);
    sync();
    if (pops) { pendingStage = true; rewind(pops); return; }
  }
  if (!ctx.state.focusMode) open('stage');
  // renderTop() syncs before the stage itself is rendered, so the back bar is a
  // render behind whenever the stage was already up. Catch it up on the row the
  // notification named rather than leaving the one it replaced named above it.
  sync();
}

// Two overlays the console owns rather than this module: the tab, which it
// switches for its own reasons as well as ours, and the actions menu, which a
// re-render can take away without a toggle event. Both are reconciled from the
// one place every render passes through, so the stack never drifts from what is
// actually on the screen.
let reconciling = false;
function reconcile() {
  // Never while one of our own history calls is in flight: pushing an entry on
  // top of a pending go() would leave the stack naming an entry the traversal is
  // about to move off. The swallowed popstate syncs again, which lands us here
  // at the entry the console actually ends up on.
  if (!active || reconciling || swallow > 0) return;
  reconciling = true;
  try {
    if (showing('menu') && !document.querySelector('.session-actions[open]')) close('menu');
    const mode = ctx.state.mode;
    let entry = overlays.find((item) => item.name === 'tab');
    if (mode === 'triage') { if (entry) close('tab'); return; }
    if (!entry) {
      // A reload keeps the history entry but not this module's stack, so boot
      // finds a `tab` entry already there with nothing owning it. Adopt it, the
      // way the inbox adopts a dialog that is already open: pushing a second one
      // over it leaves a twin behind, and Back onto it reads as unchanged —
      // a dead press before Triage ever comes back.
      const carried = !overlays.length && history.state?.keepOverlay === 'tab' ? history.state : null;
      if (!carried) { open('tab', mode); return; }
      entry = { name: 'tab', pushed: true, mode: carried.keepMode || mode };
      overlays.push(entry);
    }
    // One entry for the whole non-Triage side: moving between Fleet, Queue and
    // the Reviewer renames it instead of stacking another, so Back from any of
    // them is one step from Triage. The rename is driven by what the history
    // actually holds, not by the mode having just changed: a mode change under a
    // sheet cannot write it (the sheet's entry is the current one), and the
    // repair has to happen when the tab entry is on top again.
    entry.mode = mode;
    if (entry.pushed && overlays[overlays.length - 1] === entry
      && history.state?.keepOverlay === 'tab' && history.state.keepMode !== mode) {
      try { history.replaceState({ keepOverlay: 'tab', keepMode: mode }, ''); } catch {}
    }
  } finally { reconciling = false; }
}

function sync() {
  if (!built) return;
  reconcile();
  const triage = ctx.state.mode === 'triage';
  // Focus mode is a stage the console holds open by itself; it needs no history
  // entry, because leaving it is a mode or a Focus toggle, not a back gesture.
  const stageOpen = active && triage && (showing('stage') || ctx.state.focusMode);
  root.classList.toggle('mobile-stage-open', stageOpen);
  filterSheet.classList.toggle('on', active && showing('filter'));
  statusSheet.classList.toggle('on', active && showing('status'));
  filterButton.setAttribute('aria-expanded', String(showing('filter')));
  statusButton.setAttribute('aria-expanded', String(showing('status')));
  filterButton.hidden = !triage;
  const project = ctx.state.filter && ctx.knownProjects().find((entry) => entry.key === ctx.state.filter);
  const client = { claude: 'Claude Code', codex: 'Codex' }[ctx.state.providerFilter];
  filterButton.textContent = [project?.name, client].filter(Boolean).join(' · ') || 'Filters';
  filterButton.classList.toggle('on', Boolean(project || client));
  const connection = document.querySelector('#connection');
  statusButton.dataset.status = connection?.dataset.status || '';
  statusButton.querySelector('.mobile-status-label').textContent = connection?.textContent || '';
  const unread = document.querySelector('#notificationsButton .notification-count')?.textContent || '';
  const badge = alertsTab.querySelector('.count');
  badge.textContent = unread;
  badge.classList.toggle('zero', !unread);
  if (stageOpen) stageTitle.textContent = headingText() || document.querySelector('#stage .qempty b')?.textContent || '';
  alertsTab.classList.toggle('on', showing('alerts'));
}

// The stage heading carries the session number and mark inside the same element
// as the title; the back bar wants only the words.
function headingText() {
  const heading = document.querySelector('#stage .shead h2');
  if (!heading) return '';
  const copy = heading.cloneNode(true);
  copy.querySelectorAll('.num-id, .mark').forEach((node) => node.remove());
  return copy.textContent.trim();
}

export function installMobile(context) {
  ctx = context;
  root = document.documentElement;
  try { forced = new URLSearchParams(location.search).get('mobile') === '1'; } catch {}
  window.addEventListener('popstate', onPopState);
  // Android's WebView injects `window.keepShell` before page scripts when it
  // can and announces itself afterwards when it cannot; either way the phone
  // layout has to come up once the shell is there — and go away again if the
  // shell ever does, which is the only thing that deactivates it.
  window.addEventListener('keep-shell-hello', () => apply());
  // `toggle` does not bubble, so the stage's actions menu is heard in the
  // capture phase — the rows triage.js recycles need to know nothing about it.
  document.addEventListener('toggle', onMenuToggle, true);
  // Selecting a queue row is what pushes the stage. Delegated, so the rows that
  // triage.js recycles on every refresh need to know nothing about the phone —
  // and in the capture phase, because the console's own handler re-renders the
  // list the click came from, leaving `event.target` detached by the time a
  // bubbling listener would look at its ancestors.
  document.addEventListener('click', (event) => {
    if (!active || !(event.target instanceof Element)) return;
    // A Fleet row's Terminal button is the same handoff the stage offers; only
    // the phone shows it, so only the phone has to answer it.
    const handoff = event.target.closest('[data-open-terminal]');
    if (handoff) {
      postShell({ type: 'openTerminal', pane: handoff.dataset.openTerminal,
        session: handoff.dataset.session || null, title: handoff.dataset.title || '' });
      return;
    }
    if (ctx.state.mode !== 'triage') return;
    // Setting an item aside answers the queue, not the session: go back to it
    // rather than leaving a full-screen stage on an item that just left.
    if (event.target.closest('#stage [data-dismiss], #stage [data-snooze]')) close('stage');
    else if (event.target.closest('#qlist .qitem')) open('stage');
    else if (event.target.closest('#rail [data-project]')) close('filter');
  }, true);
  apply({ booting: true });
}
