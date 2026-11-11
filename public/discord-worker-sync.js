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

  window.pushDiscordConfigToWorker = pushConfig;

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
    });
  } else {
    setTimeout(pushConfig, 1500);
  }

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
