'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────
const ACTION_LABEL = {
  prichod:       'Príchod',
  odchod:        'Odchod',
  odchod_montaz: 'Odchod na montáž',
  navrat_montaz: 'Návrat z montáže',
};
const ACTION_BADGE = {
  prichod:       'b-green',
  odchod:        'b-red',
  odchod_montaz: 'b-orange',
  navrat_montaz: 'b-blue',
};
const MONTHS = ['Január','Február','Marec','Apríl','Máj','Jún',
                'Júl','August','September','Október','November','December'];

let token = localStorage.getItem('dochadzka_token') || '';

// ── Bootstrap ─────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  initSelects();
  if (token) showAdmin();
});

function initSelects() {
  const now = new Date();
  const curM = now.getMonth() + 1;
  const curY = now.getFullYear();

  // Month selects
  ['f-month', 'r-month'].forEach(id => {
    const sel = document.getElementById(id);
    MONTHS.forEach((name, i) => {
      const o = new Option(name, i + 1);
      sel.appendChild(o);
    });
    sel.value = curM;
  });

  // Year selects
  ['f-year', 'r-year'].forEach(id => {
    const sel = document.getElementById(id);
    for (let y = curY; y >= curY - 4; y--) sel.appendChild(new Option(y, y));
    sel.value = curY;
  });
}

// ── Auth ──────────────────────────────────────────────────────────────────────
async function doLogin() {
  const pw  = document.getElementById('pw-input').value;
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pw }),
  });
  const data = await res.json();
  if (res.ok) {
    token = data.token;
    localStorage.setItem('dochadzka_token', token);
    showAdmin();
  } else {
    const el = document.getElementById('login-err');
    el.textContent = data.error;
    el.classList.remove('hidden');
  }
}

function doLogout() {
  fetch('/api/logout', { method: 'POST', headers: { 'x-auth-token': token } });
  localStorage.removeItem('dochadzka_token');
  token = '';
  document.getElementById('admin-wrap').classList.add('hidden');
  document.getElementById('login-wrap').classList.remove('hidden');
}

async function showAdmin() {
  document.getElementById('login-wrap').classList.add('hidden');
  document.getElementById('admin-wrap').classList.remove('hidden');
  await Promise.all([loadEmps(), loadSettings(), loadQRCodes()]);
  loadRecords();
}

// ── API helper ────────────────────────────────────────────────────────────────
async function api(method, url, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', 'x-auth-token': token },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (res.status === 401) { doLogout(); return null; }
  return res;
}

// ── Tab switching ─────────────────────────────────────────────────────────────
function switchTab(name, btn) {
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`pane-${name}`).classList.add('active');
  btn.classList.add('active');
}

// ── Employees ─────────────────────────────────────────────────────────────────
async function loadEmps() {
  const res  = await api('GET', '/api/employees');
  if (!res) return;
  const list = await res.json();

  // Grid
  const grid = document.getElementById('emp-grid');
  grid.innerHTML = list.length
    ? list.map(e => `
        <div class="emp-card">
          <span>${esc(e.name)}</span>
          <button class="btn btn-danger" style="padding:5px 12px;font-size:.8rem"
                  onclick="delEmp('${e.id}')">Vymazať</button>
        </div>`).join('')
    : '<p style="color:var(--muted)">Zatiaľ žiadni zamestnanci.</p>';

  // Employee filter select
  const fEmp   = document.getElementById('f-emp');
  const curVal = fEmp.value;
  fEmp.innerHTML = '<option value="">Všetci zamestnanci</option>';
  list.forEach(e => fEmp.appendChild(new Option(e.name, e.id)));
  if (curVal) fEmp.value = curVal;
}

async function addEmp() {
  const inp  = document.getElementById('new-emp');
  const name = inp.value.trim();
  if (!name) return;
  const res = await api('POST', '/api/employees', { name });
  if (res?.ok) { inp.value = ''; await loadEmps(); }
}

