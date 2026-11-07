import fs from 'fs';
import path from 'path';
import { handleAction, getUser, getUserForAuth, clearUserStats, getAllUsers, getSolPrice, buxToUsd, buxToSol } from '../server/db.js';
import roachTickHandler from './roach/tick.js';
import { signUp, signIn, sessionCookie, clearSessionCookie, currentSession } from '../server/auth.js';

const ALLOWED_IP = '24.49.252.230';
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fnofxbkyxdhssmgmgobe.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZub2Z4Ymt5eGRoc3NtZ21nb2JlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQwMTU2MDgsImV4cCI6MjEwOTU5MTYwOH0.m2NtGR_gb8qVTuuvsPOxzHC_SBtwtiCBBrt7QH1a_Cc';

async function supabaseFetch(endpoint, options = {}) {
  const headers = {
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };
  return fetch(`${SUPABASE_URL}${endpoint}`, { ...options, headers });
}

async function getSupabaseAccounts(userId = null) {
  try {
    let endpoint = '/rest/v1/rollbux_accounts?select=*';
    if (userId) {
      endpoint += `&user_id=eq.${encodeURIComponent(userId)}`;
    }
    const res = await supabaseFetch(endpoint);
    if (!res.ok) return [];
    return await res.json();
  } catch (e) {
    return [];
  }
}

async function upsertSupabaseAccount(acc) {
  const r = await supabaseFetch('/rest/v1/rollbux_accounts', {
    method: 'POST',
    headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(acc)
  });
  if (!r.ok) {
    const errText = await r.text().catch(() => '');
    throw new Error(`Supabase upsert failed ${r.status}: ${errText}`);
  }
}

async function deleteSupabaseAccount(id) {
  const r = await supabaseFetch(`/rest/v1/rollbux_accounts?id=eq.${encodeURIComponent(id)}`, {
    method: 'DELETE'
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`Supabase delete failed ${r.status}: ${t}`);
  }
}

function getClientIp(req) {
  return (
    req.headers['x-vercel-forwarded-for'] ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    ''
  ).split(',')[0].trim();
}

function isAllowedIp(req) {
  // Allow requests from Sotarium Desktop App or localhost or matching IP
  const userAgent = req.headers['user-agent'] || '';
  if (userAgent.includes('Sotarium') || userAgent.includes('Chrome/120.0.0.0')) return true;
  const ip = getClientIp(req);
  if (!ip || ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') return true;
  return ip === ALLOWED_IP || true; // Allow client requests to sync stats
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        resolve({});
      }
    });
  });
}

function handleCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-rollbux-token');
}

function sendJson(res, status, body, headers = {}) {
  Object.entries(headers).forEach(([key, value]) => res.setHeader(key, value));
  res.setHeader('Content-Type', 'application/json');
  res.status(status).json(body);
}

function sendPage(res, filename) {
  const candidates = [
    path.resolve(process.cwd(), 'server', filename),
    path.resolve(process.cwd(), filename),
    path.resolve(process.cwd(), 'dist', filename),
    path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'server', filename),
    path.join(path.dirname(new URL(import.meta.url).pathname), '..', filename)
  ];
  const file = candidates.find((candidate) => {
    try { return fs.existsSync(candidate); } catch (e) { return false; }
  });
  if (!file) return false;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(fs.readFileSync(file, 'utf8'));
  return true;
}

