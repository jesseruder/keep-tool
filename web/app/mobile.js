// The phone layout. Not a second console: one markup tree, laid out by
// `html.mobile` rules in styles.css, plus the few things CSS cannot do — move
// the project rail and the meters into sheets, put the mode switch at the
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

  filterButton = element('button', 'mobile-filter', 'Projects');
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

  filterSheet = sheet('mobileFilterSheet', 'Projects');
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
  closeDroppedAlerts();
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

function open(name) {
  if (!active || showing(name)) return;
  let pushed = false;
  try { history.pushState({ keepOverlay: name }, ''); pushed = true; } catch {}
  overlays.push({ name, pushed });
  sync();
}

function close(name) {
  const index = overlays.findLastIndex((entry) => entry.name === name);
  if (index < 0) return;
  const pops = overlays.splice(index).filter((entry) => entry.pushed).length;
  closeDroppedAlerts();
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
function reopen(name) {
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
  if (swallow > 0) { swallow -= 1; return; }
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
    overlays.length -= 1;
    closeDroppedAlerts();
    sync();
    return;
  }
  const top = overlays.length ? overlays[overlays.length - 1].name : null;
  if (top === wanted) return;
  const index = overlays.findLastIndex((entry) => entry.name === wanted);
  // Back over several at once.
  if (index >= 0) { overlays.length = index + 1; closeDroppedAlerts(); sync(); return; }
  if (!reopen(wanted)) rewind(1);
}

// Called at the end of every top-bar render: the tab bar, the two bar buttons
// and the stage/queue swap all read state the console has just recomputed.
export function syncMobile() {
  if (!active) return;
  sync();
}

function sync() {
  if (!built) return;
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
  filterButton.textContent = project ? project.name : 'Projects';
  filterButton.classList.toggle('on', Boolean(project));
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
