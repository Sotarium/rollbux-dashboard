// language: Node.js (ESM), file: discord-worker/index.js
// target: Railway — multi-tenant Discord gateways 24/7
// each site user (/@username) owns their own Discord accounts + watchers

import WebSocket from 'ws';
import http from 'http';
import { URL } from 'url';

const PORT = process.env.PORT || 8080;
const WORKER_SECRET = process.env.WORKER_SECRET || '';
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';

const DISCORD_GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json';
const INTENTS = 1 | 512 | 1024 | 32768;

const tenants = new Map();
const tenantWatchers = new Map();
const tenantWebhooks = new Map();
const tenantWebhookSettings = new Map();
const processedSelectionPrompts = new Set();
const processedReactions = new Set();
const processedClaimMessages = new Set();
let activityLog = [];

function log(msg, type = 'info', account = null, siteUser = null) {
  const entry = {
    ts: Date.now(),
    msg,
    type,
    siteUser: siteUser || account?.siteUser || null,
    account: account?.user?.username || account?.id || null
  };
  activityLog.unshift(entry);
  if (activityLog.length > 300) activityLog.length = 300;
  console.log(`[${type}] ${entry.siteUser || '-'} / ${entry.account || '-'} ${msg}`);
}

async function redis(cmd, ...args) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
  const path = [cmd, ...args.map(a => encodeURIComponent(typeof a === 'object' ? JSON.stringify(a) : String(a)))].join('/');
  try {
    const res = await fetch(`${UPSTASH_URL}/${path}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
    const data = await res.json();
    return data.result;
  } catch {
    return null;
  }
}

function accountsKey(siteUser) {
  return `sotarium:discord:accounts:${String(siteUser).toLowerCase()}`;
}
function watchersKey(siteUser) {
  return `sotarium:discord:watchers:${String(siteUser).toLowerCase()}`;
}
function webhooksKey(siteUser) {
  return `sotarium:discord:webhooks:${String(siteUser).toLowerCase()}`;
}
function webhookSettingsKey(siteUser) {
  return `sotarium:discord:webhook-settings:${String(siteUser).toLowerCase()}`;
}
function indexKey() {
  return 'sotarium:discord:tenants';
}

async function discordApi(method, path, token, body) {
  const res = await fetch(`https://discord.com/api/v10${path}`, {
    method,
    headers: {
      Authorization: token,
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Discord ${method} ${path} → ${res.status} ${t.slice(0, 120)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function fetchUserFromToken(token) {
  const u = await discordApi('GET', '/users/@me', token);
  return {
    id: String(u.id),
    username: u.username,
    handle: u.global_name || u.username,
    avatar: u.avatar
      ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png`
      : null
  };
}

async function ensureAccountUser(account) {
  if (account.user?.id) return account;
  try {
    account.user = await fetchUserFromToken(account.token);
    log(`resolved ${account.user.username} (${account.user.id})`, 'info', account, account.siteUser);
  } catch (e) {
    log(`token resolve failed: ${e.message}`, 'error', account, account.siteUser);
  }
  return account;
}

function getTenantAccounts(siteUser) {
  const key = String(siteUser).toLowerCase();
  if (!tenants.has(key)) tenants.set(key, new Map());
  return tenants.get(key);
}

function getTenantWatchers(siteUser) {
  const key = String(siteUser).toLowerCase();
  if (!tenantWatchers.has(key)) tenantWatchers.set(key, []);
  return tenantWatchers.get(key);
}

function getTenantWebhooks(siteUser) {
  const key = String(siteUser).toLowerCase();
  if (!tenantWebhooks.has(key)) tenantWebhooks.set(key, []);
  return tenantWebhooks.get(key);
}

function getTenantWebhookSettings(siteUser) {
  const key = String(siteUser).toLowerCase();
  if (!tenantWebhookSettings.has(key)) tenantWebhookSettings.set(key, { everyone: false, here: false });
  return tenantWebhookSettings.get(key);
}

async function persistTenant(siteUser) {
  const key = String(siteUser).toLowerCase();
  const accMap = getTenantAccounts(key);
  const list = [...accMap.values()].map(({ id, token, user }) => ({ id, token, user }));
  const watchers = getTenantWatchers(key);
  const webhooks = getTenantWebhooks(key);
  const webhookSettings = getTenantWebhookSettings(key);
  await redis('SET', accountsKey(key), JSON.stringify(list));
  await redis('SET', watchersKey(key), JSON.stringify(watchers));
  await redis('SET', webhooksKey(key), JSON.stringify(webhooks));
  await redis('SET', webhookSettingsKey(key), JSON.stringify(webhookSettings));
  let index = [];
  try {
    const raw = await redis('GET', indexKey());
    if (raw) index = JSON.parse(raw);
  } catch {}
  if (!index.includes(key)) {
    index.push(key);
    await redis('SET', indexKey(), JSON.stringify(index));
  }
}

async function loadTenant(siteUser) {
  const key = String(siteUser).toLowerCase();
  const rawAcc = await redis('GET', accountsKey(key));
  const rawWatch = await redis('GET', watchersKey(key));
  const rawWebhooks = await redis('GET', webhooksKey(key));
  const rawWebhookSettings = await redis('GET', webhookSettingsKey(key));
  const accMap = getTenantAccounts(key);

  if (rawAcc) {
    try {
      const list = JSON.parse(rawAcc);
      for (const a of list) {
        if (!a.token) continue;
        const id = a.id || a.token.slice(0, 8);
        if (!accMap.has(id)) {
          accMap.set(id, {
            ...a,
            id,
            siteUser: key,
            ws: null,
            heartbeat: null,
            sequence: null,
            reconnect: null
          });
        }
      }
    } catch (e) {
      console.error('bad accounts for', key, e.message);
    }
  }

  for (const account of accMap.values()) {
    await ensureAccountUser(account);
  }

  if (rawWatch) {
    try {
      tenantWatchers.set(key, JSON.parse(rawWatch));
    } catch {}
  }
  if (rawWebhooks) {
    try {
      const list = JSON.parse(rawWebhooks);
      if (Array.isArray(list)) tenantWebhooks.set(key, list.filter(w => w && w.url));
    } catch {}
  }
  if (rawWebhookSettings) {
    try {
      const settings = JSON.parse(rawWebhookSettings);
      tenantWebhookSettings.set(key, { everyone: settings.everyone === true, here: settings.here === true });
    } catch {}
  }
}

async function loadAllTenants() {
  let index = [];
  try {
    const raw = await redis('GET', indexKey());
    if (raw) index = JSON.parse(raw);
  } catch {}

  if (process.env.DISCORD_BOOTSTRAP) {
    try {
      const boot = JSON.parse(process.env.DISCORD_BOOTSTRAP);
      for (const t of boot) {
        if (!t.siteUser) continue;
        const key = String(t.siteUser).toLowerCase();
        if (!index.includes(key)) index.push(key);
        const accMap = getTenantAccounts(key);
        for (const a of t.accounts || []) {
          if (!a.token) continue;
          const id = a.id || a.token.slice(0, 8);
          accMap.set(id, {
            ...a,
            id,
            siteUser: key,
            ws: null,
            heartbeat: null,
            sequence: null,
            reconnect: null
          });
        }
        if (Array.isArray(t.watchers)) tenantWatchers.set(key, t.watchers);
        if (Array.isArray(t.webhooks)) tenantWebhooks.set(key, t.webhooks.filter(w => w && w.url));
        if (t.webhookSettings) tenantWebhookSettings.set(key, { everyone: t.webhookSettings.everyone === true, here: t.webhookSettings.here === true });
      }
    } catch (e) {
      console.error('bad DISCORD_BOOTSTRAP', e.message);
    }
  }

  for (const siteUser of index) {
    await loadTenant(siteUser);
  }

  let totalAcc = 0;
  for (const m of tenants.values()) totalAcc += m.size;
  console.log(`loaded ${index.length} tenants, ${totalAcc} discord accounts`);
}

async function sendMessage(channelId, content, account) {
  const text = String(content ?? '').trim();
  if (!/^(?:[1-9]|1[0-9]|20)$/.test(text)) return false;
  try {
    await discordApi('POST', `/channels/${channelId}/messages`, account.token, { content: text });
    log(`guess sent: ${text}`, 'guess', account, account.siteUser);
    return true;
  } catch (e) {
    log(`guess failed: ${e.message}`, 'error', account, account.siteUser);
    return false;
  }
}

async function postWebhook(url, payload) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Sotarium-Rollbux-Worker/1.0' },
      body: JSON.stringify(payload)
    });
    return res.ok;
  } catch (e) {
    console.error('[webhook]', e.message);
    return false;
  }
}

async function notifyWebhookActivity(siteUser, account, details = {}) {
  const webhooks = getTenantWebhooks(siteUser).filter(w => w && w.url && w.enabled !== false);
  if (!webhooks.length) return 0;
  const settings = getTenantWebhookSettings(siteUser);
  const mentions = [];
  if (settings.everyone) mentions.push('@everyone');
  if (settings.here) mentions.push('@here');
  const content = [mentions.join(' '), 'Rollbux activity detected', details.message || 'A monitored giveaway activity was detected.'].filter(Boolean).join('\n');
  const payload = {
    content,
    allowed_mentions: { parse: mentions.length ? ['everyone'] : [] },
    embeds: [{
      title: 'Rollbux activity detected',
      description: details.message || 'A monitored giveaway activity was detected.',
      color: 0x54d487,
      fields: [
        { name: 'Discord account', value: String(account?.user?.username || account?.id || 'Unknown'), inline: true },
        ...(details.channelId ? [{ name: 'Channel', value: String(details.channelId), inline: true }] : [])
      ],
      timestamp: new Date().toISOString(),
      footer: { text: 'Sotarium Rollbux watcher' }
    }]
  };
  const results = await Promise.all(webhooks.map(webhook => postWebhook(webhook.url, payload)));
  return results.filter(Boolean).length;
}

async function sendWebhookTest(siteUser) {
  const webhooks = getTenantWebhooks(siteUser).filter(w => w && w.url && w.enabled !== false);
  if (!webhooks.length) return 0;
  const settings = getTenantWebhookSettings(siteUser);
  const mentions = [];
  if (settings.everyone) mentions.push('@everyone');
  if (settings.here) mentions.push('@here');
  const payload = {
    content: [mentions.join(' '), 'Sotarium webhook test — Rollbux activity notifications are connected.'].filter(Boolean).join('\n'),
    allowed_mentions: { parse: mentions.length ? ['everyone'] : [] },
    embeds: [{ title: 'Webhook test successful', description: 'This webhook is ready for Rollbux activity alerts.', color: 0x54d487, timestamp: new Date().toISOString() }]
  };
  const results = await Promise.all(webhooks.map(webhook => postWebhook(webhook.url, payload)));
  return results.filter(Boolean).length;
}

async function getWebhookMetadata(webhookUrl) {
  const parsed = new URL(String(webhookUrl || ''));
  const validHost = parsed.protocol === 'https:' && (parsed.hostname === 'discord.com' || parsed.hostname.endsWith('.discord.com') || parsed.hostname === 'discordapp.com' || parsed.hostname.endsWith('.discordapp.com'));
  if (!validHost || !/^\/api\/webhooks\/\d+\/[^/]+/.test(parsed.pathname)) throw new Error('Invalid Discord webhook URL.');
  const response = await fetch(`${parsed.origin}${parsed.pathname}`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.id) throw new Error('Could not read Discord webhook metadata.');
  let avatar = null;
  if (data.avatar) {
    avatar = `https://cdn.discordapp.com/avatars/${data.id}/${data.avatar}.png?size=128`;
  } else {
    try { avatar = `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(data.id) % 5n)}.png`; } catch {}
  }
  return { id: String(data.id), name: data.name || null, avatar };
}

async function addReaction(channelId, messageId, emoji, account) {
  const reactionKey = `${account.siteUser}:${account.id}:${channelId}:${messageId}:${emoji}`;
  if (processedReactions.has(reactionKey)) return true;
  processedReactions.add(reactionKey);
  setTimeout(() => processedReactions.delete(reactionKey), 10 * 60 * 1000);
  const encoded = encodeURIComponent(emoji);
  try {
    await discordApi('PUT', `/channels/${channelId}/messages/${messageId}/reactions/${encoded}/@me`, account.token);
    log(`reacted ${emoji}`, 'claim', account, account.siteUser);
    void notifyWebhookActivity(account.siteUser, account, { channelId, messageId, message: `Reaction ${emoji} added to a monitored Rollbux activity.` });
    return true;
  } catch (e) {
    processedReactions.delete(reactionKey);
    log(`react failed: ${e.message}`, 'error', account, account.siteUser);
    return false;
  }
}

function fullTextFromMessage(msg) {
  let t = msg.content || '';
  if (Array.isArray(msg.embeds)) {
    for (const emb of msg.embeds) {
      if (emb.title) t += ' ' + emb.title;
      if (emb.description) t += ' ' + emb.description;
      if (Array.isArray(emb.fields)) {
        for (const f of emb.fields) {
          if (f.name) t += ' ' + f.name;
          if (f.value) t += ' ' + f.value;
        }
      }
      if (emb.footer?.text) t += ' ' + emb.footer.text;
    }
  }
  return t;
}

function matchingWatchers(msg, siteUser) {
  const watchers = getTenantWatchers(siteUser);
  const channelId = String(msg.channel_id || '');
  const guildId = String(msg.guild_id || '');
  const authorId = String(msg.author?.id || '');
  return watchers.filter(w => {
    if (!w.enabled) return false;
    if (w.channelID && String(w.channelID).trim() !== channelId) return false;
    if (w.serverID && String(w.serverID).trim() !== guildId) return false;
    if (w.targetID && String(w.targetID).trim() !== authorId) return false;
    return true;
  });
}

async function claimForAllAccounts(msg, matches, sourceAccount) {
  const siteUser = sourceAccount.siteUser;
  const channelId = msg.channel_id;
  const messageId = msg.id;
  const claimKey = `${siteUser}:${channelId}:${messageId}`;
  if (processedClaimMessages.has(claimKey)) return;
  processedClaimMessages.add(claimKey);
  setTimeout(() => processedClaimMessages.delete(claimKey), 10 * 60 * 1000);

  const claims = [];
  for (const watcher of matches) {
    const isClaimer = watcher.type === 'claimer' || watcher.mode === 'ticket';
    const wantsTicket =
      (isClaimer
        ? /ticket|claim|🎟️/i.test(fullTextFromMessage(msg).toLowerCase())
        : /giveaway|flash\s+giveaway|react\s+(?:with|to\s+enter)|enter\s+to\s+win|🎉|🎊|rain|drop/i.test(fullTextFromMessage(msg).toLowerCase())) ||
      (Array.isArray(watcher.keywords) && watcher.keywords.some(k => fullTextFromMessage(msg).toLowerCase().includes(String(k).toLowerCase())));
    if (wantsTicket || watcher.alwaysClaim) {
      claims.push({ watcher, emoji: watcher.claimEmoji || (isClaimer ? '🎟️' : '🎉') });
    }
  }
  if (!claims.length) return;

  const accounts = [...(getTenantAccounts(siteUser)?.values() || [])].filter(account => account?.token);
  await Promise.all(accounts.flatMap(account => claims.map(async ({ watcher, emoji }) => {
    await addReaction(channelId, messageId, emoji, account);
    log(`claim on ${watcher.name || watcher.channelID}`, 'claim', account, siteUser);
  })));
}

async function handleMessage(msg, account) {
  if (!msg) return;
  const siteUser = account.siteUser;
  const matches = matchingWatchers(msg, siteUser);
  if (matches.length === 0) return;

  const fullText = fullTextFromMessage(msg);
  const fullLower = fullText.toLowerCase();
  const myId = String(account.user?.id || '');
  const channelId = msg.channel_id;
  const messageId = msg.id;

  if (myId) {
    const mentionsMe =
      (Array.isArray(msg.mentions) && msg.mentions.some(m => String(m?.id || '') === myId)) ||
      fullText.includes(`<@${myId}>`) ||
      fullText.includes(`<@!${myId}>`);

    const isSelectPrompt =
      mentionsMe &&
      (/pick a number|choose a number|selected|you're selected|you are selected|guess a number|1\s*[–-]\s*20|1-20/i.test(fullText));

    if (isSelectPrompt) {
      const selectionKey = `${siteUser}:${account.id}:${channelId}:${messageId}`;
      if (processedSelectionPrompts.has(selectionKey)) return;
      processedSelectionPrompts.add(selectionKey);
      setTimeout(() => processedSelectionPrompts.delete(selectionKey), 10 * 60 * 1000);
      const guess = String(Math.floor(Math.random() * 20) + 1);
      log(`selected — guessing ${guess}`, 'join', account, siteUser);
      if (!await sendMessage(channelId, guess, account)) processedSelectionPrompts.delete(selectionKey);
      return;
    }
  }

  const isResultMessage = /(?:flash\s+giveaway\s+ended|giveaway\s+ended|rain\s+ended|drop\s+ended|secret\s+number|no\s+prize|got\s+it\s+right|got\s+it\s+wrong|correct\s+(?:answer|number)|incorrect|winner|winner\s+is|guessed\s+\d+)/i.test(fullText);
  if (isResultMessage) return;

  await claimForAllAccounts(msg, matches, account);
}

function startGateway(account) {
  if (account.ws && (account.ws.readyState === WebSocket.OPEN || account.ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const ws = new WebSocket(DISCORD_GATEWAY);
  account.ws = ws;

  ws.on('open', () => log('gateway open', 'info', account, account.siteUser));

  ws.on('message', raw => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const { op, d, t, s } = data;
    if (s != null) account.sequence = s;

    if (op === 10) {
      clearInterval(account.heartbeat);
      account.heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ op: 1, d: account.sequence }));
        }
      }, d.heartbeat_interval);

      ws.send(JSON.stringify({
        op: 2,
        d: {
          token: account.token,
          intents: INTENTS,
          properties: { os: 'Windows', browser: 'Chrome', device: '' },
          presence: { status: 'online', since: 0, activities: [], afk: false }
        }
      }));
      log('IDENTIFY sent', 'info', account, account.siteUser);
    }

    if (op === 0) {
      if (t === 'READY') {
        const u = d.user;
        account.user = {
          id: String(u.id),
          username: u.username,
          handle: u.global_name || u.username,
          avatar: u.avatar
            ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png`
            : null
        };
        log(`READY as ${account.user.username}`, 'info', account, account.siteUser);
      }
      if (t === 'MESSAGE_CREATE' || t === 'MESSAGE_UPDATE') {
        handleMessage(d, account).catch(e => log(e.message, 'error', account, account.siteUser));
      }
    }

    if (op === 7 || op === 9) {
      clearInterval(account.heartbeat);
      try { ws.close(); } catch {}
      account.ws = null;
      clearTimeout(account.reconnect);
      account.reconnect = setTimeout(() => startGateway(account), 3000);
    }
  });

  ws.on('close', () => {
    clearInterval(account.heartbeat);
    account.ws = null;
    log('gateway closed — reconnect 5s', 'info', account, account.siteUser);
    clearTimeout(account.reconnect);
    account.reconnect = setTimeout(() => startGateway(account), 5000);
  });

  ws.on('error', err => {
    log(`ws error: ${err.message}`, 'error', account, account.siteUser);
  });
}

function startAllGateways() {
  for (const accMap of tenants.values()) {
    for (const account of accMap.values()) {
      startGateway(account);
    }
  }
}

function statusPayload(siteUserFilter = null) {
  const out = [];
  for (const [siteUser, accMap] of tenants) {
    if (siteUserFilter && siteUser !== siteUserFilter) continue;
    const accounts = [];
    for (const [id, a] of accMap) {
      accounts.push({
        id,
        username: a.user?.username || null,
        userId: a.user?.id || null,
        connected: !!(a.ws && a.ws.readyState === WebSocket.OPEN)
      });
    }
    out.push({
      siteUser,
      accounts,
      watchers: getTenantWatchers(siteUser).length
    });
  }
  return {
    tenants: out,
    activity: activityLog
      .filter(e => !siteUserFilter || e.siteUser === siteUserFilter)
      .slice(0, 50)
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-worker-secret');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (WORKER_SECRET) {
    const auth = req.headers['x-worker-secret'] || url.searchParams.get('secret');
    if (auth !== WORKER_SECRET && url.pathname !== '/health') {
      res.writeHead(401);
      res.end('unauthorized');
      return;
    }
  }

  if (url.pathname === '/health') {
    let total = 0;
    for (const m of tenants.values()) total += m.size;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, tenants: tenants.size, accounts: total }));
    return;
  }

  if (url.pathname === '/status') {
    const filter = url.searchParams.get('user');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(statusPayload(filter ? filter.toLowerCase() : null)));
    return;
  }

  if (url.pathname === '/test-webhook' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const data = JSON.parse(body);
      const siteUser = String(data.siteUser || '').toLowerCase().trim();
      if (!siteUser) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'siteUser required' }));
        return;
      }
      const sent = await sendWebhookTest(siteUser);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sent }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/webhook-info' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const data = JSON.parse(body);
      const metadata = await getWebhookMetadata(data.url);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...metadata }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/config' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const data = JSON.parse(body);
      const siteUser = String(data.siteUser || '').toLowerCase().trim();
      if (!siteUser) {
        res.writeHead(400);
        res.end('siteUser required');
        return;
      }

      const accMap = getTenantAccounts(siteUser);

      if (Array.isArray(data.accounts)) {
        for (const a of data.accounts) {
          if (!a.token) continue;
          const id = a.id || a.token.slice(0, 8);
          const existing = accMap.get(id);
          if (existing) {
            existing.token = a.token;
            if (a.user?.id) existing.user = a.user;
            else await ensureAccountUser(existing);
          } else {
            const entry = {
              ...a,
              id,
              siteUser,
              ws: null,
              heartbeat: null,
              sequence: null,
              reconnect: null
            };
            await ensureAccountUser(entry);
            accMap.set(id, entry);
            startGateway(entry);
          }
        }
      }

      if (Array.isArray(data.watchers)) {
        tenantWatchers.set(siteUser, data.watchers);
      }
      if (Array.isArray(data.webhooks)) {
        tenantWebhooks.set(siteUser, data.webhooks.filter(webhook => {
          if (!webhook?.url) return false;
          try {
            const parsed = new URL(webhook.url);
            return parsed.protocol === 'https:' && (parsed.hostname === 'discord.com' || parsed.hostname.endsWith('.discord.com') || parsed.hostname === 'discordapp.com' || parsed.hostname.endsWith('.discordapp.com'));
          } catch { return false; }
        }).map(webhook => ({ name: webhook.name || 'Discord webhook', url: webhook.url, enabled: webhook.enabled !== false })));
      }
      if (data.webhookSettings && typeof data.webhookSettings === 'object') {
        tenantWebhookSettings.set(siteUser, { everyone: data.webhookSettings.everyone === true, here: data.webhookSettings.here === true });
      }

      await persistTenant(siteUser);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...statusPayload(siteUser) }));
    } catch (e) {
      res.writeHead(400);
      res.end(String(e.message));
    }
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

await loadAllTenants();
startAllGateways();
server.listen(PORT, () => {
  console.log(`multi-tenant discord worker on :${PORT}`);
});