async function delEmp(id) {
  if (!confirm('Naozaj vymazať zamestnanca?\nJeho záznamy zostanú zachované.')) return;
  await api('DELETE', `/api/employees/${id}`);
  await loadEmps();
}

// ── Records ───────────────────────────────────────────────────────────────────
async function loadRecords() {
  const month = document.getElementById('f-month').value;
  const year  = document.getElementById('f-year').value;
  const empId = document.getElementById('f-emp').value;

  let url = '/api/records?';
  if (month)  url += `month=${month}&`;
  if (year)   url += `year=${year}&`;
  if (empId)  url += `employeeId=${empId}&`;

  const res = await api('GET', url);
  if (!res) return;
  const records = await res.json();

  records.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  const tbody = document.getElementById('rec-body');
  tbody.innerHTML = records.length
    ? records.map(r => {
        const d = new Date(r.timestamp);
        return `<tr>
          <td>${d.toLocaleDateString('sk-SK',  { timeZone:'Europe/Bratislava' })}</td>
          <td>${d.toLocaleTimeString('sk-SK',  { timeZone:'Europe/Bratislava', hour:'2-digit', minute:'2-digit' })}</td>
          <td>${esc(r.employeeName)}</td>
          <td><span class="badge ${ACTION_BADGE[r.action] || 'b-gray'}">${ACTION_LABEL[r.action] || r.action}</span></td>
        </tr>`;
      }).join('')
    : '<tr><td colspan="4" class="no-data">Žiadne záznamy pre zvolený filter</td></tr>';
}

// ── Settings ──────────────────────────────────────────────────────────────────
async function loadSettings() {
  const res = await api('GET', '/api/settings');
  if (!res) return;
  const s = await res.json();
  document.getElementById('s-diet').value = s.dietRate;
  document.getElementById('s-meal').value = s.mealContribution;
}

async function saveSettings() {
  const dietRate         = parseFloat(document.getElementById('s-diet').value);
  const mealContribution = parseFloat(document.getElementById('s-meal').value);
  const res = await api('PUT', '/api/settings', { dietRate, mealContribution });
  const el  = document.getElementById('s-msg');
  if (res?.ok) {
    el.textContent = '✓ Nastavenia uložené';
    el.className   = 'msg msg-ok';
  } else {
    el.textContent = 'Chyba pri ukladaní';
    el.className   = 'msg msg-err';
  }
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = 'msg hidden'; }, 2500);
}

