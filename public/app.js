(() => {
  const $ = (id) => document.getElementById(id);
  const MAX_POINTS = 100;
  const state = { key: null, monitors: new Map(), selected: null, socket: null, chart: null, checks: [] };

  // All server data is inserted with textContent, never innerHTML, so a monitor named
  // "<script>..." shows up as text instead of running.
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  async function api(path) {
    const res = await fetch(path, { headers: { Authorization: `Bearer ${state.key}` } });
    if (res.status === 401) { signOut('That key was not accepted.'); throw new Error('unauthorized'); }
    if (res.status === 429) throw new Error('Rate limited, slow down.');
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    return res.json();
  }

  function show(loggedIn) {
    $('login').hidden = loggedIn;
    $('app').hidden = !loggedIn;
    $('logout').hidden = !loggedIn;
  }

  function signOut(message) {
    sessionStorage.removeItem('apiKey');
    if (state.socket) { state.socket.close(); state.socket = null; }
    state.key = null;
    state.monitors.clear();
    state.selected = null;
    $('error').textContent = message || '';
    setConn(false);
    show(false);
  }

  function setConn(on) {
    $('conn').textContent = on ? 'live' : 'offline';
    $('conn').classList.toggle('on', on);
  }

  async function loadMonitors() {
    const list = await api('/monitors');
    state.monitors = new Map(list.map((m) => [m.id, m]));
    renderList();
    for (const id of state.monitors.keys()) state.socket?.emit('subscribe', id);
  }

  function renderList() {
    const ul = $('list');
    ul.replaceChildren();
    $('empty').hidden = state.monitors.size > 0;
    for (const m of state.monitors.values()) {
      const li = el('li', m.id === state.selected ? 'selected' : '');
      li.append(
        el('span', `dot ${m.current_status}`),
        el('span', 'name', m.name),
        el('span', 'muted', m.is_active ? `${m.interval_seconds}s` : 'paused'),
      );
      li.addEventListener('click', () => select(m.id));
      ul.append(li);
    }
  }

  async function select(id) {
    state.selected = id;
    renderList();
    const m = state.monitors.get(id);
    $('placeholder').hidden = true;
    $('detail').hidden = false;
    $('title').textContent = m.name;
    $('meta').textContent = `${m.method} ${m.url} · expects ${m.expected_status} · every ${m.interval_seconds}s`;
    await loadChecks();
  }

  async function loadChecks() {
    if (!state.selected) return;
    const id = state.selected;
    const rows = await api(`/monitors/${id}/checks?limit=${MAX_POINTS}`);
    if (id !== state.selected) return; // the user picked another monitor meanwhile
    state.checks = rows.reverse(); // the API returns newest first; charts read left to right
    renderChecks();
  }

  function renderChecks() {
    const fmt = (c) => new Date(c.checked_at).toLocaleTimeString();
    const labels = state.checks.map(fmt);
    const latency = state.checks.map((c) => c.latency_ms);
    const down = state.checks.map((c) => (c.status === 'down' ? 0 : null));

    if (!state.chart) {
      state.chart = new Chart($('chart'), {
        type: 'line',
        data: {
          labels,
          datasets: [
            { label: 'Latency (ms)', data: latency, borderColor: '#2f6fed', backgroundColor: '#2f6fed', tension: 0.25, pointRadius: 2, spanGaps: false },
            { label: 'Down', data: down, borderColor: '#d23b3b', backgroundColor: '#d23b3b', showLine: false, pointRadius: 5, pointStyle: 'crossRot' },
          ],
        },
        options: { maintainAspectRatio: false, animation: false, scales: { y: { beginAtZero: true } } },
      });
    } else {
      state.chart.data.labels = labels;
      state.chart.data.datasets[0].data = latency;
      state.chart.data.datasets[1].data = down;
      state.chart.update();
    }

    const tbody = $('rows');
    tbody.replaceChildren();
    for (const c of state.checks.slice(-20).reverse()) {
      const tr = el('tr');
      tr.append(
        el('td', '', fmt(c)),
        el('td', c.status, c.status),
        el('td', '', c.status_code ?? '-'),
        el('td', '', c.latency_ms == null ? '-' : `${c.latency_ms} ms`),
        el('td', 'muted', c.error_message || ''),
      );
      tbody.append(tr);
    }
  }

  function feed(text, cls) {
    const ul = $('feed');
    ul.prepend(el('li', cls, `${new Date().toLocaleTimeString()}  ${text}`));
    while (ul.children.length > 15) ul.lastChild.remove();
  }

  function connectSocket() {
    const socket = io({ auth: { token: state.key } });
    state.socket = socket;

    // Runs on the first connect and on every reconnect. Live events are fire-and-forget,
    // so anything missed while disconnected is recovered by re-reading over REST.
    socket.on('connect', async () => {
      setConn(true);
      try { await loadMonitors(); await loadChecks(); } catch (e) { /* signed out or rate limited */ }
    });
    socket.on('disconnect', () => setConn(false));
    socket.on('connect_error', (e) => { if (e.message === 'Unauthorized') signOut('That key was not accepted.'); });

    socket.on('check', (e) => {
      const m = state.monitors.get(e.monitorId);
      if (!m) return;
      m.current_status = e.status;
      renderList();
      if (e.monitorId === state.selected) {
        state.checks.push({ status: e.status, status_code: e.status_code, latency_ms: e.latency_ms, error_message: e.error_message, checked_at: e.checked_at });
        if (state.checks.length > MAX_POINTS) state.checks.shift();
        renderChecks();
      }
    });
    socket.on('incident', (e) => {
      const m = state.monitors.get(e.monitorId);
      const name = m ? m.name : 'a monitor';
      feed(e.event === 'opened' ? `${name} went DOWN` : `${name} recovered`, e.event === 'opened' ? 'down' : 'up');
    });
  }

  async function start() {
    show(true);
    try { await loadMonitors(); } catch (e) { if (state.key) $('empty').textContent = e.message; }
    if (state.key) connectSocket();
  }

  $('loginform').addEventListener('submit', (ev) => {
    ev.preventDefault();
    state.key = $('keyinput').value.trim();
    $('keyinput').value = '';
    $('error').textContent = '';
    sessionStorage.setItem('apiKey', state.key);
    start();
  });
  $('logout').addEventListener('click', () => signOut(''));

  const saved = sessionStorage.getItem('apiKey');
  if (saved) { state.key = saved; start(); }
})();
