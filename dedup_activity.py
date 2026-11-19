import re

def remove_activity_dupes(filepath):
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    # 1. Update playWatcherBeep to throttle sound alerts so it never beeps twice within 1.5s
    old_beep = """window.playWatcherBeep = function() {
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        const ctx = new AudioCtx();"""

    new_beep = """window.lastWatcherBeepTimestamp = 0;
    window.playWatcherBeep = function() {
      try {
        const now = Date.now();
        if (now - (window.lastWatcherBeepTimestamp || 0) < 1500) return; // Prevent duplicate beep sounds
        window.lastWatcherBeepTimestamp = now;
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        const ctx = new AudioCtx();"""

    if old_beep in content:
        content = content.replace(old_beep, new_beep)
        print(f'Added sound beep throttling to {filepath}')
    else:
        print(f'Warning: old_beep not found in {filepath}')

    # 2. Update logDiscordActivity with deduplication:
    # Check if an identical notification was logged within the last 60 seconds (or has the same messageId)
    old_log_body = """      const event = {
        ts: Date.now(), text: rawText, tag: rawTag,
        color, accountId: account?.id ? String(account.id) : '',
        accountName: account?.user?.username || account?.user?.handle || '',
        channelId: channelId ? String(channelId) : '',
        serverId: serverId ? String(serverId) : '',
        messageId: messageId ? String(messageId) : '',
        watcherName: watcherName ? String(watcherName) : '',
        watcherType: watcherType ? String(watcherType) : '',
        guess: (guess !== null && guess !== undefined) ? String(guess) : '',
        secretNum: (secretNum !== null && secretNum !== undefined) ? String(secretNum) : ''
      };
      if (persist !== false) {
        let events = [];
        try { events = JSON.parse(localStorage.getItem(DISCORD_ACTIVITY_KEY) || '[]'); } catch (e) {}
        if (!Array.isArray(events)) events = [];
        localStorage.setItem(DISCORD_ACTIVITY_KEY, JSON.stringify([event, ...events].slice(0, 200)));
      }"""

    new_log_body = """      const nowTs = Date.now();
      const accountIdStr = account?.id ? String(account.id) : '';
      const messageIdStr = messageId ? String(messageId) : '';
      const channelIdStr = channelId ? String(channelId) : '';

      // Memory deduplication check (prevent duplicate notifications logged within 60 seconds)
      if (!window._recentDiscordActivityFingerprints) {
        window._recentDiscordActivityFingerprints = new Map();
      }
      const fp = `${rawTag}:${rawText}:${channelIdStr}:${messageIdStr || (secretNum ? 's' + secretNum : '')}`;
      const lastLoggedAt = window._recentDiscordActivityFingerprints.get(fp) || 0;
      if (nowTs - lastLoggedAt < 60000) {
        return; // Deduplicate: already logged this notification in the last 60 seconds
      }
      window._recentDiscordActivityFingerprints.set(fp, nowTs);

      // Clean up map over time
      if (window._recentDiscordActivityFingerprints.size > 200) {
        for (const [k, t] of window._recentDiscordActivityFingerprints.entries()) {
          if (nowTs - t > 120000) window._recentDiscordActivityFingerprints.delete(k);
        }
      }

      const event = {
        ts: nowTs, text: rawText, tag: rawTag,
        color, accountId: accountIdStr,
        accountName: account?.user?.username || account?.user?.handle || '',
        channelId: channelIdStr,
        serverId: serverId ? String(serverId) : '',
        messageId: messageIdStr,
        watcherName: watcherName ? String(watcherName) : '',
        watcherType: watcherType ? String(watcherType) : '',
        guess: (guess !== null && guess !== undefined) ? String(guess) : '',
        secretNum: (secretNum !== null && secretNum !== undefined) ? String(secretNum) : ''
      };
      if (persist !== false) {
        let events = [];
        try { events = JSON.parse(localStorage.getItem(DISCORD_ACTIVITY_KEY) || '[]'); } catch (e) {}
        if (!Array.isArray(events)) events = [];

        // Deduplicate against existing stored events (ignore if identical notification exists within 60s)
        const isDupe = events.some(e => {
          if (!e) return false;
          const sameText = String(e.text || '') === rawText;
          const sameTag = String(e.tag || '') === rawTag;
          const sameMsg = messageIdStr && String(e.messageId || '') === messageIdStr;
          const timeDiff = Math.abs(nowTs - (e.ts || 0));
          return (sameText && sameTag && timeDiff < 60000) || (sameMsg && sameTag);
        });

        if (!isDupe) {
          localStorage.setItem(DISCORD_ACTIVITY_KEY, JSON.stringify([event, ...events].slice(0, 200)));
        }
      }"""

    if old_log_body in content:
        content = content.replace(old_log_body, new_log_body)
        print(f'Added deduplication logic to logDiscordActivity in {filepath}')
    else:
        print(f'Warning: old_log_body not found in {filepath}')

    # 3. Clean up any existing duplicate entries when rendering activity list
    old_render_filter = """          // Permanently strip out diagnostic noise
          events = parsed.filter(event => {
            const rawText = String(event?.text || event?.message || '');
            const rawTag = String(event?.tag || '');
            const lower = (rawText + ' ' + rawTag).toLowerCase();
            return rawTag !== 'Diagnostic' &&
              !lower.includes('no watcher matched') &&
              !lower.includes('ids did not match') &&
              !lower.includes('component received') &&
              !lower.includes('diagnostic');
          });"""

    new_render_filter = """          // Permanently strip out diagnostic noise and deduplicate identical consecutive notifications
          const seenFPs = new Set();
          events = [];
          for (const ev of parsed) {
            if (!ev) continue;
            const rText = String(ev.text || ev.message || '');
            const rTag = String(ev.tag || '');
            const lower = (rText + ' ' + rTag).toLowerCase();
            if (
              rTag === 'Diagnostic' ||
              lower.includes('no watcher matched') ||
              lower.includes('ids did not match') ||
              lower.includes('component received') ||
              lower.includes('diagnostic')
            ) {
              continue;
            }
            // Unique key for deduplication (same text, same tag, within 90s window)
            const timeSlot = Math.floor((ev.ts || 0) / 90000);
            const dedupKey = `${rTag}|${rText}|${ev.messageId || ''}|${timeSlot}`;
            if (seenFPs.has(dedupKey)) continue;
            seenFPs.add(dedupKey);
            events.push(ev);
          }"""

    if old_render_filter in content:
        content = content.replace(old_render_filter, new_render_filter)
        print(f'Added render deduplication filter in {filepath}')
    else:
        print(f'Warning: old_render_filter not found in {filepath}')

    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)

remove_activity_dupes(r'C:\Users\olivi\Downloads\Rollbux\index.html')
remove_activity_dupes(r'C:\Users\olivi\Downloads\Rollbux\server\dashboard.html')
