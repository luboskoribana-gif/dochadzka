'use strict';
const express = require('express');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const QRCode  = require('qrcode');

const app     = express();
const PORT    = process.env.PORT || 3000;
const PUB_DIR = path.join(__dirname, 'public');

// Na Railway (RAILWAY_ENVIRONMENT je nastavené automaticky) použij /app/data,
// lokálne použij ./data vedľa server.js
const DATA_DIR = process.env.DATA_DIR ||
  (process.env.RAILWAY_ENVIRONMENT ? '/app/data' : path.join(__dirname, 'data'));

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const FILES = {
  employees: path.join(DATA_DIR, 'employees.json'),
  records:   path.join(DATA_DIR, 'records.json'),
  settings:  path.join(DATA_DIR, 'settings.json'),
};

function initFile(f, def) {
  if (!fs.existsSync(f)) fs.writeFileSync(f, JSON.stringify(def, null, 2));
}
initFile(FILES.employees, []);
initFile(FILES.records,   []);
initFile(FILES.settings,  { dietRate: 17.40, mealContribution: 2.81 });

const read  = f      => JSON.parse(fs.readFileSync(f, 'utf8'));
const write = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 2));
const r2    = n      => Math.round(n * 100) / 100;

// Settings reader normalizes legacy single-rate format to 3 explicit diet rates.
// Existing files with only { dietRate, mealContribution } continue to work —
// the 3 tiers are derived (50% / 75% / 100%) until the admin saves new values.
function readSettings() {
  const raw  = read(FILES.settings);
  const base = parseFloat(raw.dietRate);
  const baseRate = Number.isFinite(base) ? base : 17.40;
  const pick = (v, fallback) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    dietRate5to12:    pick(raw.dietRate5to12,  r2(baseRate * 0.50)),
    dietRate12to18:   pick(raw.dietRate12to18, r2(baseRate * 0.75)),
    dietRate18plus:   pick(raw.dietRate18plus, r2(baseRate)),
    mealContribution: pick(raw.mealContribution, 2.81),
  };
}

function localDateKey(iso) {
  return new Date(iso).toLocaleDateString('sk-SK', {
    timeZone: 'Europe/Bratislava',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
}
function localTime(iso) {
  return new Date(iso).toLocaleTimeString('sk-SK', {
    timeZone: 'Europe/Bratislava',
    hour: '2-digit', minute: '2-digit',
  });
}

// Returns YYYY-MM-DD for the local Europe/Bratislava date of a UTC ms timestamp.
function bratislavaISODate(ms) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Bratislava',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(ms));
  const get = t => parts.find(p => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// Returns UTC ms of the next local-Bratislava midnight strictly after `ms`.
// Handles DST transitions by probing both possible UTC offsets.
function nextBratislavaMidnight(ms) {
  const iso = bratislavaISODate(ms);
  const [y, m, d] = iso.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const tomorrow = `${next.getUTCFullYear()}-`
    + `${String(next.getUTCMonth() + 1).padStart(2, '0')}-`
    + `${String(next.getUTCDate()).padStart(2, '0')}`;
  for (const off of ['+01:00', '+02:00']) {
    const candidate = Date.parse(`${tomorrow}T00:00:00${off}`);
    if (bratislavaISODate(candidate) === tomorrow) {
      const hour = parseInt(new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Bratislava', hour: '2-digit', hour12: false,
      }).format(new Date(candidate)), 10);
      if (hour === 0) return candidate;
    }
  }
  return Date.parse(`${tomorrow}T00:00:00+01:00`);
}

// Splits a time interval [startMs, endMs) into chunks per local Bratislava day.
// Returns { localDateKey -> ms }. Handles multi-day spans and DST.
function splitMsByLocalDay(startMs, endMs) {
  const out = {};
  if (endMs <= startMs) return out;
  let cursor = startMs;
  // Guard against runaway loops (>366 days = clearly bogus data)
  let guard = 400;
  while (cursor < endMs && guard-- > 0) {
    const key   = localDateKey(cursor);
    const next  = nextBratislavaMidnight(cursor);
    const chunk = Math.min(next, endMs);
    out[key] = (out[key] || 0) + (chunk - cursor);
    cursor   = chunk;
  }
  return out;
}

// Local hour (0-23) in Europe/Bratislava for a UTC timestamp.
function bratislavaHour(iso) {
  return parseInt(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Bratislava', hour: '2-digit', hour12: false,
  }).format(new Date(iso)), 10);
}

