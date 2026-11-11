// api/roach/tick.js
// Multi-Account Serverless Cloud Worker for RainRoach
// Triggered by cron-job.org every 30-60s. Supports multiple accounts stored in Upstash Redis.

import { handleAction } from '../../server/db.js';

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || "https://flowing-chigger-149490.upstash.io";
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const ENV_SESSION_TOKEN = process.env.ROLLBUX_SESSION_TOKEN;

const ROLLBUX_API_BASE = "https://rollbux.com/_api";

function parseRainSnapshot(payload) {
  const data = payload?.data || {};
  const legacyCycle = data.cycle || {};
  const cycleId = data.cycle_id || legacyCycle.id || null;
  const status = data.status || legacyCycle.status || null;
  const cycleEnd = data.cycle_end ?? legacyCycle.cycle_end ?? null;
  const livePool = data.live_pot ?? data.live_pool ?? 0;
  const joinOpen = typeof data.join_open === 'boolean'
    ? data.join_open
    : Boolean(status === 'COLLECTING' && cycleEnd && new Date(cycleEnd).getTime() > Date.now());

  if (!cycleId) return null;

  const cycleEndMs = cycleEnd ? new Date(cycleEnd).getTime() : NaN;
  const secondsRemaining = Number.isFinite(cycleEndMs)
    ? Math.max(0, Math.round((cycleEndMs - Date.now()) / 1000))
    : null;

  return { cycleId, status, secondsRemaining, livePool, joinOpen };
}