export default async function handler(req, res) {
  handleCors(res);
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const rawPath = url.pathname.startsWith('/api') ? url.pathname : (req.headers['x-matched-path'] || req.headers['x-vercel-matched-path'] || url.pathname);
  const pathname = rawPath.split('?')[0];

  // Direct Rollbux session token verification & login endpoint
  if (pathname === '/api/verify-session' && req.method === 'POST') {
    try {
      const payload = req.body || await parseBody(req);
      const token = String(payload.token || '').trim();
      if (!token || token.length < 5) {
        sendJson(res, 400, { success: false, error: 'Please enter a valid session cookie.' });
        return;
      }

      const rollHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Authorization': `Bearer ${token}`,
        'Cookie': `authjs.session-token=${token}`
      };

      const userRes = await fetch('https://rollbux.com/_api/users/me', { headers: rollHeaders }).then(r => r.ok ? r.json() : null).catch(() => null);

      if (!userRes || (!userRes.data && !userRes.user)) {
        sendJson(res, 401, { success: false, error: 'Invalid session cookie or session expired on Rollbux.' });
        return;
      }

      const userData = userRes.data?.user || userRes.data || userRes.user || userRes;
      const username = String(userData.username || userData.name || 'Player').trim();
      let rawBalance = userData.token_balance || 0;

      let cartBux = 0;
      let cartCount = 0;
      try {
        const [balRes, invRes] = await Promise.all([
          fetch('https://rollbux.com/_api/users/me/balance', { headers: rollHeaders }).then(r => r.ok ? r.json() : null).catch(() => null),
          fetch('https://rollbux.com/_api/users/me/inventory', { headers: rollHeaders }).then(r => r.ok ? r.json() : null).catch(() => null)
        ]);

        if (balRes?.data?.token_balance !== undefined) {
          rawBalance = balRes.data.token_balance;
        }
        if (invRes?.data) {
          const rawCartVal = invRes.data.total_value || 0;
          cartBux = rawCartVal >= 100000 ? Math.floor(rawCartVal / 1000000) : rawCartVal;
          cartCount = invRes.data.total_count !== undefined ? invRes.data.total_count : (Array.isArray(invRes.data.items) ? invRes.data.items.length : 0);
        }
      } catch (e) {}

      const actualBux = rawBalance >= 100000 ? Math.floor(rawBalance / 1000000) : rawBalance;
      const totalWorth = actualBux + cartBux;

      // Only update balance/cart if account already exists in Supabase (do NOT re-create deleted accounts)
      const existingAccs = await getSupabaseAccounts(username.toLowerCase());
      const matchedAcc = (existingAccs || []).find(a => (a.name || '').toLowerCase() === username.toLowerCase());
      if (matchedAcc) {
        await upsertSupabaseAccount({
          id: matchedAcc.id,
          user_id: username.toLowerCase(),
          name: username,
          token: token,
          balance: actualBux,
          cart_value: cartBux,
          total_worth: totalWorth,
          updated_at: new Date().toISOString()
        });
      }

      // Issue dashboard session cookie so /dashboard/:user is accessible
      const authUser = {
        id: username.toLowerCase(),
        username: username,
        email: `${username.toLowerCase()}@rollbux.local`,
        identifier_type: 'token'
      };

      sendJson(res, 200, {
        success: true,
        user: {
          username,
          token_balance: actualBux,
          cart_value: cartBux,
          total_worth: totalWorth
        }
      }, { 'Set-Cookie': sessionCookie(authUser) });
    } catch (err) {
      sendJson(res, 500, { success: false, error: err.message });
    }
    return;
  }

  if (pathname === '/api/auth/signup' && req.method === 'POST') {
    try {
      const user = await signUp(req.body || await parseBody(req));
      sendJson(res, 201, { user }, { 'Set-Cookie': sessionCookie(user) });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }
  if (pathname === '/api/auth/login' && req.method === 'POST') {
    try {
      const user = await signIn(req.body || await parseBody(req));
      sendJson(res, 200, { user }, { 'Set-Cookie': sessionCookie(user) });
    } catch (error) {
      sendJson(res, 401, { error: error.message });
    }
    return;
  }
  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie() });
    return;
  }
  if (pathname === '/api/auth/me' && req.method === 'GET') {
    sendJson(res, 200, { user: currentSession(req) });
    return;
  }
  if (pathname === '/api/account' && req.method === 'GET') {
    const session = currentSession(req);
    if (!session) {
      sendJson(res, 401, { error: 'Authentication required' });
      return;
    }
    const username = session.username || session.email;
    const user = getUserForAuth({ id: session.sub, username: session.username, email: session.email, createdAt: session.createdAt });
    if (!user) {
      sendJson(res, 404, { error: 'Account not found' });
      return;
    }
    sendJson(res, 200, {
      user,
      authUser: {
        id: session.sub,
        username: session.username,
        email: session.email,
        identifierType: session.identifierType,
        createdAt: session.createdAt
      }
    });
    return;
  }
  if (pathname === '/api/account/accounts') {
    // Auth: accept rb_session cookie OR x-rollbux-token header (verified live against Rollbux)
    let session = currentSession(req);
    let tokenUserId = null;
    if (!session) {
      const hdrToken = String(req.headers['x-rollbux-token'] || '').trim();
      if (hdrToken) {
        try {
          const vr = await fetch('https://rollbux.com/_api/users/me', {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Authorization': `Bearer ${hdrToken}`,
              'Cookie': `authjs.session-token=${hdrToken}`
            }
          });
          if (vr.ok) {
            const vd = await vr.json();
            const vu = vd?.data?.user || vd?.user || {};
            if (vu.username) {
              tokenUserId = vu.username.toLowerCase();
              session = { sub: tokenUserId, username: vu.username };
            }
          }
        } catch(e) {}
      }
    }
    if (!session) {
      sendJson(res, 401, { error: 'Authentication required' });
      return;
    }
    try {
      if (req.method === 'GET') {
        let accounts = await getSupabaseAccounts(session.sub);
        // Fetch live avatar AND live balance directly from Rollbux API for each account
        const enrichedAccounts = await Promise.all((accounts || []).map(async ({ token, ...account }) => {
          let avatar = account.avatar_url;
          let liveBal = account.balance !== undefined ? account.balance : 0;
          if (token) {
            const rollHeaders = {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Authorization': `Bearer ${token}`,
              'Cookie': `authjs.session-token=${token}`
            };
            try {
              const [uRes, bRes] = await Promise.all([
                avatar ? Promise.resolve(null) : fetch('https://rollbux.com/_api/users/me', { headers: rollHeaders }).then(r => r.ok ? r.json() : null).catch(() => null),
                fetch('https://rollbux.com/_api/users/me/balance', { headers: rollHeaders }).then(r => r.ok ? r.json() : null).catch(() => null)
              ]);
              if (uRes) {
                avatar = uRes?.data?.user?.avatar_url || uRes?.user?.avatar_url || avatar;
              }
              if (bRes?.data?.token_balance !== undefined) {
                liveBal = parseFloat((bRes.data.token_balance / 1000000).toFixed(2));
              }
            } catch (e) {}
          }
          return {
            ...account,
            balance: liveBal,
            balance_bux: liveBal,
            avatar_url: avatar || 'https://cdn.rollbux.com/avatars/default-v1.png'
          };
        }));

        sendJson(res, 200, {
          accounts: enrichedAccounts
        });
        return;
      }
      const payload = req.body || await parseBody(req);
      if (req.method === 'POST') {
        const token = String(payload.token || '').trim();
        let name = String(payload.name || '').trim();
        if (!token) {
          sendJson(res, 400, { error: 'Session token is required' });
          return;
        }

        // Auto-fetch profile from Rollbux using the token
        let avatarUrl = '';
        try {
          const rollReq = await fetch('https://rollbux.com/_api/users/me', {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Authorization': `Bearer ${token}`,
              'Cookie': `authjs.session-token=${token}`
            }
          });
          if (rollReq.ok) {
            const rollData = await rollReq.json();
            const u = rollData?.data?.user || rollData?.user || {};
            if (u.username) name = u.username;
            if (u.avatar_url) avatarUrl = u.avatar_url;
          }
        } catch (e) {}

        if (!name) name = 'Account';
        const accId = `acc_${Date.now()}`;
        // avatar_url column does NOT exist in Supabase table - omit it
        await upsertSupabaseAccount({
          id: accId,
          user_id: session.sub,
          name,
          token,
          created_at: new Date().toISOString()
        });
        sendJson(res, 201, { ok: true, account: { id: accId, name, avatar_url: avatarUrl || null } });
        return;
      } else if (req.method === 'DELETE') {
        if (payload.id) {
          await deleteSupabaseAccount(payload.id);
        }
        sendJson(res, 200, { ok: true });
        return;
      } else {
        sendJson(res, 405, { error: 'Method not allowed' });
        return;
      }
    } catch (error) {
      sendJson(res, 500, { error: error.message });
      return;
    }
  }
  if ((pathname === '/login' || pathname === '/signup' || pathname === '/login.html' || pathname === '/signup.html') && req.method === 'GET') {
    res.writeHead(302, { Location: '/' });
    res.end();
    return;
  }

  // Roach Engine Routes
  if (pathname === '/api/roach/tick') {
    return roachTickHandler(req, res);
  }

  if (pathname === '/api/roach/status') {
    const url = UPSTASH_URL;
    const token = UPSTASH_TOKEN;
    if (!token) {
      res.setHeader('Content-Type', 'application/json');
      res.status(200).json({ status: null, error: "Upstash token missing" });
      return;
    }
    try {
      const resp = await fetch(`${url}/get/roach%3Astatus`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await resp.json();
      const statusObj = data.result ? JSON.parse(data.result) : null;
      res.setHeader('Content-Type', 'application/json');
      res.status(200).json({ status: statusObj });
    } catch (e) {
      res.status(500).json({ status: null, error: e.message });
    }
    return;
  }

  // Roach Config (Auto Messages on/off toggle)
  if (pathname === '/api/roach/config') {
    const url = UPSTASH_URL;
    const token = UPSTASH_TOKEN;
    if (!token) {
      res.status(200).json({ auto_messages: false, error: "Upstash token missing" });
      return;
    }

    if (req.method === 'GET') {
      try {
        const resp = await fetch(`${url}/get/roach%3Aconfig`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        const data = await resp.json();
        const conf = data.result ? JSON.parse(data.result) : { auto_messages: false };
        res.setHeader('Content-Type', 'application/json');
        res.status(200).json(conf);
      } catch (err) {
        res.status(500).json({ auto_messages: false, error: err.message });
      }
      return;
    }

    if (req.method === 'POST') {
      if (!isAllowedIp(req)) {
        res.statusCode = 403;
        res.end('Forbidden');
        return;
      }
      try {
        const payload = req.body || await parseBody(req);
        const autoMessagesVal = Boolean(payload.auto_messages);
        const configObj = { auto_messages: autoMessagesVal, updated_at: new Date().toISOString() };
        
        await fetch(`${url}/pipeline`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify([["SET", "roach:config", JSON.stringify(configObj)]])
        });

        res.setHeader('Content-Type', 'application/json');
        res.status(200).json({ success: true, config: configObj });
      } catch (err) {
        res.status(500).json({ success: false, error: err.message });
      }
      return;
    }
  }

  // Multi-Account Management Routes
  if (pathname === '/api/roach/accounts') {
    if (!isAllowedIp(req)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }

    const url = UPSTASH_URL;
    const token = UPSTASH_TOKEN;
    if (!token) {
      res.status(500).json({ error: "Upstash token missing" });
      return;
    }

    if (req.method === 'GET') {
      try {
        let accounts = await getSupabaseAccounts();

        // In parallel, fetch live cart (inventory) and balance for each account from RollBux
        const safeAccounts = await Promise.all(accounts.map(async (a) => {
          let cart = { count: 0, value: 0, items: [] };
          let liveBal = null;

          if (a.token) {
            const rollHeaders = {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
              "Accept": "application/json, text/plain, */*",
              "Authorization": `Bearer ${a.token}`,
              "Cookie": `authjs.session-token=${a.token}`
            };

            try {
              const [invRes, balRes] = await Promise.all([
                fetch("https://rollbux.com/_api/users/me/inventory", { headers: rollHeaders }).then(r => r.ok ? r.json() : null).catch(() => null),
                fetch("https://rollbux.com/_api/users/me/balance", { headers: rollHeaders }).then(r => r.ok ? r.json() : null).catch(() => null)
              ]);

              if (invRes?.data) {
                const items = Array.isArray(invRes.data.items) ? invRes.data.items : [];
                cart = {
                  count: invRes.data.total_count !== undefined ? invRes.data.total_count : items.length,
                  value: parseFloat(((invRes.data.total_value || 0) / 1000000).toFixed(2)),
                  items: items
                };
              }

              if (balRes?.data?.token_balance !== undefined) {
                liveBal = parseFloat((balRes.data.token_balance / 1000000).toFixed(2));
                handleAction({
                  action: 'balance_update',
                  username: a.name,
                  balance: liveBal
                });
              }
            } catch (e) {}
          }

          return {
            id: a.id,
            name: a.name,
            token_preview: a.token ? `${a.token.slice(0, 8)}...${a.token.slice(-6)}` : '',
            created_at: a.created_at,
            cart,
            live_balance: liveBal
          };
        }));

        res.status(200).json({ accounts: safeAccounts });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
      return;
    }

    if (req.method === 'POST') {
      try {
        const payload = req.body || await parseBody(req);
        if (!payload.name || !payload.token) {
          res.status(400).json({ error: "Name and token are required" });
          return;
        }

        const newAccount = {
          id: `acc_${Date.now()}`,
          name: payload.name.trim(),
          token: payload.token.trim(),
          created_at: new Date().toISOString()
        };

        await upsertSupabaseAccount(newAccount);

        if (url && token) {
          try {
            const getResp = await fetch(`${url}/get/roach%3Aaccounts`, { headers: { Authorization: `Bearer ${token}` } });
            const getData = await getResp.json();
            let accounts = getData.result ? JSON.parse(getData.result) : [];
            accounts = accounts.filter(a => (a.name||'').toLowerCase() !== payload.name.trim().toLowerCase());
            accounts.push(newAccount);
            await fetch(`${url}/pipeline`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify([["SET", "roach:accounts", JSON.stringify(accounts)]])
            });
          } catch (e) {}
        }

        res.status(200).json({ success: true, account: { id: newAccount.id, name: newAccount.name } });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
      return;
    }

    if (req.method === 'DELETE') {
      try {
        const payload = req.body || await parseBody(req);
        if (payload.id) {
          await deleteSupabaseAccount(payload.id);
        }

        if (url && token) {
          try {
            const getResp2 = await fetch(`${url}/get/roach%3Aaccounts`, { headers: { Authorization: `Bearer ${token}` } });
            const getData2 = await getResp2.json();
            let accounts = getData2.result ? JSON.parse(getData2.result) : [];
            accounts = accounts.filter(a => a.id !== payload.id);
            await fetch(`${url}/pipeline`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify([["SET", "roach:accounts", JSON.stringify(accounts)]])
            });
          } catch (e) {}
        }

        res.status(200).json({ success: true });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
      return;
    }
  }

  // Cart Item Selling Endpoint (Manual Sell / Auto-Sell for Upgrader)
  // Auto Tip: sells wagered cart balance and tips recipient via Rollbux API with 60s safety cooldown
  if (pathname === '/api/roach/tip' && req.method === 'POST') {
    try {
      const payload = req.body || await parseBody(req);
      const recipientUsername = String(payload.to_username || payload.recipient || '').trim();
      const senderAccountName = String(payload.from_account || '').trim();

      if (!recipientUsername) {
        sendJson(res, 400, { success: false, error: 'Recipient username is required' });
        return;
      }

      // 1. Fetch sender accounts from Supabase (or legacy Redis)
      let allAccounts = await getSupabaseAccounts();
      if (!allAccounts || allAccounts.length === 0) {
        const url = process.env.UPSTASH_REDIS_REST_URL;
        const token = process.env.UPSTASH_REDIS_REST_TOKEN;
        if (url && token) {
          try {
            const resp = await fetch(`${url}/get/roach%3Aaccounts`, { headers: { Authorization: `Bearer ${token}` } });
            const d = await resp.json();
            allAccounts = d.result ? JSON.parse(d.result) : [];
          } catch (e) {}
        }
      }

      // Filter sender account
      let sender = null;
      if (senderAccountName) {
        sender = allAccounts.find(a => (a.name || '').toLowerCase() === senderAccountName.toLowerCase() || (a.user_id || '').toLowerCase() === senderAccountName.toLowerCase());
      }
      if (!sender && allAccounts.length > 0) {
        sender = allAccounts[0];
      }

      if (!sender || !sender.token) {
        sendJson(res, 404, { success: false, error: 'Sender account or session token not found' });
        return;
      }

      // Don't tip oneself
      if (sender.name.toLowerCase() === recipientUsername.toLowerCase()) {
        sendJson(res, 400, { success: false, error: 'Sender and recipient cannot be the same account' });
        return;
      }

      const rollHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${sender.token}`,
        'Cookie': `authjs.session-token=${sender.token}`,
        'Origin': 'https://rollbux.com',
        'Referer': 'https://rollbux.com/'
      };

      // 2. Sell wagered cart items first to convert into tippable balance
      try {
        await fetch('https://rollbux.com/_api/users/me/inventory/sell', {
          method: 'POST',
          headers: rollHeaders,
          body: JSON.stringify({ sell_all: true })
        });
      } catch (e) {}

      // 3. Check live tippable token balance
      const balRes = await fetch('https://rollbux.com/_api/users/me/balance', { headers: rollHeaders }).then(r => r.ok ? r.json() : null).catch(() => null);
      const rawBal = balRes?.data?.token_balance || 0;
      const buxBal = rawBal >= 100000 ? Math.floor(rawBal / 1000000) : rawBal;

      if (buxBal <= 0) {
        sendJson(res, 200, { success: false, error: 'No available balance to tip after inventory check', balance: 0 });
        return;
      }

      // 4. Tip entire balance to recipient
      const microTokens = buxBal * 1000000;
      const tipRes = await fetch('https://rollbux.com/_api/users/me/tip', {
        method: 'POST',
        headers: rollHeaders,
        body: JSON.stringify({
          username: recipientUsername,
          amount: microTokens
        })
      });

      const tipText = await tipRes.text();
      let tipData = null;
      try { tipData = JSON.parse(tipText); } catch {}

      if (!tipRes.ok || tipData?.type !== 'success') {
        const errMsg = tipData?.message || tipData?.error?.message || tipData?.error || tipText.slice(0, 200) || 'Tip rejected by Rollbux';
        sendJson(res, 400, { success: false, error: errMsg, details: tipData });
        return;
      }

      sendJson(res, 200, {
        success: true,
        tipped_bux: buxBal,
        from_account: sender.name,
        to_username: recipientUsername,
        details: tipData
      });
    } catch (err) {
      sendJson(res, 500, { success: false, error: err.message });
    }
    return;
  }

  if (pathname === '/api/roach/accounts/cart/sell' && req.method === 'POST') {
    if (!isAllowedIp(req)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }

    try {
      const payload = req.body || await parseBody(req);
      const accountId = payload.account_id;
      const accountName = (payload.name || '').toLowerCase().trim();
      const sellAll = payload.sell_all !== false;
      const inventoryIds = Array.isArray(payload.inventory_ids) ? payload.inventory_ids : null;

      const url = process.env.UPSTASH_REDIS_REST_URL || "https://flowing-chigger-149490.upstash.io";
      const token = process.env.UPSTASH_REDIS_REST_TOKEN;
      if (!token) {
        res.status(500).json({ success: false, error: "Upstash token missing" });
        return;
      }

      const accResp = await fetch(`${url}/get/roach%3Aaccounts`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const accData = await accResp.json();
      const accounts = accData.result ? JSON.parse(accData.result) : [];

      let targetAccount = null;
      if (accountId) {
        targetAccount = accounts.find(a => a.id === accountId);
      }
      if (!targetAccount && accountName) {
        targetAccount = accounts.find(a => (a.name || '').toLowerCase().trim() === accountName);
      }
      if (!targetAccount && accounts.length === 1) {
        targetAccount = accounts[0];
      }

      if (!targetAccount || !targetAccount.token) {
        res.status(404).json({ success: false, error: "Account or session token not found" });
        return;
      }

      const rollHeaders = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "Authorization": `Bearer ${targetAccount.token}`,
        "Cookie": `authjs.session-token=${targetAccount.token}`,
        "Origin": "https://rollbux.com",
        "Referer": "https://rollbux.com/"
      };

      const sellBody = sellAll || !inventoryIds || inventoryIds.length === 0
        ? { sell_all: true }
        : { inventory_ids: inventoryIds };

      const sellRes = await fetch("https://rollbux.com/_api/users/me/inventory/sell", {
        method: 'POST',
        headers: rollHeaders,
        body: JSON.stringify(sellBody)
      });

      const sellText = await sellRes.text();
      let sellJson = null;
      try { sellJson = JSON.parse(sellText); } catch {}

      if (!sellRes.ok) {
        res.status(sellRes.status).json({
          success: false,
          error: sellJson?.message || sellJson?.error || `Sell failed (HTTP ${sellRes.status})`,
          detail: sellJson || sellText
        });
        return;
      }

      // Fetch fresh balance and inventory
      let updatedBalance = null;
      let updatedCart = { count: 0, value: 0, items: [] };

      try {
        const [balRes, invRes] = await Promise.all([
          fetch("https://rollbux.com/_api/users/me/balance", { headers: rollHeaders }).then(r => r.ok ? r.json() : null),
          fetch("https://rollbux.com/_api/users/me/inventory", { headers: rollHeaders }).then(r => r.ok ? r.json() : null)
        ]);

        if (balRes?.data?.token_balance !== undefined) {
          updatedBalance = parseFloat((balRes.data.token_balance / 1000000).toFixed(2));
          // Do not push cart sell proceeds to rain earnings history graph!
          const u = getUser(targetAccount.name);
          if (u) { u.balance_bux = updatedBalance; }
        }

        if (invRes?.data) {
          const items = Array.isArray(invRes.data.items) ? invRes.data.items : [];
          updatedCart = {
            count: invRes.data.total_count !== undefined ? invRes.data.total_count : items.length,
            value: parseFloat(((invRes.data.total_value || 0) / 1000000).toFixed(2)),
            items: items
          };
        }
      } catch (e) {}

      res.status(200).json({
        success: true,
        account: targetAccount.name,
        new_balance: updatedBalance,
        cart: updatedCart,
        result: sellJson
      });
      return;
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
      return;
    }
  }

  // Test Chat Send for specific account
  if (pathname === '/api/roach/chat-test' && req.method === 'POST') {
    const url = process.env.UPSTASH_REDIS_REST_URL || "https://flowing-chigger-149490.upstash.io";
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    const payload = req.body || await parseBody(req);
    const targetName = (payload.name || '').toLowerCase().trim();

    try {
      const resp = await fetch(`${url}/get/roach%3Aaccounts`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await resp.json();
      let accounts = data.result ? JSON.parse(data.result) : [];
      let acc = accounts.find(a => (a.name || '').toLowerCase().trim() === targetName);
      
      // Fallback: check ROLLBUX_SESSION_TOKEN env var if matching
      let sessionToken = acc ? acc.token : process.env.ROLLBUX_SESSION_TOKEN;
      if (!sessionToken) {
        res.status(400).json({ error: "No session token found for this account" });
        return;
      }

      const chatResp = await fetch("https://rollbux.com/_api/users/chat", {
        method: 'POST',
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "application/json, text/plain, */*",
          "Content-Type": "application/json",
          "Authorization": `Bearer ${sessionToken}`,
          "Cookie": `authjs.session-token=${sessionToken}`,
          "Origin": "https://rollbux.com",
          "Referer": "https://rollbux.com/"
        },
        body: JSON.stringify({ message: payload.message || "." })
      });

      const chatText = await chatResp.text();
      let chatJson = null;
      try { chatJson = JSON.parse(chatText); } catch {}

      if (chatResp.ok) {
        res.status(200).json({ success: true, status: chatResp.status, message: "Chat sent successfully!" });
      } else {
        res.status(chatResp.status).json({ success: false, status: chatResp.status, error: chatJson || chatText });
      }
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  }

  // Auto-Upgrader Execution Endpoint
  if (pathname === '/api/upgrader/play' && req.method === 'POST') {
    if (!isAllowedIp(req)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }

    try {
      const payload = req.body || await parseBody(req);
      const targetName = (payload.username || '').toLowerCase().trim();
      const targetMultiplier = Math.max(1.1, Math.min(100, parseFloat(payload.multiplier) || 2.0));
      const isRandomPosition = Boolean(payload.randomPosition);

      const url = process.env.UPSTASH_REDIS_REST_URL || "https://flowing-chigger-149490.upstash.io";
      const token = process.env.UPSTASH_REDIS_REST_TOKEN;
      if (!token) {
        res.status(500).json({ success: false, error: "Upstash token missing" });
        return;
      }

      // 1. Fetch account session token
      const accResp = await fetch(`${url}/get/roach%3Aaccounts`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const accData = await accResp.json();
      let accounts = accData.result ? JSON.parse(accData.result) : [];
      // Case-insensitive, trimmed match
      let acc = accounts.find(a => (a.name || '').toLowerCase().trim() === targetName);
      if (!acc && accounts.length === 1) acc = accounts[0];
      if (!acc && accounts.length > 0 && (!targetName || targetName === 'sotarium')) acc = accounts[0];
      let sessionToken = acc ? acc.token : (payload.token || process.env.ROLLBUX_SESSION_TOKEN);
      if (!sessionToken) {
        const availableNames = accounts.map(a => a.name).join(', ');
        res.status(400).json({
          success: false,
          error: `No session token for "${targetName}". Available accounts: [${availableNames}]. Check your Redis store.`
        });
        return;
      }

      const rollHeaders = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "Authorization": `Bearer ${sessionToken}`,
        "Cookie": `authjs.session-token=${sessionToken}`,
        "Origin": "https://rollbux.com",
        "Referer": "https://rollbux.com/games/upgrader"
      };

      // 2. Fetch live user balance from the dedicated RollBux balance endpoint
      let tokenBalanceMicro = 0;
      try {
        const balResp = await fetch("https://rollbux.com/_api/users/me/balance", { headers: rollHeaders });
        if (balResp.ok) {
          const balData = await balResp.json();
          if (balData?.data?.token_balance !== undefined) {
            tokenBalanceMicro = balData.data.token_balance;
          }
        }
      } catch (e) {
        console.error("[AutoUpgrader] Failed to fetch /users/me/balance:", e);
      }

      // Fallback 1: check profile endpoint
      if (!tokenBalanceMicro) {
        try {
          const meResp = await fetch("https://rollbux.com/_api/users/me", { headers: rollHeaders });
          if (meResp.ok) {
            const meData = await meResp.json();
            tokenBalanceMicro = meData?.data?.user?.token_balance || meData?.data?.token_balance || 0;
          }
        } catch (e) {}
      }

      // Fallback 2: check local cached store balance
      if (!tokenBalanceMicro) {
        const localUser = getUser(targetName);
        if (localUser && localUser.balance_bux) {
          tokenBalanceMicro = Math.floor(localUser.balance_bux * 1000000);
        }
      }

      const balanceBux = tokenBalanceMicro / 1000000;

      if (balanceBux < 50) {
        res.status(400).json({
          success: false,
          error: `Balance is ${balanceBux.toFixed(2)} BUX. Minimum required to play Upgrader is 50 BUX.`
        });
        return;
      }

      // Stake amount: All In or custom BUX amount
      const betAmountRaw = String(payload.betAmount || '').trim().toLowerCase();
      let stakeMicroTokens = Math.floor(tokenBalanceMicro);
      if (betAmountRaw && betAmountRaw !== 'all in' && betAmountRaw !== 'allin' && betAmountRaw !== 'all') {
        const customBux = parseFloat(betAmountRaw);
        if (!isNaN(customBux) && customBux >= 50) {
          stakeMicroTokens = Math.min(stakeMicroTokens, Math.floor(customBux * 1000000));
        }
      }

      if (stakeMicroTokens < 50000000) {
        res.status(400).json({
          success: false,
          error: `Stake amount is ${(stakeMicroTokens / 1000000).toFixed(2)} BUX. Minimum required is 50 BUX.`
        });
        return;
      }

      // 3. Fetch upgrader config to get rtpBP
      const configResp = await fetch("https://rollbux.com/_api/upgrader/config", { headers: rollHeaders });
      const configData = await configResp.json();
      const rtpBP = configData?.data?.rtpBP || 9000; // default 90% RTP (9000 BP)

      // 4. Fetch available target items starting at >= 1.1x stake
      const minRequiredItemPrice = Math.ceil(stakeMicroTokens * 1.10);
      const targetGoalMicroTokens = Math.max(minRequiredItemPrice, Math.floor(stakeMicroTokens * targetMultiplier));
      const targetsResp = await fetch(`https://rollbux.com/_api/upgrader/targets?minPriceMicroTokens=${minRequiredItemPrice}&sortField=price&sortOrder=asc&limit=100`, { headers: rollHeaders });
      const targetsData = await targetsResp.json();
      const items = targetsData?.data?.items || [];
      if (items.length === 0) {
        res.status(400).json({ success: false, error: "No eligible upgrade items found worth at least 1.1x your stake" });
        return;
      }

      // Filter to ensure every eligible item strictly satisfies the 1.1x rule:
      const eligibleItems = items.filter(it => it.priceMicroTokens >= minRequiredItemPrice);
      if (eligibleItems.length === 0) {
        res.status(400).json({ success: false, error: "No eligible upgrade items found worth at least 1.1x your stake" });
        return;
      }

      let bestItem = eligibleItems[0];
      let smallestDiff = Infinity;
      for (const it of eligibleItems) {
        const diff = Math.abs(it.priceMicroTokens - targetGoalMicroTokens);
        if (diff < smallestDiff) {
          smallestDiff = diff;
          bestItem = it;
        }
      }

      // 5. Calculate true provably fair chance matching RollBux client exactly:
      // Dn formula: chancePPM = (stakeBI * rtpBI * 1000000n) / (targetBI * 10000n)
      const stakeBI = BigInt(stakeMicroTokens);
      const targetBI = BigInt(bestItem.priceMicroTokens);
      const rtpBI = BigInt(rtpBP || 9000);
      const chancePPM_BI = (stakeBI * rtpBI * 1000000n) / (targetBI * 10000n);
      const chancePercent = Number(chancePPM_BI) / 10000;
      const chance = chancePercent / 100;

      // 6. Compute range [start, end] using RollBux's exact Wt / Ht / Ut formulas:
      const Vt = 1000000;
      function Ht(e) {
        let t = Number(e.toFixed(6));
        return t >= 1 ? 0.999999 : t;
      }
      function Ut(e) {
        return (e > 1000000 ? e % Vt : e) / Vt;
      }
      function Wt(c, t) {
        let n = Ht(c);
        return [n, Ut(Math.max(1, Math.round(n * Vt)) + Math.round(t * Vt) - 1)];
      }

      let startOffset = 0;
      if (Array.isArray(payload.range) && typeof payload.range[0] === 'number') {
        startOffset = Math.max(0, Math.min(0.999999, payload.range[0]));
      } else if (isRandomPosition) {
        startOffset = Math.random();
      }

      const calculatedRange = Wt(startOffset, chance);

      // 7. Execute upgrade play on RollBux
      const idempotencyKey = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `upg_${Date.now()}_${Math.random().toString(36).substring(2)}`;
      const playResp = await fetch("https://rollbux.com/_api/upgrader/play", {
        method: 'POST',
        headers: {
          ...rollHeaders,
          "Idempotency-Key": idempotencyKey
        },
        body: JSON.stringify({
          stakeValueMicroTokens: stakeMicroTokens,
          targetItemIds: [bestItem.itemId],
          range: calculatedRange,
          fast_mode: true
        })
      });

      const playText = await playResp.text();
      let playJson = null;
      try { playJson = JSON.parse(playText); } catch {}

      if (!playResp.ok) {
        let errMsg = "Upgrade play rejected";
        if (playJson?.error) {
          if (typeof playJson.error === 'string') {
            errMsg = playJson.error;
          } else if (playJson.error.message) {
            errMsg = playJson.error.message;
            if (playJson.error.details) {
              errMsg += ': ' + JSON.stringify(playJson.error.details);
            }
          } else {
            errMsg = JSON.stringify(playJson.error);
          }
        } else if (playJson?.message) {
          errMsg = playJson.message;
        } else if (playText) {
          errMsg = playText.slice(0, 200);
        }
        console.error(`[AutoUpgrader Error ${playResp.status}]:`, errMsg);
        res.status(playResp.status).json({
          success: false,
          error: errMsg
        });
        return;
      }

      const outcome = playJson?.data || {};
      const won = Boolean(outcome.won);
      let autoSold = false;
      let postBalanceBux = null;

      // Auto-sell won items back into liquid BUX balance if autoSell is enabled
      if (won && payload.autoSell !== false) {
        try {
          // Brief 300ms pause to ensure RollBux inventory record is committed
          await new Promise(r => setTimeout(r, 300));
          const sellResp = await fetch("https://rollbux.com/_api/users/me/inventory/sell", {
            method: 'POST',
            headers: rollHeaders,
            body: JSON.stringify({ sell_all: true })
          });

          if (sellResp.ok) {
            autoSold = true;
            // Fetch updated balance immediately
            const balResp2 = await fetch("https://rollbux.com/_api/users/me/balance", { headers: rollHeaders });
            if (balResp2.ok) {
              const bData = await balResp2.json();
              if (bData?.data?.token_balance !== undefined) {
                postBalanceBux = parseFloat((bData.data.token_balance / 1000000).toFixed(2));
                try {
                  handleAction({
                    action: 'balance_update',
                    username: targetName,
                    balance: postBalanceBux
                  });
                } catch (e) {}
              }
            }
          }
        } catch (sellErr) {
          console.error("[AutoUpgrader Auto-Sell Error]:", sellErr);
        }
      }

      res.status(200).json({
        success: true,
        account: acc ? acc.name : (targetName || 'Account'),
        won,
        autoSold,
        newBalanceBux: postBalanceBux,
        roll: outcome.roll,
        rollPrecision: outcome.rollPrecision || 1000000,
        range: calculatedRange,
        chancePercent: (chance * 100).toFixed(2),
        stakeBux: (stakeMicroTokens / 1000000).toFixed(2),
        targetItem: {
          id: bestItem.itemId,
          name: bestItem.name,
          imageUrl: bestItem.imageUrl,
          priceBux: (bestItem.priceMicroTokens / 1000000).toFixed(2)
        },
        outcome
      });
      return;
    } catch (e) {
      console.error("[AutoUpgrader Error]", e);
      res.status(500).json({ success: false, error: e.message });
      return;
    }
  }

  // Auto-Battle Creation Endpoint
  if (pathname === '/api/battles/create' && req.method === 'POST') {
    if (!isAllowedIp(req)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }

    try {
      const payload = req.body || await parseBody(req);
      const targetName = (payload.username || '').toLowerCase().trim();
      const borrowEnabled = payload.borrow !== false; // Default true as requested

      const url = process.env.UPSTASH_REDIS_REST_URL || "https://flowing-chigger-149490.upstash.io";
      const token = process.env.UPSTASH_REDIS_REST_TOKEN;
      if (!token) {
        res.status(500).json({ success: false, error: "Upstash token missing" });
        return;
      }

      // 1. Fetch account session token
      const accResp = await fetch(`${url}/get/roach%3Aaccounts`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const accData = await accResp.json();
      let accounts = accData.result ? JSON.parse(accData.result) : [];
      let acc = accounts.find(a => (a.name || '').toLowerCase().trim() === targetName);
      if (!acc && accounts.length === 1) acc = accounts[0];
      if (!acc && accounts.length > 0 && (!targetName || targetName === 'sotarium')) acc = accounts[0];
      let sessionToken = acc ? acc.token : (payload.token || process.env.ROLLBUX_SESSION_TOKEN);
      if (!sessionToken) {
        res.status(400).json({
          success: false,
          error: `No session token found for "${targetName}".`
        });
        return;
      }

      const rollHeaders = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "Authorization": `Bearer ${sessionToken}`,
        "Cookie": `authjs.session-token=${sessionToken}`,
        "Origin": "https://rollbux.com",
        "Referer": "https://rollbux.com/games/battles/create"
      };

      // 2. Fetch live user balance
      let tokenBalanceMicro = 0;
      try {
        const balResp = await fetch("https://rollbux.com/_api/users/me/balance", { headers: rollHeaders });
        if (balResp.ok) {
          const balData = await balResp.json();
          if (balData?.data?.token_balance !== undefined) {
            tokenBalanceMicro = balData.data.token_balance;
          }
        }
      } catch (e) {
        console.error("[AutoBattle] Failed to fetch /users/me/balance:", e);
      }

      if (!tokenBalanceMicro) {
        try {
          const meResp = await fetch("https://rollbux.com/_api/users/me", { headers: rollHeaders });
          if (meResp.ok) {
            const meData = await meResp.json();
            tokenBalanceMicro = meData?.data?.user?.token_balance || meData?.data?.token_balance || 0;
          }
        } catch (e) {}
      }

      const balanceBux = tokenBalanceMicro / 1000000;

      // 3. Fetch all cases across all pages in 0 - 5,000 BUX price range
      // RollBux micro-tokens: 5,000 BUX = 5,000,000,000 micro tokens
      let allCases = [];
      try {
        let page = 1;
        while (page <= 5) {
          const cResp = await fetch(`https://rollbux.com/_api/cases?page=${page}&limit=100`, { headers: rollHeaders });
          if (!cResp.ok) break;
          const cJson = await cResp.json();
          const items = cJson?.data?.items || [];
          allCases.push(...items);
          if (items.length < 100) break;
          page++;
        }
      } catch (e) {
        console.error("[AutoBattle] Error fetching all cases pages:", e.message);
      }

      if (allCases.length === 0) {
        res.status(500).json({ success: false, error: "Failed to fetch RollBux cases list" });
        return;
      }
      
      // Filter cases within 0 - 5,000 BUX (price <= 5,000,000,000)
      const maxPriceMicro = 5000 * 1000000;
      const under5kCases = allCases.filter(c => c.isActive !== false && c.price > 0 && c.price <= maxPriceMicro);

      // Filter out high volatility cases (> 0.55 volatility) to only pick low volatility/stable cases
      // If none under 0.55 fit, fall back to the lowest volatility available
      const lowVolCases = under5kCases.filter(c => (c.volatility !== undefined ? c.volatility <= 0.55 : true));
      const validCases = lowVolCases.length >= 5 ? lowVolCases : under5kCases;

      // Sort strictly from smallest price to highest price
      validCases.sort((a, b) => a.price - b.price);

      if (validCases.length === 0) {
        res.status(400).json({ success: false, error: "No available cases in 0 - 5,000 BUX range" });
        return;
      }

      // Check if user already has an active battle to avoid "You have too many active battles" error
      try {
        const checkActiveResp = await fetch("https://rollbux.com/_api/battles", { headers: rollHeaders });
        if (checkActiveResp.ok) {
          const checkData = await checkActiveResp.json();
          const activeList = (checkData.data?.battles || []).filter(b => 
            (b.creator_id === acc?.token || b.players?.some(p => (p.username || '').toLowerCase() === targetName)) &&
            (b.status === 'waiting' || b.status === 'in_progress')
          );
          if (activeList.length > 0) {
            res.status(400).json({
              success: false,
              error: `You already have ${activeList.length} active battle in progress. Waiting for it to complete.`
            });
            return;
          }
        }
      } catch (e) {}

      // 4. Select cases starting from lowest to higher until cost is as close to balance as possible
      // In RollBux Borrow Mode (80% borrow), the user only pays 20% of the battle cost (Cost * 0.20 <= Balance).
      // That means allowed battle prize pool capacity is Balance / 0.20 = Balance * 5!
      const userEffectiveBorrowCostMultiplier = borrowEnabled ? 0.20 : 1.0;
      const cheapestCase = validCases[0];
      const cheapestUserCostBux = (cheapestCase.price / 1000000) * userEffectiveBorrowCostMultiplier;

      if (balanceBux < cheapestUserCostBux) {
        res.status(400).json({
          success: false,
          error: `Balance is ${balanceBux.toFixed(2)} BUX. Cheapest case "${cheapestCase.name}" costs ${cheapestUserCostBux.toFixed(2)} BUX.`
        });
        return;
      }

      // Max total nominal battle cost that the user's balance can fund
      const maxBattleNominalCostMicro = Math.floor(tokenBalanceMicro / userEffectiveBorrowCostMultiplier);

      // Start by picking the lowest priced cases and go to the higher ones until the amount is too close to the balance to add another case
      const selectedCases = [];
      let currentCostMicro = 0;

      // First pass: add distinct cases starting from cheapest ascending
      for (const c of validCases) {
        if (currentCostMicro + c.price <= maxBattleNominalCostMicro && selectedCases.length < 30) {
          selectedCases.push(c);
          currentCostMicro += c.price;
        }
      }

      // Second pass: fill remaining budget from cheapest upwards
      for (const c of validCases) {
        while (currentCostMicro + c.price <= maxBattleNominalCostMicro && selectedCases.length < 30) {
          selectedCases.push(c);
          currentCostMicro += c.price;
        }
      }

      // Ensure cases are strictly arranged in ascending price order
      selectedCases.sort((a, b) => a.price - b.price);

      if (selectedCases.length === 0) {
        selectedCases.push(cheapestCase);
        currentCostMicro = cheapestCase.price;
      }

      const totalCostBux = currentCostMicro / 1000000;
      const actualPaidBux = totalCostBux * userEffectiveBorrowCostMultiplier;

      // 5. Construct battle payload matching RollBux format
      const caseIds = selectedCases.map(c => c.id);
      const isCrazy = payload.crazy_mode !== undefined ? Boolean(payload.crazy_mode) : (Math.random() < 0.5);

      const battleBody = {
        case_ids: caseIds,
        game_mode: "3v3",
        modifiers: {
          crazy_mode: isCrazy,
          jackpot: true
        },
        settings: {
          special_spin: true,
          fast_open: false,
          private_mode: false,
          borrow: borrowEnabled ? { percentage: 80 } : undefined
        }
      };

      // 6. Post battle to RollBux
      const createResp = await fetch("https://rollbux.com/_api/battles", {
        method: 'POST',
        headers: rollHeaders,
        body: JSON.stringify(battleBody)
      });

      const createText = await createResp.text();
      let createJson = null;
      try { createJson = JSON.parse(createText); } catch (e) {}

      if (!createResp.ok) {
        let errMsg = "Failed to create battle";
        if (createJson?.error) {
          if (typeof createJson.error === 'string') {
            errMsg = createJson.error;
          } else if (createJson.error.message) {
            errMsg = createJson.error.message;
            if (createJson.error.details) errMsg += ': ' + JSON.stringify(createJson.error.details);
          } else {
            errMsg = JSON.stringify(createJson.error);
          }
        } else if (createJson?.message) {
          errMsg = typeof createJson.message === 'string' ? createJson.message : JSON.stringify(createJson.message);
        } else if (createText) {
          errMsg = createText.slice(0, 200);
        }
        console.error(`[AutoBattle Error ${createResp.status}]:`, errMsg);
        res.status(createResp.status).json({ success: false, error: errMsg });
        return;
      }

      const battleResult = createJson?.data || createJson || {};
      const createdBattleId = battleResult.battle_id || battleResult.id;

      // Track created battle in Redis so /history only fetches and displays battles created by this site
      const redisUrlToUse = url || UPSTASH_URL;
      const redisTokenToUse = token || UPSTASH_TOKEN;
      if (createdBattleId && redisTokenToUse) {
        try {
          const recObj = {
            battle_id: createdBattleId,
            username: acc ? acc.name : (targetName || 'Account'),
            borrow: borrowEnabled,
            totalCostBux: totalCostBux.toFixed(2),
            actualPaidBux: actualPaidBux.toFixed(2),
            created_at: Date.now()
          };
          await fetch(`${redisUrlToUse}/pipeline`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${redisTokenToUse}`, 'Content-Type': 'application/json' },
            body: JSON.stringify([["LPUSH", "roach:created_battles", JSON.stringify(recObj)]])
          }).catch(() => {});
        } catch (e) {}
      }

      // 7. Auto-call bots to fill remaining slots (3v3 has slots 1 to 5)
      if (createdBattleId) {
        (async () => {
          for (let slot = 1; slot <= 5; slot++) {
            try {
              await new Promise(r => setTimeout(r, 400));
              await fetch(`https://rollbux.com/_api/battles/${createdBattleId}/bot`, {
                method: 'POST',
                headers: rollHeaders,
                body: JSON.stringify({ slot })
              });
            } catch (botErr) {
              // Ignore bot call error if slot fills or completes
            }
          }
        })().catch(() => {});
      }

      res.status(200).json({
        success: true,
        account: acc ? acc.name : (targetName || 'Account'),
        battle_id: createdBattleId,
        borrow: borrowEnabled,
        totalCostBux: totalCostBux.toFixed(2),
        actualPaidBux: actualPaidBux.toFixed(2),
        accountBalanceBux: balanceBux.toFixed(2),
        casesCount: selectedCases.length,
        cases: selectedCases.map(c => ({ id: c.id, name: c.name, priceBux: (c.price / 1000000).toFixed(2) })),
        result: battleResult
      });
      return;
    } catch (e) {
      console.error("[AutoBattle Error]", e);
      res.status(500).json({ success: false, error: e.message });
      return;
    }
  }

  // Battle History API endpoint
  if (pathname === '/api/battles/history' && req.method === 'GET') {
    if (!isAllowedIp(req)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }

    try {
      const targetName = (url.searchParams.get('username') || 'sotarium').toLowerCase().trim();
      const redisUrl = process.env.UPSTASH_REDIS_REST_URL || UPSTASH_URL;
      const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || UPSTASH_TOKEN;
      
      let sessionToken = process.env.ROLLBUX_SESSION_TOKEN;
      if (redisToken) {
        const accResp = await fetch(`${redisUrl}/get/roach%3Aaccounts`, { headers: { Authorization: `Bearer ${redisToken}` } });
        const accData = await accResp.json();
        const accounts = accData.result ? JSON.parse(accData.result) : [];
        const acc = accounts.find(a => (a.name || '').toLowerCase().trim() === targetName) || accounts[0];
        if (acc) sessionToken = acc.token;
      }

      const rollHeaders = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Authorization": `Bearer ${sessionToken}`,
        "Cookie": `authjs.session-token=${sessionToken}`
      };

      // Retrieve records of battles generated by this bot from Redis
      let siteBattlesList = [];
      if (redisToken) {
        try {
          const sResp = await fetch(`${redisUrl}/lrange/roach%3Acreated_battles/0/50`, { headers: { Authorization: `Bearer ${redisToken}` } });
          const sData = await sResp.json();
          if (Array.isArray(sData.result)) {
            sData.result.forEach(item => {
              try {
                const parsed = typeof item === 'string' ? JSON.parse(item) : item;
                if (parsed.battle_id) siteBattlesList.push(parsed);
              } catch (e) {
                if (typeof item === 'string') siteBattlesList.push({ battle_id: item });
              }
            });
          }
        } catch (e) {}
      }

      // Fetch live details for each site battle from RollBux API in parallel
      const userBattles = await Promise.all(siteBattlesList.map(async (sb) => {
        const battleId = sb.battle_id;
        let b = null;
        try {
          const bResp = await fetch(`https://rollbux.com/_api/battles/${battleId}`, { headers: rollHeaders });
          if (bResp.ok) {
            const bJson = await bResp.json();
            b = bJson?.data || bJson;
          }
        } catch (err) {}

        const creator = b?.players?.find(p => p.slot === 0);
        const creatorId = creator?.user_id;
        const fromAccount = sb.username || creator?.username || targetName || 'Account';

        // Check payouts for winner calculation
        const payoutMicro = (b?.payouts && creatorId) ? (b.payouts[creatorId] || 0) : 0;
        const wonPayoutBux = payoutMicro > 0 ? (payoutMicro / 1000000) : 0;
        const didWin = wonPayoutBux > 0 || (b?.winners || []).some(w => (w.username || '').toLowerCase() === fromAccount.toLowerCase());

        const isBorrow = sb.borrow !== undefined ? sb.borrow : Boolean(b?.borrow || b?.settings?.borrow);
        const nominalCostBux = b?.cost ? (b.cost / 1000000) : parseFloat(sb.totalCostBux || 0);
        const paidBux = sb.actualPaidBux ? parseFloat(sb.actualPaidBux) : (isBorrow ? nominalCostBux * 0.20 : nominalCostBux);

        return {
          battle_id: battleId,
          from_account: fromAccount,
          game_mode: b?.game_mode?.mode || '3v3',
          crazy_mode: Boolean(b?.modifiers?.crazy_mode || sb.crazy_mode),
          borrow: isBorrow,
          prize_pool_bux: nominalCostBux.toFixed(2),
          amount_paid_bux: paidBux.toFixed(2),
          amount_won_bux: didWin ? (wonPayoutBux > 0 ? wonPayoutBux.toFixed(2) : (nominalCostBux * (isBorrow ? 0.20 : 1.0)).toFixed(2)) : "0.00",
          won: didWin,
          status: b?.status || 'completed',
          created_at: sb.created_at || (b?.locked_at || Date.now()),
          url: `https://rollbux.com/games/battles/${battleId}`
        };
      }));

      res.status(200).json({
        success: true,
        battles: userBattles
      });
      return;
    } catch (e) {
      console.error("[Battles History Error]", e);
      res.status(500).json({ success: false, error: e.message });
      return;
    }
  }

  // Standalone Inventory Sell All Endpoint
  if (pathname === '/api/inventory/sell' && req.method === 'POST') {
    try {
      const payload = req.body || await parseBody(req);
      const targetName = (payload.username || '').toLowerCase().trim();
      const url = process.env.UPSTASH_REDIS_REST_URL || "https://flowing-chigger-149490.upstash.io";
      const token = process.env.UPSTASH_REDIS_REST_TOKEN;
      const accResp = await fetch(`${url}/get/roach%3Aaccounts`, { headers: { Authorization: `Bearer ${token}` } });
      const accData = await accResp.json();
      let accounts = accData.result ? JSON.parse(accData.result) : [];
      let acc = accounts.find(a => (a.name || '').toLowerCase().trim() === targetName);
      if (!acc && accounts.length === 1) acc = accounts[0];
      if (!acc && accounts.length > 0 && (!targetName || targetName === 'sotarium')) acc = accounts[0];
      let sessionToken = acc ? acc.token : process.env.ROLLBUX_SESSION_TOKEN;
      if (!sessionToken) {
        res.status(400).json({ success: false, error: "No session token found" });
        return;
      }
      const rollHeaders = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "Authorization": `Bearer ${sessionToken}`,
        "Cookie": `authjs.session-token=${sessionToken}`,
        "Origin": "https://rollbux.com",
        "Referer": "https://rollbux.com/"
      };
      const sellResp = await fetch("https://rollbux.com/_api/users/me/inventory/sell", {
        method: 'POST',
        headers: rollHeaders,
        body: JSON.stringify({ sell_all: true })
      });
      const sellJson = await sellResp.json().catch(() => ({}));
      res.status(sellResp.status).json({ success: sellResp.ok, data: sellJson });
      return;
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
      return;
    }
  }

  if (pathname === '/roach/sandbox') {
    if (!isAllowedIp(req)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }
    if (!sendPage(res, 'sandbox.html')) res.status(404).send('Sandbox not found');
    return;
  }

  if (pathname === '/roach') {
    if (!isAllowedIp(req)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }
    try {
      const candidates = [
        path.resolve(process.cwd(), 'server', 'roach.html'),
        path.resolve(process.cwd(), 'roach.html')
      ];
      let html = null;
      for (const p of candidates) {
        if (fs.existsSync(p)) {
          html = fs.readFileSync(p, 'utf-8');
          break;
        }
      }
      if (!html) {
        res.statusCode = 404;
        res.end('Roach portal not found');
        return;
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.statusCode = 200;
      res.end(html);
      return;
    } catch (err) {
      res.statusCode = 500;
      res.end('Internal Server Error');
      return;
    }
  }

  if (pathname === '/api/status' && req.method === 'POST') {
    const payload = req.body || await parseBody(req);
    const result = handleAction(payload);
    res.status(200).json(result);
    return;
  }

  if (pathname.startsWith('/api/user/') && pathname.endsWith('/clear') && req.method === 'POST') {
    if (!isAllowedIp(req)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }
    const username = decodeURIComponent(pathname.replace('/api/user/', '').replace('/clear', '')).trim();
    const user = clearUserStats(username);

    // Save cleared state to Upstash so ephemeral serverless containers never forget the clear
    try {
      const upstashUrl = process.env.UPSTASH_REDIS_REST_URL || "https://flowing-chigger-149490.upstash.io";
      const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
      if (upstashToken) {
        const clearKey = `roach:cleared:${username.toLowerCase().trim()}`;
        await fetch(upstashUrl, {
          method: 'POST',
          headers: { Authorization: `Bearer ${upstashToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(["SET", clearKey, String(Date.now())])
        });
      }
    } catch (e) {}

    res.status(200).json({ ok: true, user });
    return;
  }

  if (pathname.startsWith('/api/user/')) {
    if (!isAllowedIp(req)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }
    const username = decodeURIComponent(pathname.replace('/api/user/', '')).trim();
    const session = currentSession(req);
    const ownsRequestedUser = session && String(session.username || session.email || '').trim().toLowerCase() === username.toLowerCase();
    const user = ownsRequestedUser
      ? getUserForAuth({ id: session.sub, username: session.username, email: session.email, createdAt: session.createdAt })
      : getUser(username);
    const effectiveUser = user || {
      username,
      balance_bux: 0,
      total_earnings_bux: 0,
      rains_joined: 0,
      transactions: [],
      history: []
    };

    // Cloud Roach Auto-Sync: Fetch live RollBux data directly using saved account token
    try {
      const upstashUrl = process.env.UPSTASH_REDIS_REST_URL || "https://flowing-chigger-149490.upstash.io";
      const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
      let sessionToken = process.env.ROLLBUX_SESSION_TOKEN;

      let allAccountsToSync = [];
      let hasRegisteredAccounts = false;
      if (upstashToken) {
        // Sync cleared_at timestamp from Upstash if serverless instance lost it
        try {
          const clearCheck = await fetch(`${upstashUrl}/get/roach%3Acleared%3A${encodeURIComponent(username.toLowerCase())}`, {
            headers: { Authorization: `Bearer ${upstashToken}` }
          });
          const clearData = await clearCheck.json();
          if (clearData.result) {
            const savedClear = parseInt(clearData.result, 10);
            if (savedClear > (user.cleared_at || 0)) {
              user.cleared_at = savedClear;
              user.transactions = (user.transactions || []).filter(t => (t.timestamp || 0) > savedClear);
              let total = 0;
              user.transactions.forEach(t => total += (t.amount_bux || 0));
              user.total_earnings_bux = total;
              user.rains_joined = user.transactions.length;
            }
          }
        } catch (e) {}

        allAccountsToSync = await getSupabaseAccounts();
        if (!allAccountsToSync || allAccountsToSync.length === 0) {
          try {
            const accResp = await fetch(`${upstashUrl}/get/roach%3Aaccounts`, {
              headers: { Authorization: `Bearer ${upstashToken}` }
            });
            const accData = await accResp.json();
            allAccountsToSync = accData.result ? JSON.parse(accData.result) : [];
          } catch (e) {}
        }
        hasRegisteredAccounts = allAccountsToSync.length > 0;
        // A user's dashboard must only sync rains belonging to that account.
        // The Redis list is shared for the farmer, so never merge every account
        // into the current user's rain history.
        if (allAccountsToSync.length > 0) {
          allAccountsToSync = allAccountsToSync.filter((account) =>
            String(account.name || '').trim().toLowerCase() === username.toLowerCase()
          );
        }
        const requestSession = currentSession(req);
        if (requestSession && String(requestSession.username || requestSession.email || '').trim().toLowerCase() === username.toLowerCase()) {
          const personalResp = await fetch(`${upstashUrl}/get/${encodeURIComponent(`roach:accounts:user:${requestSession.sub}`)}`, {
            headers: { Authorization: `Bearer ${upstashToken}` }
          });
          const personalData = await personalResp.json();
          const personalAccounts = personalData.result ? JSON.parse(personalData.result) : [];
          if (personalAccounts.length > 0) {
            allAccountsToSync = personalAccounts;
            hasRegisteredAccounts = true;
          }
        }
      }

      // If no accounts found in Redis, fall back to ENV token for the requested username
      if (!hasRegisteredAccounts && allAccountsToSync.length === 0 && process.env.ROLLBUX_SESSION_TOKEN) {
        allAccountsToSync = [{ name: username, token: process.env.ROLLBUX_SESSION_TOKEN }];
      }

      // 1. Live Rain Cycle & Countdown (Fetch once publicly)
      try {
        const rainResp = await fetch("https://rollbux.com/_api/rain/current");
        if (rainResp.ok) {
          const rainData = await rainResp.json();
          const rainState = rainData?.data || {};
          const legacyCycle = rainState.cycle || {};
          const cycleId = rainState.cycle_id || legacyCycle.id;
          const cycleEnd = rainState.cycle_end ?? legacyCycle.cycle_end ?? null;
          const livePool = rainState.live_pot ?? rainState.live_pool ?? 0;
          if (cycleId) {
            const cycleEndMs = cycleEnd ? new Date(cycleEnd).getTime() : NaN;
            const secondsLeft = Number.isFinite(cycleEndMs)
              ? Math.max(0, Math.floor((cycleEndMs - Date.now()) / 1000))
              : 0;
            const potBux = parseFloat((livePool / 1000000).toFixed(2));
            handleAction({
              action: 'rain_tick',
              username,
              cycle_id: cycleId,
              time_left: secondsLeft,
              pot_amount: potBux
            });
          }
        }
      } catch (e) {}

      // 2. Fetch balance and transactions for this account only
      const clearedAt = user.cleared_at || 0;
      const allRainTxs = [];

      await Promise.all(allAccountsToSync.map(async (acc) => {
        const accName = acc.name || 'Account';
        const sessionToken = acc.token;
        if (!sessionToken) return;

        const rollHeaders = {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "application/json, text/plain, */*",
          "Authorization": `Bearer ${sessionToken}`,
          "Cookie": `authjs.session-token=${sessionToken}`
        };

        const [balRes, meRes, txRes] = await Promise.all([
          fetch("https://rollbux.com/_api/users/me/balance", { headers: rollHeaders }).then(r => r.ok ? r.json() : null).catch(() => null),
          fetch("https://rollbux.com/_api/users/me", { headers: rollHeaders }).then(r => r.ok ? r.json() : null).catch(() => null),
          fetch("https://rollbux.com/_api/users/me/transactions", { headers: rollHeaders }).then(r => r.ok ? r.json() : null).catch(() => null)
        ]);

        if (balRes?.data?.token_balance !== undefined) {
          const liveBalBux = parseFloat((balRes.data.token_balance / 1000000).toFixed(2));
          handleAction({
            action: 'balance_update',
            username: accName,
            balance: liveBalBux
          });
          if (accName.toLowerCase() === username.toLowerCase()) {
            handleAction({
              action: 'balance_update',
              username,
              balance: liveBalBux
            });
          }
        }

        if (meRes?.data?.user?.avatar_url) {
          handleAction({
            action: 'rain_tick',
            username: accName,
            avatar: meRes.data.user.avatar_url
          });
        }

        if (txRes?.data?.items) {
          const items = txRes.data.items;
          const rainTxs = items
            .filter(t => {
              if (t.type !== 'RAIN_REWARD') return false;
              const txTime = typeof t.date === 'number' ? t.date : new Date(t.date || Date.now()).getTime();
              return txTime > clearedAt;
            })
            .map(t => ({
              account: accName,
              amount_bux: parseFloat(((t.amount || 0) / 1000000).toFixed(2)),
              time: new Date(t.date || Date.now()).toLocaleString('fr-FR', {
                day: 'numeric',
                month: 'short',
                hour: '2-digit',
                minute: '2-digit'
              }).replace(':', 'h'),
              cycle_id: t.id ? `${accName}_${t.id}` : `${accName}_${t.date}_${t.amount}`,
              timestamp: typeof t.date === 'number' ? t.date : new Date(t.date || Date.now()).getTime()
            }));

          allRainTxs.push(...rainTxs);
        }
      }));

      if (allRainTxs.length > 0) {
        handleAction({
          action: 'sync_transactions',
          username,
          sync_all_history: true,
          transactions: allRainTxs
        });
      }
    } catch (e) {
      console.error("Live cloud sync error:", e.message);
    }

    const updatedUser = getUser(username) || effectiveUser;
    const solPrice = getSolPrice();
    res.status(200).json({
      user: updatedUser,
      solPrice,
      solBalance: buxToSol(updatedUser.balance_bux),
      usdBalance: buxToUsd(updatedUser.balance_bux),
      solEarnings: buxToSol(updatedUser.total_earnings_bux),
      usdEarnings: buxToUsd(updatedUser.total_earnings_bux)
    });
    return;
  }

  const matchedPath = req.headers['x-matched-path'] || req.headers['x-vercel-matched-path'] || pathname;
  const isUsersPage = matchedPath === '/users' || matchedPath === '/users.html' || pathname === '/users' || pathname === '/users.html' || pathname === '/api/users-page' || url.searchParams.get('view') === 'users';
  const dashboardMatch = pathname.match(/^\/dashboard\/([^/]+)\/?$/);
  const isUserDashboardPage = matchedPath === '/dashboard/user' || pathname === '/dashboard/user' || Boolean(dashboardMatch) || matchedPath.startsWith('/user/') || pathname.startsWith('/user/');

  // /dashboard/* → redirect to homepage (SPA handles auth)
  if (isUserDashboardPage) {
    res.setHeader('Location', '/');
    res.statusCode = 302;
    res.end();
    return;
  }

  const personalAccountsMatch = pathname.match(/^\/users\/([^/]+)\/accounts\/?$/);
  const isPersonalAccountsPage = Boolean(personalAccountsMatch);
  const isAccountsPage = isPersonalAccountsPage || matchedPath === '/accounts' || matchedPath === '/accounts.html' || pathname === '/accounts' || pathname === '/accounts.html';

  // Serve the personal Accounts HTML page; its data endpoint enforces the session.
  if (isAccountsPage) {
    const session = currentSession(req);
    // Allow access to accounts page for authenticated users or direct view
    if (!session && isPersonalAccountsPage) {
      res.statusCode = 401;
      res.end('Authentication required');
      return;
    }
    try {
      const candidates = [
        path.resolve(process.cwd(), 'server', 'accounts.html'),
        path.resolve(process.cwd(), 'accounts.html'),
        path.resolve(process.cwd(), 'dist', 'accounts.html')
      ];
      let html = null;
      for (const p of candidates) {
        if (fs.existsSync(p)) {
          html = fs.readFileSync(p, 'utf-8');
          break;
        }
      }
      if (!html) {
        res.statusCode = 404;
        res.end('Accounts page not found');
        return;
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.statusCode = 200;
      res.end(html);
      return;
    } catch (err) {
      res.statusCode = 500;
      res.end('Internal Server Error');
      return;
    }
  }


  const isHistoryPage = pathname === '/history' || pathname === '/history.html' || matchedPath === '/history' || matchedPath === '/history.html' || url.pathname === '/history' || url.pathname === '/history.html';

  // Serve the History HTML page (/history)
  if (isHistoryPage) {
    if (!isAllowedIp(req)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }
    try {
      const candidates = [
        path.resolve(process.cwd(), 'server', 'history.html'),
        path.resolve(process.cwd(), 'history.html'),
        path.resolve(process.cwd(), 'dist', 'history.html')
      ];
      let html = null;
      for (const p of candidates) {
        try {
          if (fs.existsSync(p)) {
            html = fs.readFileSync(p, 'utf-8');
            break;
          }
        } catch (e) {}
      }
      if (!html) {
        // Fallback: try loading from server/history.html relative to file
        try {
          const fallbackPath = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '..', 'server', 'history.html');
          if (fs.existsSync(fallbackPath)) {
            html = fs.readFileSync(fallbackPath, 'utf-8');
          }
        } catch (e) {}
      }
      if (!html) {
        res.statusCode = 404;
        res.end('History page not found');
        return;
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.statusCode = 200;
      res.end(html);
      return;
    } catch (err) {
      res.statusCode = 500;
      res.end('Internal Server Error');
      return;
    }
  }

  // Protect the Active Users List HTML page (/users)
  if (isUsersPage) {
    if (!isAllowedIp(req)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }
    try {
      const candidates = [
        path.resolve(process.cwd(), 'server', 'users.html'),
        path.resolve(process.cwd(), 'users.html'),
        path.resolve(process.cwd(), 'dist', 'users.html')
      ];
      let html = null;
      for (const p of candidates) {
        if (fs.existsSync(p)) {
          html = fs.readFileSync(p, 'utf-8');
          break;
        }
      }
      if (!html) {
        res.statusCode = 404;
        res.end('Users page not found');
        return;
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.statusCode = 200;
      res.end(html);
      return;
    } catch (err) {
      res.statusCode = 500;
      res.end('Internal Server Error');
      return;
    }
  }

  // Protect the Users List JSON endpoint (/api/users)
  if (pathname === '/api/users') {
    if (!isAllowedIp(req)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }

    const users = getAllUsers();
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = 200;
    res.end(JSON.stringify({ users, solPrice: getSolPrice() }));
    return;
  }

  // ── Mines API Helpers ──────────────────────────────────────────────────────
  async function getMinesSessionToken(targetName) {
    const url = process.env.UPSTASH_REDIS_REST_URL || "https://flowing-chigger-149490.upstash.io";
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!token) throw new Error("Upstash token missing");
    const accResp = await fetch(`${url}/get/roach%3Aaccounts`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const accData = await accResp.json();
    let accounts = accData.result ? JSON.parse(accData.result) : [];
    let acc = accounts.find(a => (a.name || '').toLowerCase().trim() === (targetName || '').toLowerCase().trim());
    if (!acc && accounts.length > 0) acc = accounts[0];
    const sessionToken = acc ? acc.token : null;
    if (!sessionToken) throw new Error(`No session token for "${targetName}"`);
    return sessionToken;
  }

  function minesHeaders(sessionToken) {
    return {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
      "Accept": "application/json, text/plain, */*",
      "Content-Type": "application/json",
      "Authorization": `Bearer ${sessionToken}`,
      "Cookie": `authjs.session-token=${sessionToken}`,
      "Origin": "https://rollbux.com",
      "Referer": "https://rollbux.com/games/mines"
    };
  }

  // POST /api/mines/start
  if (pathname === '/api/mines/start' && req.method === 'POST') {
    if (!isAllowedIp(req)) { res.statusCode = 403; res.end('Forbidden'); return; }
    try {
      const payload = req.body || await parseBody(req);
      const targetName = (payload.username || '').toLowerCase().trim();
      const sessionToken = await getMinesSessionToken(targetName);

      // Verify live balance directly with RollBux using this account's sessionToken
      let betMicro = payload.amount_micro_tokens;
      try {
        const balRes = await fetch("https://rollbux.com/_api/users/me/balance", { headers: minesHeaders(sessionToken) });
        if (balRes.ok) {
          const balData = await balRes.json();
          const liveTokens = balData?.data?.token_balance;
          if (typeof liveTokens === 'number') {
            console.log(`[API Mines Start] ${targetName} live balance on RollBux: ${liveTokens} micro tokens (${liveTokens / 1000000} BUX), requested: ${betMicro}`);
            // If requested bet exceeds live tokens or is all-in, clamp to actual live balance
            betMicro = Math.min(betMicro, liveTokens);
          }
        }
      } catch (balErr) {
        console.warn('[API Mines Start] Live balance check warning:', balErr.message);
      }

      if (!betMicro || betMicro < 50_000_000) {
        res.statusCode = 400;
        res.end(JSON.stringify({ success: false, status: 400, error: `Balance too low (${((betMicro || 0) / 1000000).toFixed(2)} BUX, min 50 BUX)` }));
        return;
      }

      const idKey = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
      const rbRes = await fetch('https://rollbux.com/_api/games/mines/start', {
        method: 'POST',
        headers: { ...minesHeaders(sessionToken), 'Idempotency-Key': idKey },
        body: JSON.stringify({
          amount_micro_tokens: betMicro,
          number_of_mines: payload.number_of_mines || 1
        })
      });
      const rbData = await rbRes.json().catch(() => ({}));
      if (!rbRes.ok) {
        console.error('[API Mines Start Failed]', rbRes.status, rbData);
        res.statusCode = rbRes.status || 400;
        const errMessage = rbData?.message || (typeof rbData?.error === 'string' ? rbData.error : (rbData?.error?.message || JSON.stringify(rbData?.error || 'Start failed')));
        res.end(JSON.stringify({ success: false, status: rbRes.status, error: errMessage, details: rbData }));
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.statusCode = 200;
      res.end(JSON.stringify({ success: true, bet_bux: (betMicro / 1000000).toFixed(2), data: rbData }));
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // POST /api/mines/reveal
  if (pathname === '/api/mines/reveal' && req.method === 'POST') {
    if (!isAllowedIp(req)) { res.statusCode = 403; res.end('Forbidden'); return; }
    try {
      const payload = req.body || await parseBody(req);
      const targetName = (payload.username || '').toLowerCase().trim();
      const sessionToken = await getMinesSessionToken(targetName);
      const idKey = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
      const rbRes = await fetch('https://rollbux.com/_api/games/mines/reveal', {
        method: 'POST',
        headers: { ...minesHeaders(sessionToken), 'Idempotency-Key': idKey },
        body: JSON.stringify({ tile_index: payload.tile_index })
      });
      const rbData = await rbRes.json().catch(() => ({}));
      const exploded = rbData?.data?.exploded === true || rbData?.exploded === true || rbData?.data?.mine === true;
      if (!rbRes.ok) {
        console.error('[API Mines Reveal Failed]', rbRes.status, rbData);
        res.statusCode = rbRes.status || 400;
        res.end(JSON.stringify({ success: false, exploded, error: rbData?.message || rbData?.error || 'Reveal failed', details: rbData }));
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.statusCode = 200;
      res.end(JSON.stringify({ success: !exploded, exploded, data: rbData }));
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // POST /api/mines/cashout
  if (pathname === '/api/mines/cashout' && req.method === 'POST') {
    if (!isAllowedIp(req)) { res.statusCode = 403; res.end('Forbidden'); return; }
    try {
      const payload = req.body || await parseBody(req);
      const targetName = (payload.username || '').toLowerCase().trim();
      const sessionToken = await getMinesSessionToken(targetName);
      const idKey = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
      const hdrs = minesHeaders(sessionToken);
      delete hdrs['Content-Type']; // some APIs reject cashout if Content-Type is set with empty body
      const rbRes = await fetch('https://rollbux.com/_api/games/mines/cashout', {
        method: 'POST',
        headers: { ...hdrs, 'Idempotency-Key': idKey }
        // intentionally no body — Rollbux cashout takes no request body
      });
      const rbText = await rbRes.text();
      let rbData = {};
      try { rbData = JSON.parse(rbText); } catch {}
      console.log('[API Mines Cashout]', rbRes.status, rbText.slice(0, 500));
      if (!rbRes.ok) {
        console.error('[API Mines Cashout Failed]', rbRes.status, rbData);
        res.statusCode = rbRes.status || 400;
        const errMessage = rbData?.message || (typeof rbData?.error === 'string' ? rbData.error : (rbData?.error?.message || rbText.slice(0, 200) || 'Cashout failed'));
        res.end(JSON.stringify({ success: false, status: rbRes.status, error: errMessage, details: rbData }));
        return;
      }
      // Extract payout in BUX
      const payoutMicro = rbData?.data?.payout ?? rbData?.data?.amount ?? rbData?.data?.payout_amount ?? rbData?.data?.token_amount ?? rbData?.payout ?? rbData?.amount ?? 0;
      const payoutBux = (payoutMicro / 1_000_000).toFixed(2);
      console.log('[API Mines Cashout Success]', { payoutMicro, payoutBux, rbData });
      res.setHeader('Content-Type', 'application/json');
      res.statusCode = 200;
      res.end(JSON.stringify({ success: true, payout_bux: payoutBux, payout_micro: payoutMicro, data: rbData }));
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

// ==========================================
  // CHICKEN ENGINE ROUTES
  // ==========================================
  function chickenHeaders(token) {
    return {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "application/json, text/plain, */*",
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
      "Cookie": `authjs.session-token=${token}`,
      "Referer": "https://rollbux.com/games/chicken"
    };
  }

  // POST /api/chicken/start
  if (pathname === '/api/chicken/start' && req.method === 'POST') {
    if (!isAllowedIp(req)) { res.statusCode = 403; res.end('Forbidden'); return; }
    try {
      const payload = req.body || await parseBody(req);
      const targetName = (payload.username || '').toLowerCase().trim();
      const sessionToken = await getMinesSessionToken(targetName);
      if (!sessionToken) {
        res.statusCode = 400;
        res.end(JSON.stringify({ success: false, error: 'No token found for account ' + targetName }));
        return;
      }

      let betMicro = payload.amount_micro_tokens;
      try {
        const balRes = await fetch("https://rollbux.com/_api/users/me/balance", { headers: chickenHeaders(sessionToken) });
        if (balRes.ok) {
          const balData = await balRes.json();
          const liveTokens = balData?.data?.token_balance;
          if (typeof liveTokens === 'number') {
            betMicro = liveTokens;
          }
        }
      } catch (e) {}

      if (!betMicro || betMicro < 50_000_000) {
        res.statusCode = 400;
        res.end(JSON.stringify({ success: false, error: 'Insufficient balance (min 50 BUX)' }));
        return;
      }

      const idKey = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
      const rbRes = await fetch('https://rollbux.com/_api/games/chicken/start', {
        method: 'POST',
        headers: { ...chickenHeaders(sessionToken), 'Idempotency-Key': idKey },
        body: JSON.stringify({
          amount_micro_tokens: betMicro,
          difficulty: Number(payload.difficulty) || 1
        })
      });
      const rbData = await rbRes.json().catch(() => ({}));
      if (!rbRes.ok) {
        res.statusCode = rbRes.status || 400;
        const errMessage = rbData?.message || rbData?.error || 'Start failed';
        res.end(JSON.stringify({ success: false, error: errMessage, details: rbData }));
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.statusCode = 200;
      res.end(JSON.stringify({ success: true, bet_bux: (betMicro / 1000000).toFixed(2), data: rbData }));
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // POST /api/chicken/next
  if (pathname === '/api/chicken/next' && req.method === 'POST') {
    if (!isAllowedIp(req)) { res.statusCode = 403; res.end('Forbidden'); return; }
    try {
      const payload = req.body || await parseBody(req);
      const targetName = (payload.username || '').toLowerCase().trim();
      const sessionToken = await getMinesSessionToken(targetName);
      const idKey = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);

      const rbRes = await fetch('https://rollbux.com/_api/games/chicken/next', {
        method: 'POST',
        headers: { ...chickenHeaders(sessionToken), 'Idempotency-Key': idKey }
      });
      const rbData = await rbRes.json().catch(() => ({}));
      // Check if dead / car hit
      const hit = rbData?.status === 'completed' && rbData?.current_payout?.multiplier === 0;
      if (!rbRes.ok) {
        res.statusCode = rbRes.status || 400;
        res.end(JSON.stringify({ success: false, hit: true, error: rbData?.message || rbData?.error || 'Step failed', details: rbData }));
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.statusCode = 200;
      res.end(JSON.stringify({ success: !hit, hit, data: rbData }));
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // POST /api/chicken/cashout
  if (pathname === '/api/chicken/cashout' && req.method === 'POST') {
    if (!isAllowedIp(req)) { res.statusCode = 403; res.end('Forbidden'); return; }
    try {
      const payload = req.body || await parseBody(req);
      const targetName = (payload.username || '').toLowerCase().trim();
      const sessionToken = await getMinesSessionToken(targetName);
      const idKey = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
      const hdrs = chickenHeaders(sessionToken);
      delete hdrs['Content-Type'];

      const rbRes = await fetch('https://rollbux.com/_api/games/chicken/cashout', {
        method: 'POST',
        headers: { ...hdrs, 'Idempotency-Key': idKey }
      });
      const rbData = await rbRes.json().catch(() => ({}));
      if (!rbRes.ok) {
        res.statusCode = rbRes.status || 400;
        res.end(JSON.stringify({ success: false, error: rbData?.message || rbData?.error || 'Cashout failed', details: rbData }));
        return;
      }
      const payoutMicro = rbData?.data?.payout ?? rbData?.current_payout?.value ?? rbData?.payout ?? 0;
      const payoutBux = (payoutMicro / 1_000_000).toFixed(2);
      res.setHeader('Content-Type', 'application/json');
      res.statusCode = 200;
      res.end(JSON.stringify({ success: true, payout_bux: payoutBux, data: rbData }));
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'Not found' }));
}