// ── Monthly report ────────────────────────────────────────────────────────────
async function loadReport() {
  const month = document.getElementById('r-month').value;
  const year  = document.getElementById('r-year').value;

  const res  = await api('GET', `/api/monthly-report?month=${month}&year=${year}`);
  if (!res) return;
  const data = await res.json();

  const out = document.getElementById('report-out');
  if (!data.report?.length) {
    out.innerHTML = '<p style="color:var(--muted);margin-top:12px">Žiadne záznamy pre zvolený mesiac.</p>';
    return;
  }

  const { report, settings: s } = data;
  const monthName = MONTHS[data.month - 1];

  out.innerHTML = `
    <p style="color:var(--muted);margin-bottom:16px;font-size:.88rem">
      ${monthName} ${data.year} &nbsp;·&nbsp;
      Sadzba diéty: <strong>${s.dietRate} €/deň</strong> &nbsp;·&nbsp;
      Príspevok na stravu: <strong>${s.mealContribution} €/deň</strong>
    </p>

    <!-- Summary table -->
    <div class="report-block">
      <h3>Súhrn</h3>
      <div class="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>Zamestnanec</th>
              <th>Dni (strava)</th>
              <th>Prísp. strava</th>
              <th>Hod. montáž</th>
              <th>Diéty</th>
              <th>Spolu</th>
            </tr>
          </thead>
          <tbody>
            ${report.map(row => `
              <tr>
                <td><strong>${esc(row.employee.name)}</strong></td>
                <td>${row.totalMealDays}</td>
                <td><strong>${row.totalMealContribution.toFixed(2)} €</strong></td>
                <td>${row.totalDietHours.toFixed(1)} h</td>
                <td><strong>${row.totalDiet.toFixed(2)} €</strong></td>
                <td><strong>${(row.totalMealContribution + row.totalDiet).toFixed(2)} €</strong></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Per-employee detail -->
    ${report.map(row => `
      <div class="report-block">
        <h3>${esc(row.employee.name)}</h3>
        <div class="stats-row">
          <div class="stat"><div class="val">${row.totalMealDays}</div><div class="lbl">Dni so stravou</div></div>
          <div class="stat"><div class="val">${row.totalMealContribution.toFixed(2)} €</div><div class="lbl">Prísp. strava</div></div>
          <div class="stat"><div class="val">${row.totalDietHours.toFixed(1)} h</div><div class="lbl">Na montáži</div></div>
          <div class="stat"><div class="val">${row.totalDiet.toFixed(2)} €</div><div class="lbl">Diéty</div></div>
          <div class="stat"><div class="val">${(row.totalMealContribution + row.totalDiet).toFixed(2)} €</div><div class="lbl">Spolu</div></div>
        </div>
        <button class="detail-toggle no-print" onclick="toggleDetail(this)">▼ Zobraziť denné záznamy</button>
        <div class="day-detail hidden">
          <div class="tbl-wrap">
            <table>
              <thead>
                <tr><th>Dátum</th><th>Záznamy</th><th>Strava</th><th>Montáž</th><th>Diéta</th></tr>
              </thead>
              <tbody>
                ${row.dailyDetails.map(d => `
                  <tr>
                    <td style="white-space:nowrap">${d.date}</td>
                    <td>${d.records.map(r =>
                        `<span class="badge ${ACTION_BADGE[r.action] || 'b-gray'}" title="${ACTION_LABEL[r.action]}">${r.time}</span>`
                      ).join(' ')}</td>
                    <td>${d.mealDay
                        ? '<span class="badge b-green">✓</span>'
                        : '<span class="badge b-gray">–</span>'}</td>
                    <td>${d.assemblyHours > 0 ? d.assemblyHours.toFixed(1) + ' h' : '–'}</td>
                    <td>${d.dayDiet > 0 ? d.dayDiet.toFixed(2) + ' €' : '–'}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>`).join('')}
  `;
}

function toggleDetail(btn) {
  const detail = btn.nextElementSibling;
  const open   = detail.classList.toggle('hidden') === false;
  btn.textContent = open ? '▲ Skryť denné záznamy' : '▼ Zobraziť denné záznamy';
}

// ── QR Codes ──────────────────────────────────────────────────────────────────
const QR_ACTIONS = [
  { action: 'prichod',       label: 'Príchod',         color: '#16a34a' },
  { action: 'odchod',        label: 'Odchod',           color: '#dc2626' },
  { action: 'odchod_montaz', label: 'Odchod na montáž', color: '#ea580c' },
  { action: 'navrat_montaz', label: 'Návrat z montáže', color: '#2563eb' },
];

async function loadQRCodes() {
  const urlRes    = await fetch('/api/server-url');
  const { url }   = await urlRes.json();
  const grid      = document.getElementById('qr-grid');
  const hintBox   = document.getElementById('qr-hint');

  hintBox.innerHTML = `
    ⚠️ Pre správne fungovanie QR kódov na mobiloch musia zamestnanci pristupovať
    cez sieťovú IP adresu servera, nie <em>localhost</em>.<br>
    Aktuálna URL servera: <strong>${url}</strong>
  `;

  grid.innerHTML = '';

  for (const { action, label, color } of QR_ACTIONS) {
    const scanUrl = `${url}/scan?action=${action}`;
    const qrRes   = await fetch(`/api/qrcode?url=${encodeURIComponent(scanUrl)}`);
    const { dataURL } = await qrRes.json();

    const card = document.createElement('div');
    card.className = 'qr-card';
    card.innerHTML = `
      <h3 style="color:${color}">${label}</h3>
      <img src="${dataURL}" alt="QR – ${label}">
      <p class="url">${scanUrl}</p>
    `;
    grid.appendChild(card);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