async function redis(command, ...args) {
  if (!UPSTASH_TOKEN) return null;
  const path = [command, ...args.map(a => encodeURIComponent(typeof a === 'object' ? JSON.stringify(a) : String(a)))].join('/');
  try {
    const res = await fetch(`${UPSTASH_URL}/${path}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
    const data = await res.json();
    return data.result;
  } catch (e) {
    console.error('[Roach Redis Error]', e);
    return null;
  }
}

async function rollbuxFetch(endpoint, sessionToken, options = {}) {
  const url = endpoint.startsWith('http') ? endpoint : `${ROLLBUX_API_BASE}${endpoint}`;
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin": "https://rollbux.com",
    "Referer": "https://rollbux.com/",
    "Sec-Ch-Ua": '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    ...(options.headers || {})
  };

  if (sessionToken) {
    headers["Authorization"] = `Bearer ${sessionToken}`;
    headers["Cookie"] = `authjs.session-token=${sessionToken}`;
  }

  const response = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const text = await response.text();
  try {
    return { ok: response.ok, status: response.status, data: JSON.parse(text) };
  } catch {
    return { ok: response.ok, status: response.status, data: text };
  }
}

function isBotChallengeResponse(response) {
  const body = typeof response?.data === 'string'
    ? response.data
    : JSON.stringify(response?.data || '');
  return [403, 429, 503].includes(response?.status) && /cloudflare|turnstile|challenge|captcha/i.test(body);
}

export default async function handler(req, res) {
  const logs = [];
  const log = (msg) => {
    const entry = `[${new Date().toISOString()}] ${msg}`;
    console.log(entry);
    logs.push(entry);
  };

  try {
    log("RainRoach multi-account tick triggered.");

    // 1. Fetch current rain state (public)
    const rainRes = await rollbuxFetch('/rain/current', null);
    if (!rainRes.ok || !rainRes.data || !rainRes.data.data) {
      log(`Failed to fetch rain state: HTTP ${rainRes.status}`);
      return res.status(200).json({ success: false, logs, error: "Rain state fetch failed" });
    }

    const snapshot = parseRainSnapshot(rainRes.data);
    if (!snapshot) {
      log('Rain state response did not contain a cycle id.');
      return res.status(200).json({ success: false, logs, error: "Invalid rain state" });
    }

    const { cycleId, status, secondsRemaining, livePool, joinOpen } = snapshot;
    const cycleKey = String(cycleId);
    // The live API changes status to JOINING during the two-minute join window.
    // Do not gate joining on a legacy COLLECTING status or a <=60s countdown:
    // cycle_end is intentionally null until the window opens, and cron ticks
    // can arrive anywhere inside the window.
    const joinWindowActive = joinOpen && (status === 'COLLECTING' || status === 'JOINING');

    log(`Cycle: ${cycleKey.slice(0, 8)} | Status: ${status} | Join Open: ${joinOpen} | Ends In: ${secondsRemaining ?? 'unknown'}s | Pot: ${livePool}`);

    // 2. Fetch config and all registered accounts from Upstash
    let configRaw = await redis('get', 'roach:config');
    let roachConfig = { auto_messages: false };
    try { if (configRaw) roachConfig = JSON.parse(configRaw); } catch { log('Invalid roach:config in Redis; using defaults.'); }
    const autoMessagesEnabled = Boolean(roachConfig.auto_messages);
    log(`Auto Messages setting: ${autoMessagesEnabled ? 'ENABLED' : 'DISABLED'}`);

    let accountsRaw = await redis('get', 'roach:accounts');
    let accounts = [];
    try {
      const parsedAccounts = accountsRaw ? JSON.parse(accountsRaw) : [];
      accounts = Array.isArray(parsedAccounts) ? parsedAccounts : [];
    } catch { log('Invalid roach:accounts in Redis; ignoring malformed global records.'); }

    // Include accounts saved from private user account pages. They are indexed
    // separately so private dashboard data is never merged across users.
    const privateOwnerIds = await redis('smembers', 'roach:account_users');
    if (Array.isArray(privateOwnerIds)) {
      const privateLists = await Promise.all(privateOwnerIds.map(async (ownerId) => {
        const raw = await redis('get', `roach:accounts:user:${ownerId}`);
        try { return raw ? JSON.parse(raw) : []; } catch { return []; }
      }));
      const knownIds = new Set(accounts.map(account => account.id));
      for (const privateAccounts of privateLists) {
        for (const account of privateAccounts) {
          if (account?.token && !knownIds.has(account.id)) {
            accounts.push(account);
            knownIds.add(account.id);
          }
        }
      }
    }

    // Fallback: if no accounts in Redis but ENV token exists, treat as single account
    if (accounts.length === 0 && ENV_SESSION_TOKEN) {
      accounts = [{ id: 'env_main', name: 'Primary (ENV)', token: ENV_SESSION_TOKEN }];
    }

    log(`Registered accounts active: ${accounts.length}`);

    const results = [];
    const usedMessagesInTick = new Set();
    const usedCategoriesInTick = new Set();

    // Diverse chat message pools categorized so two accounts never send related phrases (e.g. "big" and "rain")
    // Each account gets assigned to a completely distinct style pool or selects non-correlated messages
    const messageCategories = [
      ["gg", "gl", "gl all", "gl everyone", "ggs", "gl gl"],
      ["yo", "hey", "sup", "gm", "whats up", "hello"],
      [":)", ":D", "<3", "xD", "^^", "ty", "thanks"],
      ["nice", "clean", "lets go", "hype", "w", "huge pot"],
      [".", "!", "..", "...", "nice one"]
    ];

    function pickUniqueMsgForAccount(accIdx) {
      // Pick a category not yet used in this tick
      const availableCategories = messageCategories.map((c, idx) => idx).filter(idx => !usedCategoriesInTick.has(idx));
      const catIdx = availableCategories.length > 0 
        ? availableCategories[Math.floor(Math.random() * availableCategories.length)]
        : accIdx % messageCategories.length;
      
      usedCategoriesInTick.add(catIdx);
      const catMessages = messageCategories[catIdx];
      const available = catMessages.filter(m => !usedMessagesInTick.has(m));
      const pool = available.length > 0 ? available : catMessages;
      const picked = pool[Math.floor(Math.random() * pool.length)];
      usedMessagesInTick.add(picked);
      return picked;
    }

    // 3. Process each account individually
    for (let i = 0; i < accounts.length; i++) {
      const acc = accounts[i];
      const accId = acc.id;
      const accName = acc.name;
      const token = acc.token;

      if (!token) {
        results.push({ account: accName, status: "NO_TOKEN" });
        continue;
      }

      // Random delay between 5 to 10 seconds between accounts so their messages and actions are spaced out naturally
      if (i > 0) {
        const delayMs = Math.floor(1000 + Math.random() * 1000); // 1000ms - 2000ms (kept short to avoid Vercel timeout)
        log(`Waiting ${(delayMs / 1000).toFixed(1)}s before processing next account (${accName})...`);
        await new Promise(r => setTimeout(r, delayMs));
      }

      // Check if this account already joined this cycle
      const joinedKey = `roach:joined:${cycleKey}:${accId}`;
      let isAccountJoined = (await redis('get', joinedKey)) === '1';

      // Sync active rain tick to local player dashboard
      const potBux = parseFloat(((livePool || 0) / 1000000).toFixed(2));
      try {
        handleAction({
          action: 'rain_tick',
          username: accName,
          cycle_id: cycleKey,
          time_left: secondsRemaining ?? 0,
          pot_amount: potBux
        });
      } catch (e) {}

      // Synchronized Chat Schedule (3 messages evenly spaced):
      // Only active if autoMessagesEnabled is true
      const chatKey = `roach:chat_count:${cycleId}:${accId}`;
      let chatCount = parseInt((await redis('get', chatKey)) || '0', 10);

      if (autoMessagesEnabled) {
        const targetCount = secondsRemaining !== null
          ? (secondsRemaining <= 220 ? 3 : (secondsRemaining <= 1200 ? 2 : (secondsRemaining <= 2400 ? 1 : 0)))
          : 0;

        if (chatCount < targetCount && secondsRemaining > 90) {
          const uniqueMsg = pickUniqueMsgForAccount(i);

          const chatRes = await rollbuxFetch('/users/chat', token, {
            method: 'POST',
            headers: { "Content-Type": "application/json" },
            body: { message: uniqueMsg }
          });

          if (chatRes.ok) {
            chatCount += 1;
            await redis('set', chatKey, chatCount);
            log(`[${accName}] Synchronized chat sent: "${uniqueMsg}" (${chatCount}/3)`);
          }
        }

        // Emergency Chat Catchup: If short on time (<= 90s) and missing messages, send them right before join
        if (chatCount < 3 && secondsRemaining !== null && secondsRemaining <= 90 && status === 'COLLECTING') {
          const missing = 3 - chatCount;
          log(`[${accName}] Late on messages (${chatCount}/3), bursting ${missing} message(s) before joining...`);
          for (let j = 0; j < missing; j++) {
            const m = pickUniqueMsgForAccount(i + j + 1);
            const res = await rollbuxFetch('/users/chat', token, {
              method: 'POST',
              headers: { "Content-Type": "application/json" },
              body: { message: m }
            });
            if (res.ok) {
              chatCount += 1;
              await redis('set', chatKey, chatCount);
              log(`[${accName}] Catchup message ${chatCount}/3 sent ("${m}")`);
              // Pause 5 to 7 seconds between burst messages
              const burstDelay = Math.floor(1000 + Math.random() * 1000);
              await new Promise(r => setTimeout(r, burstDelay));
            }
          }
        }
      } else {
        log(`[${accName}] Auto Messages disabled; skipping chat (chat count: ${chatCount}).`);
      }

      // Join Engine: follow the live randomized join window instead of a clock schedule
      let joinStatus = isAccountJoined ? "ALREADY_JOINED" : "WAITING";
      if (joinWindowActive && !isAccountJoined) {
        log(`[${accName}] Attempting Rain Join...`);

        const joinRes = await rollbuxFetch('/users/me/rain/join', token, {
          method: 'POST',
          headers: { "Content-Type": "application/json" },
          body: { token: null }
        });

        if (joinRes.ok) {
          log(`[${accName}] JOIN SUCCESSFUL! 🎉`);
          await redis('set', joinedKey, '1');
          joinStatus = "SUCCESS";
          isAccountJoined = true;
        } else if (isBotChallengeResponse(joinRes)) {
          log(`[${accName}] Join blocked by Cloudflare/Turnstile challenge (HTTP ${joinRes.status}); manual browser verification is required.`);
          joinStatus = `CHALLENGE_REQUIRED_${joinRes.status}`;
        } else {
          const errDetail = String((joinRes.data && (joinRes.data.message || joinRes.data.error)) || JSON.stringify(joinRes.data));
          log(`[${accName}] Join failed (HTTP ${joinRes.status}): ${errDetail}`);
          joinStatus = `FAILED_${joinRes.status} (${errDetail.slice(0, 30)})`;
        }
      }

      results.push({
        id: accId,
        name: accName,
        joined: isAccountJoined,
        chat_count: chatCount,
        join_status: joinStatus
      });
    }

    // 4. Update overall status in Redis
    const dashboardState = {
      updated_at: new Date().toISOString(),
      cycle_id: cycleKey,
      status,
      seconds_remaining: secondsRemaining,
      join_open: joinOpen,
      live_pool: livePool,
      accounts: results,
      last_logs: logs
    };
    await redis('set', 'roach:status', JSON.stringify(dashboardState));

    return res.status(200).json({
      success: true,
      cycle_id: cycleKey,
      seconds_remaining: secondsRemaining,
      accounts: results,
      logs
    });
  } catch (err) {
    log(`Fatal Error: ${err.message}`);
    return res.status(500).json({ success: false, error: err.message, logs });
  }
}
