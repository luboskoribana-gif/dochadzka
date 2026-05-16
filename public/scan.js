const ACTION_META = {
  prichod:       { label: 'Príchod',         color: '#16a34a' },
  odchod:        { label: 'Odchod',           color: '#dc2626' },
  odchod_montaz: { label: 'Odchod na montáž', color: '#ea580c' },
  navrat_montaz: { label: 'Návrat z montáže', color: '#2563eb' },
};

const params = new URLSearchParams(location.search);
const action = params.get('action');
const meta   = ACTION_META[action];

// Show action pill
const pill = document.getElementById('action-pill');
if (meta) {
  pill.textContent       = meta.label;
  pill.style.background  = meta.color;
} else {
  pill.textContent       = 'Neznáma akcia';
  pill.style.background  = '#94a3b8';
}

// Live clock
function tick() {
  const now = new Date();
  document.getElementById('clock').textContent =
    now.toLocaleTimeString('sk-SK', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  document.getElementById('date-str').textContent =
    now.toLocaleDateString('sk-SK', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}
tick();
setInterval(tick, 1000);

// Load employees
fetch('/api/employees')
  .then(r => r.json())
  .then(list => {
    const sel = document.getElementById('emp-select');
    list.forEach(e => {
      const o = document.createElement('option');
      o.value = e.id;
      o.textContent = e.name;
      sel.appendChild(o);
    });
  });

function showMsg(text, ok) {
  const el = document.getElementById('msg');
  el.textContent = text;
  el.className   = `msg ${ok ? 'msg-ok' : 'msg-err'}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = 'msg hidden'; }, 4000);
}

async function doConfirm() {
  const employeeId = document.getElementById('emp-select').value;
  if (!employeeId)  return showMsg('Vyberte zamestnanca!', false);
  if (!meta)        return showMsg('Neplatná akcia v URL.', false);

  const btn = document.getElementById('confirm-btn');
  btn.disabled = true;

  try {
    const res  = await fetch('/api/records', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeId, action }),
    });
    const data = await res.json();
    if (res.ok) {
      const t = new Date(data.timestamp).toLocaleTimeString('sk-SK', { hour: '2-digit', minute: '2-digit' });
      showMsg(`✓ ${data.employeeName} — ${meta.label} zapísaný o ${t}`, true);
      document.getElementById('emp-select').value = '';
    } else {
      showMsg(data.error || 'Chyba pri zápise', false);
    }
  } catch {
    showMsg('Chyba spojenia so serverom', false);
  } finally {
    btn.disabled = false;
  }
}
