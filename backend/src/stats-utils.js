'use strict';

const crypto = require('crypto');

const REPORT_TIME_ZONE = 'Europe/Rome';
const MAX_SESSIONS = 2000;
const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: REPORT_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function asMs(value, fallback = 0) {
  const parsed = typeof value === 'number' ? value : Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function dayKey(value) {
  const ms = asMs(value, Date.now());
  const parts = formatter.formatToParts(new Date(ms));
  const get = (type) => parts.find((part) => part.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function roundedSeconds(startMs, endMs) {
  return Math.max(0, Math.round(((endMs - startMs) / 1000) * 1000) / 1000);
}

function splitIntervalByDay(startValue, endValue) {
  const startMs = asMs(startValue, 0);
  const endMs = asMs(endValue, startMs);
  if (!startMs || endMs <= startMs) return [];

  const pieces = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const key = dayKey(cursor);
    let boundary = endMs;
    if (dayKey(endMs - 1) !== key) {
      let low = cursor + 1;
      let high = endMs;
      while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (dayKey(mid) === key) low = mid + 1;
        else high = mid;
      }
      boundary = low;
    }
    pieces.push({ date: key, seconds: roundedSeconds(cursor, boundary) });
    cursor = boundary;
  }
  return pieces;
}

function cleanGame(game) {
  const appid = Number(game && game.appid);
  if (!Number.isInteger(appid) || appid <= 0) return null;
  return {
    appid,
    name: String((game && game.name) || `App ${appid}`).slice(0, 120),
    image: String((game && game.image) || '').slice(0, 500)
  };
}

function cleanGames(games) {
  const seen = new Set();
  return (Array.isArray(games) ? games : [])
    .map(cleanGame)
    .filter((game) => game && !seen.has(game.appid) && seen.add(game.appid));
}

function ensureStats(stats) {
  const target = stats && typeof stats === 'object' ? stats : {};
  target.schemaVersion = 2;
  target.totalSeconds = Math.max(0, Number(target.totalSeconds) || 0);
  target.sessions = Array.isArray(target.sessions) ? target.sessions : [];
  target.gameTotals = target.gameTotals && typeof target.gameTotals === 'object' ? target.gameTotals : {};
  target.dailyTotals = target.dailyTotals && typeof target.dailyTotals === 'object' ? target.dailyTotals : {};
  target.activeSession = target.activeSession && typeof target.activeSession === 'object' ? target.activeSession : null;
  return target;
}

function normalizeInterval(interval, fallbackStart, fallbackEnd) {
  const startedAt = new Date(asMs(interval && interval.startedAt, fallbackStart)).toISOString();
  const endedAt = new Date(asMs(interval && interval.endedAt, fallbackEnd)).toISOString();
  return {
    startedAt,
    endedAt,
    seconds: Math.max(0, Number(interval && interval.seconds) || roundedSeconds(asMs(startedAt), asMs(endedAt)))
  };
}

function normalizeSegment(segment, fallbackStart, fallbackEnd) {
  const game = cleanGame(segment);
  if (!game) return null;
  const interval = normalizeInterval(segment, fallbackStart, fallbackEnd);
  return { ...game, ...interval };
}

function normalizeSession(raw, running = false) {
  const now = Date.now();
  const startedMs = asMs(raw && raw.startedAt, now);
  const endedMs = running ? now : asMs(raw && raw.endedAt, startedMs + Math.max(0, Number(raw && raw.seconds) || 0) * 1000);
  const games = cleanGames(raw && raw.games);
  const fallbackSeconds = Math.max(0, Number(raw && raw.seconds) || roundedSeconds(startedMs, endedMs));
  let intervals = Array.isArray(raw && raw.intervals)
    ? raw.intervals.map((item) => normalizeInterval(item, startedMs, endedMs)).filter((item) => item.seconds > 0)
    : [];
  if (!intervals.length && fallbackSeconds > 0) {
    const fallbackEnd = startedMs + fallbackSeconds * 1000;
    intervals = [normalizeInterval({ startedAt: startedMs, endedAt: fallbackEnd, seconds: fallbackSeconds }, startedMs, fallbackEnd)];
  }

  let segments = Array.isArray(raw && raw.segments)
    ? raw.segments.map((item) => normalizeSegment(item, startedMs, endedMs)).filter(Boolean)
    : [];
  if (!segments.length && games.length && fallbackSeconds > 0) {
    const fallbackEnd = startedMs + fallbackSeconds * 1000;
    segments = games.map((game) => ({
      ...game,
      startedAt: new Date(startedMs).toISOString(),
      endedAt: new Date(fallbackEnd).toISOString(),
      seconds: fallbackSeconds
    }));
  }

  const seconds = intervals.reduce((sum, item) => sum + Math.max(0, Number(item.seconds) || 0), 0);
  return {
    id: String((raw && raw.id) || crypto.randomUUID()),
    startedAt: new Date(startedMs).toISOString(),
    endedAt: running ? null : new Date(endedMs).toISOString(),
    elapsedSeconds: Math.max(0, Number(raw && raw.elapsedSeconds) || roundedSeconds(startedMs, endedMs)),
    seconds,
    reason: String((raw && raw.reason) || (running ? 'running' : 'unknown')),
    mode: ['games', 'favorite'].includes(raw && raw.mode) ? raw.mode : 'games',
    games,
    intervals,
    segments,
    totalBeforeSeconds: Math.max(0, Number(raw && raw.totalBeforeSeconds) || 0),
    totalAfterSeconds: Math.max(0, Number(raw && raw.totalAfterSeconds) || 0),
    running: Boolean(running || (raw && raw.running))
  };
}

function ensureGameTotal(stats, game) {
  const key = String(game.appid);
  const current = stats.gameTotals[key] || {};
  stats.gameTotals[key] = {
    appid: game.appid,
    name: game.name || current.name || `App ${game.appid}`,
    image: game.image || current.image || '',
    totalSeconds: Math.max(0, Number(current.totalSeconds) || 0),
    sessions: Math.max(0, Number(current.sessions) || 0),
    lastBoostedAt: current.lastBoostedAt || ''
  };
  return stats.gameTotals[key];
}

function ensureDaily(stats, date) {
  const current = stats.dailyTotals[date] || {};
  stats.dailyTotals[date] = {
    date,
    totalSeconds: Math.max(0, Number(current.totalSeconds) || 0),
    games: current.games && typeof current.games === 'object' ? current.games : {}
  };
  return stats.dailyTotals[date];
}

function recordSession(statsInput, rawSession, { prepend = true, maxSessions = MAX_SESSIONS } = {}) {
  const stats = ensureStats(statsInput);
  const session = normalizeSession(rawSession, Boolean(rawSession && rawSession.running));
  session.totalBeforeSeconds = Math.max(0, Number(rawSession && rawSession.totalBeforeSeconds) || stats.totalSeconds);
  session.totalAfterSeconds = session.totalBeforeSeconds + session.seconds;
  stats.totalSeconds += session.seconds;

  for (const interval of session.intervals) {
    for (const piece of splitIntervalByDay(interval.startedAt, interval.endedAt)) {
      ensureDaily(stats, piece.date).totalSeconds += piece.seconds;
    }
  }

  const seenInSession = new Set();
  for (const segment of session.segments) {
    const total = ensureGameTotal(stats, segment);
    total.totalSeconds += Math.max(0, Number(segment.seconds) || 0);
    total.lastBoostedAt = segment.endedAt || session.endedAt || new Date().toISOString();
    if (!seenInSession.has(segment.appid)) {
      total.sessions += 1;
      seenInSession.add(segment.appid);
    }

    for (const piece of splitIntervalByDay(segment.startedAt, segment.endedAt)) {
      const daily = ensureDaily(stats, piece.date);
      const key = String(segment.appid);
      const current = daily.games[key] || {
        appid: segment.appid,
        name: segment.name,
        image: segment.image,
        seconds: 0
      };
      current.name = segment.name || current.name;
      current.image = segment.image || current.image;
      current.seconds = Math.max(0, Number(current.seconds) || 0) + piece.seconds;
      daily.games[key] = current;
    }
  }

  if (prepend) {
    stats.sessions.unshift(session);
    stats.sessions = stats.sessions.slice(0, Math.max(1, Number(maxSessions) || MAX_SESSIONS));
  }
  return session;
}

function migrateStats(statsInput) {
  const originalSchemaVersion = Number(statsInput && statsInput.schemaVersion) || 0;
  const source = ensureStats(statsInput);
  if (originalSchemaVersion >= 2) {
    source.sessions = source.sessions.map((session) => normalizeSession(session, false)).slice(0, MAX_SESSIONS);
    return source;
  }

  const oldSessions = Array.isArray(source.sessions) ? source.sessions.map((item) => normalizeSession(item, false)) : [];
  const activeSession = source.activeSession;
  const knownSessionSeconds = oldSessions.reduce((sum, session) => sum + Math.max(0, Number(session.seconds) || 0), 0);
  const legacyUnattributedSeconds = Math.max(0, (Number(source.totalSeconds) || 0) - knownSessionSeconds);
  const rebuilt = ensureStats({
    schemaVersion: 2,
    totalSeconds: legacyUnattributedSeconds,
    sessions: [],
    gameTotals: {},
    dailyTotals: {},
    activeSession
  });

  const chronological = [...oldSessions].sort((a, b) => asMs(a.startedAt) - asMs(b.startedAt));
  for (const session of chronological) {
    recordSession(rebuilt, session, { prepend: true, maxSessions: MAX_SESSIONS });
  }
  rebuilt.sessions.sort((a, b) => asMs(b.startedAt) - asMs(a.startedAt));
  return rebuilt;
}

function historySnapshot(statsInput, activeSession = null) {
  const stats = clone(ensureStats(statsInput));
  if (activeSession) recordSession(stats, { ...activeSession, running: true }, { prepend: true, maxSessions: MAX_SESSIONS });
  const gameTotals = Object.values(stats.gameTotals)
    .sort((a, b) => Number(b.totalSeconds) - Number(a.totalSeconds));
  const dailyTotals = Object.values(stats.dailyTotals)
    .map((day) => ({
      ...day,
      games: Object.values(day.games || {}).sort((a, b) => Number(b.seconds) - Number(a.seconds))
    }))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));

  const today = dayKey(Date.now());
  const [year, month, day] = today.split('-').map(Number);
  const utcDay = new Date(Date.UTC(year, month - 1, day));
  const mondayOffset = (utcDay.getUTCDay() + 6) % 7;
  const weekStartDate = new Date(utcDay.getTime() - mondayOffset * 24 * 60 * 60 * 1000);
  const weekStart = weekStartDate.toISOString().slice(0, 10);
  const monthPrefix = today.slice(0, 7);
  const periodSummary = dailyTotals.reduce((summary, entry) => {
    const seconds = Math.max(0, Number(entry.totalSeconds) || 0);
    if (entry.date === today) summary.todaySeconds += seconds;
    if (entry.date >= weekStart && entry.date <= today) summary.weekSeconds += seconds;
    if (String(entry.date).startsWith(monthPrefix)) summary.monthSeconds += seconds;
    return summary;
  }, { todaySeconds: 0, weekSeconds: 0, monthSeconds: 0, weekStart, today });

  return {
    reportTimeZone: REPORT_TIME_ZONE,
    totalSeconds: stats.totalSeconds,
    sessions: stats.sessions,
    gameTotals,
    dailyTotals,
    periodSummary
  };
}

module.exports = {
  REPORT_TIME_ZONE,
  MAX_SESSIONS,
  dayKey,
  splitIntervalByDay,
  normalizeSession,
  ensureStats,
  migrateStats,
  recordSession,
  historySnapshot,
  cleanGame,
  cleanGames
};
