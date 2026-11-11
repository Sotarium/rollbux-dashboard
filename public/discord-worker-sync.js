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
        }),
      });
    } catch (e) {
      console.warn('[discord-worker-sync]', e);
    }
  }

  function accountForWorkerEvent(event) {
    const accounts = readAccounts();
    const wanted = String(event.account || '').toLowerCase();
    return accounts.find(a => String(a.user?.username || a.user?.handle || a.id || '').toLowerCase() === wanted) || null;
  }

  function normalizeWorkerEvent(event) {
    const raw = String(event.msg || '');
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

  async function pullActivity() {
    const user = siteUser();
    if (!user) return;
    try {
      const res = await fetch(WORKER_URL + '/status?user=' + encodeURIComponent(user), {
        headers: { 'x-worker-secret': WORKER_SECRET }
      });
      if (!res.ok) return;
      const payload = await res.json();
      const incoming = Array.isArray(payload.activity) ? payload.activity.map(normalizeWorkerEvent) : [];
      let existing = [];
      try { existing = JSON.parse(localStorage.getItem('sotarium_discord_activity_v2') || '[]'); } catch (e) {}
      if (!Array.isArray(existing)) existing = [];
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
  window.pullDiscordWorkerActivity = pullActivity;

  window.addEventListener('storage', function (e) {
    if (
      e.key === 'sotarium_discord_accounts' ||
      e.key === 'discord_watchers_list' ||
      e.key === 'sotarium_discord_token'
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
      key === 'sotarium_discord_user'
    ) {
      clearTimeout(window.__dwSyncT);
      window.__dwSyncT = setTimeout(pushConfig, 400);
    }
  };
})();
