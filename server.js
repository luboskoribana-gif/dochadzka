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
app.get('/api/settings', authMW, (req, res) => res.json(read(FILES.settings)));

app.put('/api/settings', authMW, (req, res) => {
  const settings = {
    dietRate:         parseFloat(req.body.dietRate)         || 17.40,
    mealContribution: parseFloat(req.body.mealContribution) || 2.81,
  };
  write(FILES.settings, settings);
  res.json(settings);
});

// ─── Monthly report ──────────────────────────────────────────────────────────
app.get('/api/monthly-report', authMW, (req, res) => {
  const { month, year } = req.query;
  if (!month || !year) return res.status(400).json({ error: 'Chýba mesiac alebo rok' });

  const m   = parseInt(month);
  const y   = parseInt(year);
  const cfg = read(FILES.settings);

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

    let totalMealDays = 0, totalDiet = 0, totalDietHours = 0;
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
      if      (assemblyHours >= 18) dayDiet = cfg.dietRate;
      else if (assemblyHours >= 12) dayDiet = cfg.dietRate * 0.75;
      else if (assemblyHours >= 5)  dayDiet = cfg.dietRate * 0.50;

      totalDiet += dayDiet;

      dailyDetails.push({
        date,
        records:      day.map(r => ({ action: r.action, time: localTime(r.timestamp) })),
        mealDay,
        assemblyHours: r2(assemblyHours),
        dayDiet:       r2(dayDiet),
      });
    });

    return {
      employee: emp,
      totalMealDays,
      totalMealContribution: r2(totalMealDays * cfg.mealContribution),
      totalDietHours:        r2(totalDietHours),
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
