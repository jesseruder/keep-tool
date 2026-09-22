import { hostOutageText, nodeOutages, nodeOutageText } from './status.js';

function ageText(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} m`;
}

export function statusChipState({ pending = [], generatedAt, reconnectingSince = 0, hostStatus }, now = Date.now()) {
  if (pending.length) {
    const first = pending[0];
    return { text: `${first.label} · ${ageText(now - first.startedAt)}${pending.length > 1 ? ` · ${pending.length} actions` : ''}`, status: 'pending', ticking: true };
  }
  if (reconnectingSince) return { text: `reconnecting · ${ageText(now - reconnectingSince)}`, status: 'reconnecting', ticking: true };
  const stateAge = now - Number(generatedAt || now);
  if (generatedAt && stateAge > 15000) return { text: `state ${ageText(stateAge)} old`, status: 'stale', ticking: true };
  // A silent remote node is named with how long it has been silent; its panes are
  // what it last said, so the chip says as of when, the way it does for this host.
  const nodes = nodeOutages(hostStatus).map((outage) => `${nodeOutageText(outage, now)}${outage.stale && outage.panesAt
    ? ` · showing its panes as of ${ageText(now - Number(outage.panesAt))} ago` : ''}`).join(' · ');
  if (hostStatus?.ok === false) {
    const panes = hostStatus.stale && hostStatus.panesAt
      ? ` · showing panes as of ${ageText(now - Number(hostStatus.panesAt))} ago` : '';
    return { text: `${hostOutageText(hostStatus, now)}${panes}${nodes ? ` · ${nodes}` : ''}`, status: 'degraded', ticking: true };
  }
  if (nodes) return { text: nodes, status: 'degraded', ticking: true };
  return { text: '', status: 'live', ticking: false };
}
