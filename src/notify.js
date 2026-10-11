// Phone push notifications through ntfy (https://ntfy.sh): free, no account.
// Install the ntfy app, subscribe to the topic shown on the website, and every
// trade, bot error and on/off switch shows up on your phone. The topic name is
// random and acts like a password: anyone who knows it can read the alerts.
import crypto from 'node:crypto';
import { read, write } from './store.js';

const SERVER = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');
const usd = (n) => `$${(+n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const WHO = { bot: 'Bot', website: 'Website', 'claude-mcp': 'Claude' };

export function notifySettings() {
  let s = read('notify', null);
  if (!s?.topic) {
    s = { enabled: false, topic: `tradingbot-${crypto.randomBytes(9).toString('base64url')}`, ...(s || {}) };
    write('notify', s);
  }
  const topic = process.env.NTFY_TOPIC || s.topic;
  return { enabled: !!process.env.NTFY_TOPIC || !!s.enabled, topic, server: SERVER, url: `${SERVER}/${topic}` };
}

export function setNotifyEnabled(enabled) {
  notifySettings(); // make sure a topic exists
  write('notify', { ...read('notify', {}), enabled: !!enabled });
  return notifySettings();
}

// Turns an activity entry into a push message, or null for things not worth a buzz.
export function formatActivity(e) {
  const who = WHO[e.source] || e.source;
  switch (e.action) {
    case 'order': {
      const size = e.notional ? usd(e.notional) : `${+(+e.qty).toFixed(4)} shares`;
      return { title: `${who} ${e.side === 'buy' ? 'bought' : 'sold'} ${e.symbol}`, body: `${e.side} ${size} of ${e.symbol} (paper)${e.reason ? `\n${e.reason}` : ''}`, tags: e.side === 'buy' ? 'chart_with_upwards_trend' : 'chart_with_downwards_trend' };
    }
    case 'error':
      return { title: `${who} error`, body: e.error, tags: 'warning', priority: 4 };
    case 'bot-cycle':
      if (!e.errors?.length) return null;
      return { title: 'Bot had trouble placing orders', body: e.errors.join('\n'), tags: 'warning', priority: 4 };
    case 'bot-enabled': return { title: 'Bot turned on', body: `Switched on from ${who}. It trades while the market is open.`, tags: 'robot' };
    case 'bot-disabled': return { title: 'Bot turned off', body: `Switched off from ${who}.`, tags: 'robot' };
    case 'bot-strategy':
      return { title: 'Bot strategy changed', body: e.mode === 'screen' ? `Now trading the screen: ${e.q} (top ${e.top})` : 'Now trading news signals', tags: 'robot' };
    case 'test': return { title: 'Test notification', body: 'Phone alerts from your trading bot are working.', tags: 'white_check_mark' };
    default: return null;
  }
}

export async function sendPush(msg) {
  const s = notifySettings();
  if (!s.enabled || !msg) return false;
  const site = process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN && `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`);
  const headers = { Title: msg.title, Tags: msg.tags || '', Priority: String(msg.priority || 3) };
  if (site) headers.Click = site;
  if (process.env.NTFY_TOKEN) headers.Authorization = `Bearer ${process.env.NTFY_TOKEN}`;
  const res = await fetch(s.url, { method: 'POST', headers, body: msg.body || '' })
    .catch((e) => { throw new Error(`Couldn't reach ${SERVER}: ${e.cause?.message || e.message}`); });
  if (!res.ok) throw new Error(`ntfy ${res.status}: ${await res.text()}`);
  return true;
}

// Fire-and-forget: a failed push must never break a trade or a bot run.
export function notifyActivity(entry) {
  let msg;
  try { msg = formatActivity(entry); } catch { return; }
  if (msg) sendPush(msg).catch((e) => console.error('Push notification failed:', e.message));
}
