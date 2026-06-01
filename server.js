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

  const monthRecords = read(FILES.records).filter(r => {
    const d = new Date(r.timestamp);
    return d.getMonth() + 1 === m && d.getFullYear() === y;
  });

  const report = read(FILES.employees).map(emp => {
    const empRecs = monthRecords
      .filter(r => r.employeeId === emp.id)
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    if (!empRecs.length) return null;

    // Group by local date
    const byDate = {};
    empRecs.forEach(r => {
      const k = localDateKey(r.timestamp);
      (byDate[k] = byDate[k] || []).push(r);
    });

    let totalMealDays = 0, totalDiet = 0, totalDietHours = 0, totalWorkedHours = 0;
    const dailyDetails = [];

    Object.keys(byDate).sort().forEach(date => {
      const day = byDate[date].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

      const hasPrichod     = day.some(r => r.action === 'prichod');
      const hasOdchod      = day.some(r => r.action === 'odchod');
      const hasOdchodMontaz = day.some(r => r.action === 'odchod_montaz');

      // Meal contribution: full HQ day — came in, went out, no assembly trip
      const mealDay = hasPrichod && hasOdchod && !hasOdchodMontaz;
      if (mealDay) totalMealDays++;

      // Pair odchod_montaz → navrat_montaz (same day)
      const deps = day.filter(r => r.action === 'odchod_montaz').map(r => new Date(r.timestamp)).sort((a,b) => a-b);
      let   rets = day.filter(r => r.action === 'navrat_montaz').map(r => new Date(r.timestamp)).sort((a,b) => a-b);

      let assemblyMs = 0;
      for (const dep of deps) {
        const ret = rets.find(r => r > dep);
        if (ret) {
          assemblyMs += ret - dep;
          rets = rets.filter(r => r !== ret);
        }
      }

      const assemblyHours = assemblyMs / 3_600_000;
      totalDietHours += assemblyHours;

      let dayDiet = 0;
      if      (assemblyHours >= 18) dayDiet = cfg.dietRate18plus;
      else if (assemblyHours >= 12) dayDiet = cfg.dietRate12to18;
      else if (assemblyHours >= 5)  dayDiet = cfg.dietRate5to12;

      totalDiet += dayDiet;

      // Worked hours per day: span from earliest to latest event of that day.
      // Admin can edit records if a missing clock-out makes this look wrong.
      const times = day.map(r => new Date(r.timestamp).getTime());
      const workedMs    = times.length > 1 ? Math.max(...times) - Math.min(...times) : 0;
      const workedHours = workedMs / 3_600_000;
      totalWorkedHours += workedHours;

      dailyDetails.push({
        date,
        records:      day.map(r => ({
          id:        r.id,
          action:    r.action,
          time:      localTime(r.timestamp),
          timestamp: r.timestamp,
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