// The localDateKey of the calendar day AFTER `dayKey`.
function nextLocalDayKey(dayKey) {
  const p = dayKey.match(/(\d+)\.\s*(\d+)\.\s*(\d+)/);
  if (!p) return null;
  const nextMs = Date.UTC(parseInt(p[3]), parseInt(p[2]) - 1, parseInt(p[1]) + 1, 12);
  return localDateKey(new Date(nextMs).toISOString());
}

// UTC ISO timestamp for HH:MM local Bratislava on the given dayKey.
function localTimestampOn(dayKey, hour, minute = 0) {
  const p = dayKey.match(/(\d+)\.\s*(\d+)\.\s*(\d+)/);
  const [d, m, y] = [p[1].padStart(2, '0'), p[2].padStart(2, '0'), p[3]];
  const isoLocal = `${y}-${m}-${d}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
  for (const off of ['+02:00', '+01:00']) {
    const ms = Date.parse(`${isoLocal}${off}`);
    const iso = new Date(ms).toISOString();
    if (localDateKey(iso) === dayKey && bratislavaHour(iso) === hour) return iso;
  }
  return new Date(Date.parse(`${isoLocal}+02:00`)).toISOString();
}

// Local day-of-week (0=Sun..6=Sat) for a date key.
function localDayOfWeek(dayKey) {
  const p = dayKey.match(/(\d+)\.\s*(\d+)\.\s*(\d+)/);
  if (!p) return -1;
  return new Date(Date.UTC(parseInt(p[3]), parseInt(p[2]) - 1, parseInt(p[1]), 12)).getUTCDay();
}
function isWeekendKey(k) { const d = localDayOfWeek(k); return d === 0 || d === 6; }

// Two-pass synthetic close/open generator:
//
// Rule 1 — Missing close on a workday:
//   Day has a morning prichod (arrival at HQ before noon) but no leave-HQ event
//   (odchod / odchod_montaz). Inject close at 16:00 that day. Which one:
//     - Next relevant day has a morning prichod → forgot odchod → odchod
//     - Otherwise (and there are future events) → left on trip → odchod_montaz
//     - No future events at all → conservative default → odchod
//   "Next relevant day" skips weekends without any events (Friday pairs with Monday).
//
// Rule 2 — Multi-day gap between events implies business trip:
//   For any consecutive event pair (a, b) whose gap covers 1+ workdays strictly
//   between them, inject odchod_montaz at a.timestamp + 1s. Multi-day fix then
//   awards full diet on every calendar day the interval touches. Skipped when
//   `a` is already odchod_montaz (interval is already open).
//
// Synthetic events are flagged `auto: true` and rendered in the report dimmed
// (see admin.js) — they're never persisted.
function synthesizeAutoCloses(records) {
  if (records.length === 0) return records;

  const byDate = new Map();
  for (const r of records) {
    const k = localDateKey(r.timestamp);
    if (!byDate.has(k)) byDate.set(k, []);
    byDate.get(k).push(r);
  }

  const synthetic = [];
  for (const [date, dayEvents] of byDate.entries()) {
    const hasMorningPrichod = dayEvents.some(r =>
      r.action === 'prichod' && bratislavaHour(r.timestamp) < 12);
    const hasClose = dayEvents.some(r =>
      r.action === 'odchod' || r.action === 'odchod_montaz');
    if (!hasMorningPrichod || hasClose) continue;

    // Find next relevant day: skip weekend days that have no events at all.
    let nextKey = nextLocalDayKey(date);
    let guard   = 14;
    while (nextKey && isWeekendKey(nextKey) && !byDate.has(nextKey) && guard-- > 0) {
      nextKey = nextLocalDayKey(nextKey);
    }
    // Are there ANY future events? If not, default to plain odchod (person
    // simply forgot on their last recorded day — don't spuriously start
    // an open-ended trip that would swallow the last day's diet).
    let anyFuture = false;
    if (nextKey) {
      let scan = nextKey, g = 60;
      while (scan && g-- > 0) {
        if (byDate.has(scan)) { anyFuture = true; break; }
        scan = nextLocalDayKey(scan);
      }
    }
    let action = 'odchod';
    if (anyFuture) {
      const nextMorningPrichod = (byDate.get(nextKey) || []).some(r =>
        r.action === 'prichod' && bratislavaHour(r.timestamp) < 12);
      action = nextMorningPrichod ? 'odchod' : 'odchod_montaz';
    }
    const timestamp = localTimestampOn(date, 16, 0);
    const first     = dayEvents[0];
    synthetic.push({
      id:           `auto_${first.employeeId}_${date.replace(/\D/g, '')}_${action}`,
      employeeId:   first.employeeId,
      employeeName: first.employeeName,
      action,
      timestamp,
      auto:         true,
    });
  }

  // Rule 2: multi-day gap between events → business trip.
  const merged = [...records, ...synthetic].sort(
    (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
  );
  for (let i = 0; i < merged.length - 1; i++) {
    const a = merged[i], b = merged[i + 1];
    if (a.action === 'odchod_montaz') continue; // trip already open
    const dayA = localDateKey(a.timestamp);
    const dayB = localDateKey(b.timestamp);
    if (dayA === dayB) continue;
    // Count workdays strictly between dayA and dayB.
    let gapWd = 0, key = nextLocalDayKey(dayA), guard = 120;
    while (key && key !== dayB && guard-- > 0) {
      if (!isWeekendKey(key)) gapWd++;
      key = nextLocalDayKey(key);
    }
    if (gapWd < 1) continue;
    synthetic.push({
      id:           `auto_trip_${a.employeeId}_${new Date(a.timestamp).getTime()}`,
      employeeId:   a.employeeId,
      employeeName: a.employeeName,
      action:       'odchod_montaz',
      // +1s so the original event (odchod/prichod) still sorts first — the
      // pairing loop treats the odchod_montaz as opening a fresh trip.
      timestamp:    new Date(new Date(a.timestamp).getTime() + 1000).toISOString(),
      auto:         true,
    });
  }

  return [...records, ...synthetic].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

// ─── Auth ────────────────────────────────────────────────────────────────────
const ADMIN_PW = 'admin123';
const sessions = new Set();

function authMW(req, res, next) {
  if (!sessions.has(req.headers['x-auth-token']))
    return res.status(401).json({ error: 'Neautorizovaný prístup' });
  next();
}

app.use(express.json());
app.use(express.static(PUB_DIR));

app.post('/api/login', (req, res) => {
  if (req.body.password === ADMIN_PW) {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.add(token);
    res.json({ token });
  } else {
    res.status(401).json({ error: 'Nesprávne heslo' });
  }
});

app.post('/api/logout', (req, res) => {
  sessions.delete(req.headers['x-auth-token']);
  res.json({ ok: true });
});

// ─── Employees ───────────────────────────────────────────────────────────────
// Public GET — scan page needs employee list without login
app.get('/api/employees', (req, res) => res.json(read(FILES.employees)));

app.post('/api/employees', authMW, (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Meno je povinné' });
  const list = read(FILES.employees);
  const emp  = { id: Date.now().toString(), name };
  list.push(emp);
  write(FILES.employees, list);
  res.json(emp);
});

app.delete('/api/employees/:id', authMW, (req, res) => {
  write(FILES.employees, read(FILES.employees).filter(e => e.id !== req.params.id));
  res.json({ ok: true });
});

// ─── Records ─────────────────────────────────────────────────────────────────
const VALID_ACTIONS = ['prichod', 'odchod', 'odchod_montaz', 'navrat_montaz'];

// Public POST — scan page records without login
app.post('/api/records', (req, res) => {
  const { employeeId, action } = req.body;
  if (!VALID_ACTIONS.includes(action))
    return res.status(400).json({ error: 'Neplatná akcia' });
  const emp = read(FILES.employees).find(e => e.id === employeeId);
  if (!emp) return res.status(400).json({ error: 'Zamestnanec nenájdený' });

  const records = read(FILES.records);
  const record  = {
    id: Date.now().toString(),
    employeeId: emp.id,
    employeeName: emp.name,
    action,
    timestamp: new Date().toISOString(),
  };
  records.push(record);
  write(FILES.records, records);
  res.json(record);
});

// Admin can create a record at an arbitrary time (used when someone forgot to clock).
app.post('/api/records/manual', authMW, (req, res) => {
  const { employeeId, action, timestamp } = req.body;
  if (!VALID_ACTIONS.includes(action))
    return res.status(400).json({ error: 'Neplatná akcia' });
  const emp = read(FILES.employees).find(e => e.id === employeeId);
  if (!emp) return res.status(400).json({ error: 'Zamestnanec nenájdený' });
  const ts = new Date(timestamp);
  if (!timestamp || isNaN(ts.getTime()))
    return res.status(400).json({ error: 'Neplatný dátum/čas' });

  const records = read(FILES.records);
  const record  = {
    id: Date.now().toString() + Math.floor(Math.random() * 1000),
    employeeId:   emp.id,
    employeeName: emp.name,
    action,
    timestamp:    ts.toISOString(),
    manual:       true,
  };
  records.push(record);
  write(FILES.records, records);
  res.json(record);
});

app.put('/api/records/:id', authMW, (req, res) => {
  const records = read(FILES.records);
  const idx     = records.findIndex(r => r.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Záznam nenájdený' });
  const rec = records[idx];

  if (req.body.employeeId !== undefined && req.body.employeeId !== rec.employeeId) {
    const emp = read(FILES.employees).find(e => e.id === req.body.employeeId);
    if (!emp) return res.status(400).json({ error: 'Zamestnanec nenájdený' });
    rec.employeeId   = emp.id;
    rec.employeeName = emp.name;
  }
  if (req.body.action !== undefined) {
    if (!VALID_ACTIONS.includes(req.body.action))
      return res.status(400).json({ error: 'Neplatná akcia' });
    rec.action = req.body.action;
  }
  if (req.body.timestamp !== undefined) {
    const ts = new Date(req.body.timestamp);
    if (isNaN(ts.getTime()))
      return res.status(400).json({ error: 'Neplatný dátum/čas' });
    rec.timestamp = ts.toISOString();
  }
  rec.editedAt = new Date().toISOString();
  records[idx] = rec;
  write(FILES.records, records);
  res.json(rec);
});

app.delete('/api/records/:id', authMW, (req, res) => {
  const records  = read(FILES.records);
  const filtered = records.filter(r => r.id !== req.params.id);
  if (filtered.length === records.length)
    return res.status(404).json({ error: 'Záznam nenájdený' });
  write(FILES.records, filtered);
  res.json({ ok: true });
});

app.get('/api/records', authMW, (req, res) => {
  let records = read(FILES.records);
  const { month, year, employeeId } = req.query;
  if (month || year) {
    records = records.filter(r => {
      const d = new Date(r.timestamp);
      if (month && d.getMonth() + 1 !== parseInt(month)) return false;
      if (year  && d.getFullYear()   !== parseInt(year))  return false;
      return true;
    });
  }
  if (employeeId) records = records.filter(r => r.employeeId === employeeId);
  res.json(records);
});

// ─── Settings ────────────────────────────────────────────────────────────────
app.get('/api/settings', authMW, (req, res) => res.json(readSettings()));

app.put('/api/settings', authMW, (req, res) => {
  const pick = (v, fallback) => {
    const n = parseFloat(v);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  const settings = {
    dietRate5to12:    pick(req.body.dietRate5to12,    0),
    dietRate12to18:   pick(req.body.dietRate12to18,   0),
    dietRate18plus:   pick(req.body.dietRate18plus,   0),
    mealContribution: pick(req.body.mealContribution, 2.81),
    // Keep `dietRate` mirrored to the 18+h rate for backward compatibility
    // with any callers that still read the legacy field.
    dietRate:         pick(req.body.dietRate18plus,   0),
  };
  write(FILES.settings, settings);
  res.json(readSettings());
});

// ─── Monthly report ──────────────────────────────────────────────────────────
app.get('/api/monthly-report', authMW, (req, res) => {
  const { month, year } = req.query;
  if (!month || !year) return res.status(400).json({ error: 'Chýba mesiac alebo rok' });

  const m   = parseInt(month);
  const y   = parseInt(year);
  const cfg = readSettings();

  const allRecords = read(FILES.records);
  // Whether a local date string (sk-SK "DD. MM. YYYY") falls in the queried month.
  const isInMonth = (dayKey) => {
    const parts = dayKey.match(/(\d+)\.\s*(\d+)\.\s*(\d+)/);
    return parts && parseInt(parts[2]) === m && parseInt(parts[3]) === y;
  };

  const report = read(FILES.employees).map(emp => {
    // ALL records for this employee, sorted — needed so multi-day montáž that
    // crosses a month boundary (e.g. depart Oct 30 → return Nov 2) is paired correctly.
    // synthesizeAutoCloses injects synthetic odchod/odchod_montaz at 16:00 on days
    // where the employee forgot to log out (see function docs).
    const empAll = synthesizeAutoCloses(
      allRecords
        .filter(r => r.employeeId === emp.id)
        .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
    );

    // Walk records chronologically. odchod_montaz opens an assembly interval;
    // the next non-odchod_montaz event closes it. If navrat_montaz is missing
    // (employee forgot to log it), the next event — typically odchod, or
    // prichod the next day — closes the interval implicitly: being back at
    // HQ to clock out/in implies they returned from assembly.
    const assemblyMsByDay = {};
    // Any calendar day touched by an assembly interval that crosses midnight
    // (multi-day trip). Every such day gets full diet regardless of hours
    // logged that specific day — departure and return days included.
    const multiDayTripDays = new Set();
    let pendingDepart = null;
    for (const r of empAll) {
      if (r.action === 'odchod_montaz') {
        if (pendingDepart === null) pendingDepart = new Date(r.timestamp).getTime();
        // already on assembly → treat duplicate odchod_montaz as no-op
      } else if (pendingDepart !== null) {
        const endMs = new Date(r.timestamp).getTime();
        const perDay = splitMsByLocalDay(pendingDepart, endMs);
        const daysCovered = Object.keys(perDay);
        for (const [day, ms] of Object.entries(perDay)) {
          assemblyMsByDay[day] = (assemblyMsByDay[day] || 0) + ms;
        }
        if (daysCovered.length > 1) daysCovered.forEach(d => multiDayTripDays.add(d));
        pendingDepart = null;
      }
    }
    // pendingDepart still set → unmatched depart with no return anywhere;
    // ignore so admin can fix manually.

    // Records that fall within the queried month (by local date — matches grouping).
    const empMonth = empAll.filter(r => isInMonth(localDateKey(r.timestamp)));

    // Days to report: any day in the queried month with EITHER a record OR assembly time
    // (the latter covers the middle days of a multi-day trip where no clock events exist).
    const byDate = {};
    empMonth.forEach(r => {
      const k = localDateKey(r.timestamp);
      (byDate[k] = byDate[k] || []).push(r);
    });
    Object.keys(assemblyMsByDay).filter(isInMonth).forEach(k => {
      if (!byDate[k]) byDate[k] = [];
    });

    if (Object.keys(byDate).length === 0) return null;

    let totalMealDays = 0, totalDiet = 0, totalDietHours = 0, totalWorkedHours = 0;
    const dailyDetails = [];

    Object.keys(byDate).sort().forEach(date => {
      const day = byDate[date].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

      const assemblyMs    = assemblyMsByDay[date] || 0;
      const assemblyHours = assemblyMs / 3_600_000;
      const isMultiDay    = multiDayTripDays.has(date);
      totalDietHours += assemblyHours;

      let dayDiet = 0;
      if      (isMultiDay)          dayDiet = cfg.dietRate18plus;
      else if (assemblyHours >= 18) dayDiet = cfg.dietRate18plus;
      else if (assemblyHours >= 12) dayDiet = cfg.dietRate12to18;
      else if (assemblyHours >= 5)  dayDiet = cfg.dietRate5to12;

      totalDiet += dayDiet;

      // Meal contribution: HQ workday only. Never on multi-day trip days —
      // even if the person happened to clock prichod+odchod at HQ that day
      // (e.g. arrived at HQ in the morning before departing on montáž).
      const hasPrichod = day.some(r => r.action === 'prichod');
      const hasOdchod  = day.some(r => r.action === 'odchod');
      const mealDay    = hasPrichod && hasOdchod && dayDiet === 0 && !isMultiDay;
      if (mealDay) totalMealDays++;

      // Worked hours per day:
      //   HQ day        → span from first to last record
      //   middle of trip → no records, use assembly time for that day
      //   mixed         → whichever is larger
      const times    = day.map(r => new Date(r.timestamp).getTime());
      const spanMs   = times.length > 1 ? Math.max(...times) - Math.min(...times) : 0;
      const workedMs = Math.max(spanMs, assemblyMs);
      const workedHours = workedMs / 3_600_000;
      totalWorkedHours += workedHours;

      dailyDetails.push({
        date,
        records:      day.map(r => ({
          id:        r.id,
          action:    r.action,
          time:      localTime(r.timestamp),
          timestamp: r.timestamp,
          auto:      r.auto || false,
        })),
        mealDay,
        assemblyHours: r2(assemblyHours),
        workedHours:   r2(workedHours),
        dayDiet:       r2(dayDiet),
      });
    });

    return {
      employee: emp,
      totalMealDays,
      totalMealContribution: r2(totalMealDays * cfg.mealContribution),
      totalDietHours:        r2(totalDietHours),
      totalWorkedHours:      r2(totalWorkedHours),
      totalDiet:             r2(totalDiet),
      dailyDetails,
    };
  }).filter(Boolean);

  res.json({ report, settings: cfg, month: m, year: y });
});

// ─── QR code ─────────────────────────────────────────────────────────────────
app.get('/api/qrcode', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Chýba url' });
  try {
    const dataURL = await QRCode.toDataURL(url, { width: 280, margin: 2 });
    res.json({ dataURL });
  } catch {
    res.status(500).json({ error: 'Chyba pri generovaní QR kódu' });
  }
});

// Returns the base URL as seen by the client (useful for QR code generation)
app.get('/api/server-url', (req, res) => {
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
  res.json({ url: `http://${host}` });
});

// ─── Pages ───────────────────────────────────────────────────────────────────
app.get('/',      (_req, res) => res.redirect('/admin'));
app.get('/admin', (_req, res) => res.sendFile(path.join(PUB_DIR, 'admin.html')));
app.get('/scan',  (_req, res) => res.sendFile(path.join(PUB_DIR, 'scan.html')));

app.listen(PORT, '0.0.0.0', () => {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  let localIP = 'localhost';
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) { localIP = net.address; break; }
    }
  }
  console.log(`\n✅  Dochádzka Enerigo server beží`);
  console.log(`   Dáta:   ${DATA_DIR}`);
  console.log(`   Admin:  http://localhost:${PORT}/admin`);
  console.log(`   Sieť:   http://${localIP}:${PORT}/admin`);
  console.log(`   Scan:   http://${localIP}:${PORT}/scan\n`);
});
