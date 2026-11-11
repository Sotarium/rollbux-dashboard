// Discord worker sync — multi-tenant, all /@user pages
(function () {
  const WORKER_URL =
    localStorage.getItem('sotarium_worker_url') ||
    'https://beneficial-adaptation-production-202e1c11.up.railway.app';
  const WORKER_SECRET =
    localStorage.getItem('sotarium_worker_secret') || 'Sotariums';

  function siteUser() {
    try {
      const p = JSON.parse(localStorage.getItem('sotarium_user_profile') || 'null');
      if (p && p.username) return String(p.username).toLowerCase();
    } catch (e) {}
    const path = (location.pathname || '').replace(/^\//, '');
    if (path.startsWith('@')) return path.slice(1).toLowerCase().split('/')[0];
    const part = path.split('/')[0];
    return part && part !== 'index.html' ? part.toLowerCase() : '';
  }

  function readAccounts() {
    try {
      const raw = JSON.parse(localStorage.getItem('sotarium_discord_accounts') || '[]');
      if (Array.isArray(raw)) {
        return raw
          .filter((a) => a && a.token)
          .map((a) => ({ id: a.id, token: a.token, user: a.user }));
      }
    } catch (e) {}
    const token = localStorage.getItem('sotarium_discord_token');
    if (!token) return [];
    let user = null;
    try {
      user = JSON.parse(localStorage.getItem('sotarium_discord_user') || 'null');
    } catch (e) {}
    return [{ id: (user && user.id) || 'main', token, user }];
  }

  function readWatchers() {
    try {
      return JSON.parse(localStorage.getItem('discord_watchers_list') || '[]');
    } catch (e) {
      return [];
    }
  }

  function readWebhooks() {
    try {
      const value = JSON.parse(localStorage.getItem('sotarium_discord_webhooks') || '[]');
      return Array.isArray(value) ? value.filter(w => w && w.url).map(w => ({ name: w.name, url: w.url, enabled: w.enabled !== false })) : [];
    } catch (e) { return []; }
  }

  function readWebhookSettings() {
    try {
      const value = JSON.parse(localStorage.getItem('sotarium_discord_webhook_settings') || '{}');
      return { everyone: value.everyone === true, here: value.here === true };
    } catch (e) { return { everyone: false, here: false }; }
  }

  async function pushConfig() {
    const user = siteUser();
    if (!user) return;
    try {
      await fetch(WORKER_URL + '/config', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-worker-secret': WORKER_SECRET,
        },
        body: JSON.stringify({
          siteUser: user,
          accounts: readAccounts(),
          watchers: readWatchers(),
          webhooks: readWebhooks(),
          webhookSettings: readWebhookSettings(),
        }),
      });
    } catch (e) {
      console.warn('[discord-worker-sync]', e);
    }
  }

  async function testWorkerWebhooks() {
    const user = siteUser();
    if (!user) throw new Error('No site user found.');
    await pushConfig();
    const res = await fetch(WORKER_URL + '/test-webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-worker-secret': WORKER_SECRET },
      body: JSON.stringify({ siteUser: user })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Webhook test failed.');
    return data;
  }

  async function fetchDiscordWebhookInfo(webhookUrl) {
    const res = await fetch(WORKER_URL + '/webhook-info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-worker-secret': WORKER_SECRET },
      body: JSON.stringify({ url: webhookUrl })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not load webhook profile.');
    return data;
  }

  function accountForWorkerEvent(event) {
    const accounts = readAccounts();
    const wanted = String(event.account || '').toLowerCase();
    return accounts.find(a => String(a.user?.username || a.user?.handle || a.id || '').toLowerCase() === wanted) || null;
  }

  function normalizeWorkerEvent(event) {
    const raw = String(event.msg || '');
    if (isTransportEvent({ worker: true, text: raw, tag: 'Worker' }, event.type)) {
      return null;
    }
    const account = accountForWorkerEvent(event);
    let text = raw;
    let tag = event.type === 'error' ? 'Error' : 'Worker';
    let color = event.type === 'error' ? 'red' : undefined;
    if (raw.startsWith('reacted ')) {
      text = 'Joined';
      tag = 'Auto React';
      color = 'green';
    } else if (raw.startsWith('react failed') || raw.startsWith('reaction failed')) {
      text = 'Reaction failed';
      tag = 'Error';
      color = 'red';
    } else if (raw.startsWith('claim ')) {
      tag = 'Claimer';
      color = 'green';
    }
    return {
      ts: Number(event.ts) || Date.now(),
      text,
      tag,
      color,
      accountId: account?.id ? String(account.id) : '',
      accountName: event.account || account?.user?.username || 'Discord worker',
      worker: true
    };
  }

  function isTransportEvent(event, sourceType = '') {
    const text = String(event?.text || event?.msg || '');
    return (sourceType === 'info' || event?.worker) && /^(gateway open|gateway closed|IDENTIFY sent|READY as )/i.test(text);
  }

  async function pullActivity() {
    const user = siteUser();
    if (!user) return;
    try {
      const res = await fetch(WORKER_URL + '/status?user=' + encodeURIComponent(user), {
        headers: { 'x-worker-secret': WORKER_SECRET }
      });
      if (!res.ok) return;
      const payload = await res.json();
      const clearedAt = Number(localStorage.getItem('sotarium_discord_activity_cleared_at') || 0);
      const incoming = (Array.isArray(payload.activity) ? payload.activity.map(normalizeWorkerEvent).filter(Boolean) : [])
        .filter(event => (Number(event.ts) || 0) > clearedAt);
      let existing = [];
      try { existing = JSON.parse(localStorage.getItem('sotarium_discord_activity_v2') || '[]'); } catch (e) {}
      if (!Array.isArray(existing)) existing = [];
      existing = existing.filter(event => !isTransportEvent(event) && (Number(event.ts || event.timestamp) || 0) > clearedAt);
      const merged = [...incoming, ...existing];
      const seen = new Set();
      const deduped = merged.filter(event => {
        const key = [event.worker ? 'worker' : 'local', event.ts, event.accountId || event.accountName, event.text, event.tag].join('|');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0)).slice(0, 200);
      localStorage.setItem('sotarium_discord_activity_v2', JSON.stringify(deduped));
      window.dispatchEvent(new CustomEvent('discord-worker-activity'));
    } catch (e) {
      console.warn('[discord-worker-activity]', e);
    }
  }

  window.pushDiscordConfigToWorker = pushConfig;
  window.testDiscordWorkerWebhooks = testWorkerWebhooks;
  window.fetchDiscordWebhookInfo = fetchDiscordWebhookInfo;
  window.pullDiscordWorkerActivity = pullActivity;

  window.addEventListener('storage', function (e) {
    if (
      e.key === 'sotarium_discord_accounts' ||
      e.key === 'discord_watchers_list' ||
      e.key === 'sotarium_discord_token' ||
      e.key === 'sotarium_discord_webhooks' ||
      e.key === 'sotarium_discord_webhook_settings'
    ) {
      pushConfig();
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      setTimeout(pushConfig, 1500);
      setTimeout(pullActivity, 1800);
    });
  } else {
    setTimeout(pushConfig, 1500);
    setTimeout(pullActivity, 1800);
  }
  window.__discordWorkerActivityTimer = setInterval(pullActivity, 10000);

  const _set = localStorage.setItem.bind(localStorage);
  localStorage.setItem = function (key, value) {
    _set(key, value);
    if (
      key === 'sotarium_discord_accounts' ||
      key === 'discord_watchers_list' ||
      key === 'sotarium_discord_token' ||
      key === 'sotarium_discord_user' ||
      key === 'sotarium_discord_webhooks' ||
      key === 'sotarium_discord_webhook_settings'
    ) {
      clearTimeout(window.__dwSyncT);
      window.__dwSyncT = setTimeout(pushConfig, 400);
    }
  };
})();
