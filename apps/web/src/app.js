'use strict';
(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const STORE = { server: 'digitalbots.serverUrl', theme: 'digitalbots.theme', compact: 'digitalbots.compact' };
  const isDesktop = Boolean(window.__TAURI_INTERNALS__) || location.protocol === 'tauri:' || location.hostname === 'tauri.localhost';
  let apiBase = localStorage.getItem(STORE.server) || (isDesktop ? '' : location.origin);
  let csrfToken = '';
  let currentUser = '';
  let currentPage = 'dashboard';
  let clientsCache = [];
  let allClientsForPayments = [];
  let clientPage = 1;
  let clientPageCount = 1;
  let clientSearchTimer = null;
  let dashboardData = null;
  let settingsCache = null;
  let currentEditingClient = null;
  let currentSubscription = null;

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const initials = (name) => String(name || 'DB').trim().split(/\s+/).slice(0, 2).map((part) => part[0] || '').join('').toUpperCase() || 'DB';
  const formatMoney = (amount, currency = 'EUR') => {
    const num = Number(amount || 0);
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(num); }
    catch { return `${num.toFixed(2)} ${currency}`; }
  };
  const formatCurrencyBreakdown = (rows, field) => {
    if (!rows?.length) return formatMoney(0, settingsCache?.settings?.currency || 'EUR');
    return rows.map((row) => formatMoney(row[field] || 0, row.currency)).join(' · ');
  };
  const formatDate = (value, withTime = false) => {
    if (!value) return '—';
    const date = new Date(String(value).replace(' ', 'T'));
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat(undefined, withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' }).format(date);
  };
  const dateInputValue = () => new Date().toISOString().slice(0, 10);
  const showToast = (message, type = 'success') => {
    const toast = document.createElement('div');
    toast.className = `toast ${type === 'error' ? 'error' : type === 'warning' ? 'warning' : ''}`;
    toast.textContent = message;
    $('#toast-region').appendChild(toast);
    window.setTimeout(() => toast.remove(), 4200);
  };
  const setMessage = (id, message, type = 'error') => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = message || '';
    el.style.color = type === 'success' ? 'var(--green)' : type === 'info' ? 'var(--muted)' : 'var(--red)';
  };
  const currentTheme = () => localStorage.getItem(STORE.theme) || 'light';
  function applyTheme(theme) {
    const value = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = value;
    localStorage.setItem(STORE.theme, value);
    $$('[data-set-theme]').forEach((button) => button.classList.toggle('active', button.dataset.setTheme === value));
  }
  function applyCompact(value) {
    document.documentElement.classList.toggle('compact', Boolean(value));
    localStorage.setItem(STORE.compact, value ? '1' : '0');
    const toggle = $('#compact-toggle');
    if (toggle) toggle.checked = Boolean(value);
  }
  function getBase() {
    if (!apiBase) throw new Error('Connect this desktop app to your main server in the connection screen.');
    return apiBase.replace(/\/+$/, '');
  }
  async function refreshCsrf() {
    const response = await fetch(`${getBase()}/api/csrf`, { credentials: 'include', headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('Could not initialize the secure session.');
    const data = await response.json();
    csrfToken = data.token || '';
    return csrfToken;
  }
  async function api(url, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const headers = new Headers(options.headers || {});
    headers.set('Accept', 'application/json');
    if (options.body && !(options.body instanceof FormData) && typeof options.body !== 'string') {
      headers.set('Content-Type', 'application/json');
      options = { ...options, body: JSON.stringify(options.body) };
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      if (!csrfToken) await refreshCsrf();
      headers.set('X-CSRF-Token', csrfToken);
    }
    let response;
    try {
      response = await fetch(`${getBase()}${url}`, { ...options, method, headers, credentials: 'include' });
    } catch (error) {
      throw new Error(`Cannot reach the DigitalBots server at ${getBase()}. Check the URL and server status.`);
    }
    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await response.json() : await response.text();
    if (!response.ok) {
      if (response.status === 401 && !url.startsWith('/api/auth/login') && !url.startsWith('/api/setup')) showAuth();
      const message = typeof data === 'object' && data ? data.error || data.message : data;
      const error = new Error(message || `Request failed (${response.status}).`);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }
  function showConnection() {
    $('#connection-screen').classList.remove('hidden');
    $('#auth-screen').classList.add('hidden');
    $('#app-shell').classList.add('hidden');
    $('#server-url').value = localStorage.getItem(STORE.server) || '';
  }
  function showAuth() {
    $('#connection-screen').classList.add('hidden');
    $('#auth-screen').classList.remove('hidden');
    $('#app-shell').classList.add('hidden');
  }
  function showApp() {
    $('#connection-screen').classList.add('hidden');
    $('#auth-screen').classList.add('hidden');
    $('#app-shell').classList.remove('hidden');
  }
  function configureAuthSetup(required) {
    const form = $('#login-form');
    const username = $('#login-username');
    const password = $('#login-password');
    const passLabel = password.closest('.form-field').querySelector('label');
    let confirm = $('#setup-confirm-wrap');
    if (required) {
      $('#setup-key-wrap').classList.remove('hidden');
      $('#setup-key').required = true;
      $('#login-password').minLength = 14;
      $('#auth-eyebrow').textContent = 'FIRST-TIME SETUP';
      $('#auth-title').textContent = 'Create your administrator';
      $('#auth-subtitle').textContent = 'Set a private password to secure this DigitalBots workspace.';
      passLabel.textContent = 'Create password';
      password.autocomplete = 'new-password';
      password.placeholder = 'At least 14 characters';
      username.value = 'digitalbots';
      username.readOnly = true;
      if (!confirm) {
        confirm = document.createElement('div');
        confirm.id = 'setup-confirm-wrap';
        confirm.className = 'form-field';
        confirm.innerHTML = '<label for="setup-confirm-password">Confirm password</label><input id="setup-confirm-password" type="password" required minlength="14" autocomplete="new-password" placeholder="Repeat your password">';
        form.insertBefore(confirm, $('#login-message'));
      }
      $('#login-submit').innerHTML = 'Create administrator <span>→</span>';
    } else {
      $('#setup-key-wrap').classList.add('hidden');
      $('#setup-key').required = false;
      $('#setup-key').value = '';
      $('#login-password').minLength = 0;
      $('#auth-eyebrow').textContent = 'WELCOME BACK';
      $('#auth-title').textContent = 'Sign in to your workspace';
      $('#auth-subtitle').textContent = 'Enter your administrator credentials to continue.';
      passLabel.textContent = 'Password';
      password.autocomplete = 'current-password';
      password.placeholder = 'Enter your password';
      username.readOnly = false;
      if (confirm) confirm.remove();
      $('#login-submit').innerHTML = 'Sign in <span>→</span>';
    }
    form.dataset.setup = required ? '1' : '0';
  }
  async function initialize() {
    applyTheme(currentTheme());
    applyCompact(localStorage.getItem(STORE.compact) === '1');
    $('#auth-year').textContent = String(new Date().getFullYear());
    $('#current-date').textContent = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date());
    if (!apiBase) { showConnection(); return; }
    try {
      await refreshCsrf();
      const health = await api('/api/health');
      if (!health.ok) throw new Error('The server health check failed.');
      const setup = await api('/api/setup/status');
      if (setup.setupRequired) {
        configureAuthSetup(true);
        showAuth();
        return;
      }
      configureAuthSetup(false);
      try {
        const me = await api('/api/me');
        csrfToken = me.csrfToken || csrfToken;
        currentUser = me.username;
        enterWorkspace();
      } catch (error) {
        showAuth();
      }
    } catch (error) {
      if (isDesktop && !localStorage.getItem(STORE.server)) { showConnection(); return; }
      showAuth();
      setMessage('login-message', error.message);
    }
  }
  function enterWorkspace() {
    $('#sidebar-username').textContent = currentUser;
    $('#topbar-username').textContent = currentUser;
    showApp();
    navigate('dashboard');
    loadDashboard();
  }

  function navigate(page) {
    const known = ['dashboard', 'clients', 'subscriptions', 'payments', 'discord', 'security', 'activity', 'reports', 'settings'];
    if (!known.includes(page)) return;
    currentPage = page;
    $$('.page-section').forEach((section) => section.classList.toggle('hidden', section.id !== `page-${page}`));
    $$('.nav-item[data-page]').forEach((button) => button.classList.toggle('active', button.dataset.page === page));
    const labels = { dashboard: 'Overview', clients: 'Clients', subscriptions: 'Subscriptions', payments: 'Payments', discord: 'Discord analytics', security: 'Security', activity: 'Activity log', reports: 'Reports', settings: 'Settings' };
    $('#topbar-page').textContent = labels[page];
    $('#sidebar').classList.remove('mobile-open');
    if (page === 'dashboard') loadDashboard();
    if (page === 'clients') loadClients(1);
    if (page === 'subscriptions') loadSubscriptions();
    if (page === 'payments') loadPayments();
    if (page === 'security') loadSecurity();
    if (page === 'activity') loadActivity();
    if (page === 'discord') loadDiscord();
    if (page === 'settings') loadSettings();
  }
  function statusBadge(status) {
    const map = {
      ACTIVE: ['status-active', 'Active'], EXPIRED: ['status-expired', 'Expired'], LIFETIME: ['status-lifetime', 'Lifetime'],
      PENDING: ['status-pending', 'Pending'], REJECTED: ['status-rejected', 'Rejected'], APPROVED: ['status-approved', 'Approved'],
      SUCCESS: ['status-success', 'Success'], PAID: ['status-active', 'Paid'], REFUNDED: ['status-rejected', 'Refunded'],
      NONE: ['status-none', 'No plan'], CANCELLED: ['status-rejected', 'Cancelled'], SUPERSEDED: ['status-none', 'Previous']
    };
    const [cls, label] = map[status] || ['status-none', String(status || 'Unknown')];
    return `<span class="status-pill ${cls}">${escapeHtml(label)}</span>`;
  }
  function planBadge(plan) {
    const cls = plan === 'Basic' ? 'plan-basic' : plan === 'Business' ? 'plan-business' : '';
    return `<span class="plan-pill ${cls}">${escapeHtml(plan || '—')}</span>`;
  }
  function renderRevenueChart(rows, currencyCode = 'EUR') {
    const host = $('#revenue-chart');
    if (!rows || !rows.length || rows.every((r) => Number(r.amount) === 0)) {
      host.innerHTML = '<div class="chart-empty">Your revenue chart will appear as payments are recorded.</div>';
      return;
    }
    const width = 660, height = 215, left = 30, right = 14, top = 14, bottom = 28;
    const plotW = width - left - right, plotH = height - top - bottom;
    const values = rows.map((r) => Math.max(0, Number(r.amount) || 0));
    const max = Math.max(1, ...values) * 1.15;
    const points = values.map((v, i) => ({ x: left + (rows.length === 1 ? plotW / 2 : i * plotW / (rows.length - 1)), y: top + plotH - (v / max) * plotH, value: v }));
    const line = points.map((p, i) => `${i ? 'L' : 'M'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
    const area = `${line} L ${points[points.length - 1].x} ${top + plotH} L ${points[0].x} ${top + plotH} Z`;
    const grid = [0, 1, 2, 3].map((i) => {
      const y = top + i * plotH / 3;
      return `<line class="chart-grid-line" x1="${left}" y1="${y}" x2="${width-right}" y2="${y}"/><text class="chart-axis-label" x="0" y="${y + 3}">${formatMoney(max * (1 - i / 3), currencyCode).replace(/[A-Z€£$]/g, '').trim()}</text>`;
    }).join('');
    const dots = points.map((p) => `<circle class="chart-dot" cx="${p.x}" cy="${p.y}" r="4"><title>${formatMoney(p.value, currencyCode)}</title></circle>`).join('');
    const labels = rows.map((r, i) => `<text class="chart-axis-label" text-anchor="middle" x="${points[i].x}" y="${height - 4}">${escapeHtml(r.label)}</text>`).join('');
    host.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Revenue over the last six months"><defs><linearGradient id="revenueFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--blue)" stop-opacity=".20"/><stop offset="1" stop-color="var(--blue)" stop-opacity="0"/></linearGradient></defs>${grid}<path class="chart-area" d="${area}"/><path class="chart-line" d="${line}"/>${dots}${labels}</svg>`;
  }
  function renderPlanChart(planStats) {
    const stats = ['Basic', 'Premium', 'Business'].map((name) => ({ name, value: Number((planStats || []).find((x) => x.plan === name)?.total || 0) }));
    const total = stats.reduce((sum, row) => sum + row.value, 0);
    const host = $('#plan-chart');
    if (!total) {
      host.innerHTML = '<div class="chart-empty">No active subscription data yet.</div>';
      $('#plan-legend').innerHTML = '';
      return;
    }
    const colors = ['#8f9bad', 'var(--blue)', 'var(--violet)'];
    const circumference = 2 * Math.PI * 49;
    let offset = 0;
    const segments = stats.map((row, i) => {
      const length = circumference * row.value / total;
      const markup = `<circle class="donut-segment" cx="75" cy="75" r="49" stroke="${colors[i]}" stroke-dasharray="${length} ${circumference - length}" stroke-dashoffset="${-offset}"/>`;
      offset += length;
      return markup;
    }).join('');
    host.innerHTML = `<svg viewBox="0 0 150 150" role="img" aria-label="Active subscriptions by plan"><circle class="donut-bg" cx="75" cy="75" r="49"/>${segments}<text class="donut-center" x="75" y="70">${total}</text><text class="donut-caption" x="75" y="88">ACTIVE</text></svg>`;
    $('#plan-legend').innerHTML = stats.map((row, i) => `<div class="legend-row"><span class="legend-dot" style="background:${colors[i]}"></span><span>${row.name}</span><b>${row.value}</b></div>`).join('');
  }
  async function loadDashboard() {
    try {
      dashboardData = await api('/api/dashboard');
      const d = dashboardData;
      $('#metric-revenue').textContent = formatCurrencyBreakdown(d.revenueByCurrency, 'total');
      $('#metric-month').textContent = `${formatCurrencyBreakdown(d.revenueByCurrency, 'month')} this month`;
      $('#metric-clients').textContent = Number(d.totalClients || 0).toLocaleString();
      $('#metric-new-clients').textContent = `${Number(d.newClientsThisMonth || 0)} new this month`;
      $('#metric-active').textContent = Number(d.activeClients || 0).toLocaleString();
      $('#metric-expired').textContent = `${Number(d.expiredSubscriptions || 0)} expired`;
      $('#metric-outstanding').textContent = formatCurrencyBreakdown(d.revenueByCurrency, 'outstanding');
      $('#metric-expiring').textContent = `${Number(d.expiringSoon || 0)} expiring soon`;
      $('#nav-clients').textContent = d.totalClients || 0;
      $('#nav-pending').textContent = d.pendingLogins || 0;
      renderRevenueChart(d.monthlyRevenue, d.chartCurrency || 'EUR');
      renderPlanChart(d.planStats);
      $('#dashboard-clients').innerHTML = d.recentClients?.length ? `<table class="data-table"><thead><tr><th>Client</th><th>Plan</th><th>Status</th><th>Paid</th></tr></thead><tbody>${d.recentClients.map((c) => `<tr><td><div class="cell-primary"><span class="client-avatar">${escapeHtml(initials(c.irl_name))}</span><span class="client-cell-copy"><b>${escapeHtml(c.irl_name)}</b><small>${escapeHtml(c.discord_name)}</small></span></div></td><td>${planBadge(c.plan)}</td><td>${statusBadge(c.subscription_status)}</td><td><strong>${formatMoney(c.amount_paid)}</strong></td></tr>`).join('')}</tbody></table>` : '<div class="table-empty">No clients yet. Add your first client to get started.</div>';
      $('#dashboard-payments').innerHTML = d.recentPayments?.length ? d.recentPayments.map((p) => `<div class="mini-payment"><span class="mini-payment-icon">↗</span><span class="mini-payment-copy"><b>${escapeHtml(p.discord_name)}</b><small>${formatDate(p.payment_date)} · ${escapeHtml(p.method)}</small></span><span class="mini-payment-amount">${formatMoney(p.amount, p.currency)}</span></div>`).join('') : '<div class="table-empty">No payments recorded yet.</div>';
      $('#last-refresh').textContent = `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    } catch (error) { showToast(error.message, 'error'); }
  }

  function clientTable(rows) {
    if (!rows.length) return '<div class="table-empty">No matching clients. Adjust your filters or create a client.</div>';
    return `<table class="data-table"><thead><tr><th>Client</th><th>Discord ID</th><th>Plan</th><th>Subscription</th><th>Amount paid</th><th>Actions</th></tr></thead><tbody>${rows.map((c) => `<tr data-client-row="${c.id}"><td><div class="cell-primary"><span class="client-avatar">${escapeHtml(initials(c.irl_name))}</span><span class="client-cell-copy"><b>${escapeHtml(c.irl_name)}</b><small>${escapeHtml(c.discord_name)}</small></span></div></td><td><strong>${escapeHtml(c.discord_id)}</strong></td><td>${planBadge(c.plan)}</td><td>${statusBadge(c.subscription_status)}</td><td><strong>${formatMoney(c.amount_paid, c.currency || 'EUR')}</strong></td><td><div class="row-actions"><button class="table-action" data-client-action="view" data-id="${c.id}" title="View client">↗</button><button class="table-action" data-client-action="edit" data-id="${c.id}" title="Edit client">✎</button><button class="table-action" data-client-action="payment" data-id="${c.id}" title="Record payment">＋</button><button class="table-action danger" data-client-action="delete" data-id="${c.id}" title="Delete client">×</button></div></td></tr>`).join('')}</tbody></table>`;
  }
  async function loadClients(page = clientPage) {
    clientPage = page;
    const query = new URLSearchParams({ page: String(page), pageSize: '25', search: $('#client-search').value || '', plan: $('#client-plan-filter').value || '', status: $('#client-status-filter').value || '' });
    $('#clients-table').innerHTML = '<div class="loading-row">Loading client records…</div>';
    try {
      const result = await api(`/api/clients?${query.toString()}`);
      clientsCache = result.rows || [];
      clientPageCount = result.pages || 1;
      $('#clients-table').innerHTML = clientTable(clientsCache);
      $('#client-count-label').textContent = result.total;
      $('#client-pagination-label').textContent = result.total ? `Page ${result.page} of ${result.pages} · ${result.total} clients` : 'Showing 0 clients';
      $('#client-prev').disabled = result.page <= 1;
      $('#client-next').disabled = result.page >= result.pages;
      $('#nav-clients').textContent = result.total;
    } catch (error) { $('#clients-table').innerHTML = `<div class="table-empty">${escapeHtml(error.message)}</div>`; }
  }
  function openDialog(id) { const dialog = document.getElementById(id); if (dialog && !dialog.open) dialog.showModal(); }
  function closeDialog(id) { const dialog = document.getElementById(id); if (dialog?.open) dialog.close(); }
  function setClientPlanPrice(plan) {
    const key = plan === 'Basic' ? 'basicPrice' : plan === 'Premium' ? 'premiumPrice' : 'businessPrice';
    if (settingsCache?.settings?.[key] !== undefined) $('#client-price').value = Number(settingsCache.settings[key]).toFixed(2);
  }
  function openClientDialog(client = null) {
    currentEditingClient = client;
    $('#client-form').reset();
    $('#edit-client-id').value = client?.id || '';
    $('#client-dialog-title').textContent = client ? 'Edit client' : 'Create client';
    $('#client-start-date').value = client?.started_at ? String(client.started_at).slice(0, 10) : dateInputValue();
    $('#client-discord-name').value = client?.discord_name || '';
    $('#client-discord-id').value = client?.discord_id || '';
    $('#client-irl-name').value = client?.irl_name || '';
    $('#client-invite').value = client?.discord_invite_url || '';
    $('#client-notes').value = client?.notes || '';
    $('#client-plan').value = client?.plan || 'Basic';
    $('#client-duration').value = client?.duration || '1 Month';
    $('#client-price').value = Number(client?.price || (settingsCache?.settings?.basicPrice || 0)).toFixed(2);
    $('#client-currency').value = client?.currency || settingsCache?.settings?.currency || 'EUR';
    $('#client-amount-paid').value = '0.00';
    $('#client-custom-end').value = client?.expires_at ? String(client.expires_at).slice(0,10) : '';
    $('#client-form-message').textContent = '';
    $('#initial-paid-field').classList.toggle('hidden', Boolean(client));
    $('#edit-subscription-toggle-row').classList.toggle('hidden', !client);
    $('#edit-subscription-toggle').checked = false;
    $('#subscription-fields').classList.toggle('hidden', Boolean(client));
    $('#custom-end-field').classList.toggle('hidden', $('#client-duration').value !== 'Custom');
    openDialog('client-dialog');
  }
  function subscriptionToggle() {
    $('#subscription-fields').classList.toggle('hidden', !$('#edit-subscription-toggle').checked);
  }
  async function submitClient(event) {
    event.preventDefault();
    const editing = Boolean($('#edit-client-id').value);
    const body = {
      discordName: $('#client-discord-name').value,
      discordId: $('#client-discord-id').value,
      irlName: $('#client-irl-name').value,
      discordInviteUrl: $('#client-invite').value,
      notes: $('#client-notes').value
    };
    const addSubscription = !editing || $('#edit-subscription-toggle').checked;
    if (addSubscription) {
      body.plan = $('#client-plan').value;
      body.duration = $('#client-duration').value;
      body.startDate = $('#client-start-date').value;
      body.customEndDate = $('#client-custom-end').value;
      body.price = $('#client-price').value;
      body.currency = $('#client-currency').value;
      if (editing) body.updateSubscription = true;
      else {
        body.amountPaid = $('#client-amount-paid').value;
        body.paymentMethod = 'Other';
      }
    }
    const button = $('#client-save-button');
    button.disabled = true;
    button.textContent = 'Saving…';
    try {
      if (editing) await api(`/api/clients/${encodeURIComponent($('#edit-client-id').value)}`, { method: 'PUT', body });
      else await api('/api/clients', { method: 'POST', body });
      closeDialog('client-dialog');
      showToast(editing ? 'Client updated successfully.' : 'Client created successfully.');
      await Promise.all([loadClients(clientPage), loadDashboard()]);
    } catch (error) { setMessage('client-form-message', error.message); }
    finally { button.disabled = false; button.textContent = 'Save client'; }
  }
  function openPaymentDialog(clientId = '') {
    $('#payment-form').reset();
    $('#payment-date').value = dateInputValue();
    $('#payment-currency').value = settingsCache?.settings?.currency || 'EUR';
    $('#payment-client').innerHTML = '<option value="">Loading clients…</option>';
    openDialog('payment-dialog');
    api('/api/clients?page=1&pageSize=100').then((result) => {
      allClientsForPayments = result.rows || [];
      $('#payment-client').innerHTML = '<option value="">Choose a client</option>' + allClientsForPayments.map((c) => `<option value="${c.id}">${escapeHtml(c.irl_name)} · ${escapeHtml(c.discord_name)}</option>`).join('');
      if (clientId) $('#payment-client').value = String(clientId);
    }).catch((error) => setMessage('payment-form-message', error.message));
  }
  async function submitPayment(event) {
    event.preventDefault();
    const body = { clientId: $('#payment-client').value, amount: $('#payment-amount').value, currency: $('#payment-currency').value, paymentDate: $('#payment-date').value, method: $('#payment-method').value, status: $('#payment-status').value, description: $('#payment-description').value };
    try {
      await api('/api/payments', { method: 'POST', body });
      closeDialog('payment-dialog');
      showToast('Payment recorded successfully.');
      await Promise.all([loadPayments(), loadDashboard(), loadClients(clientPage)]);
    } catch (error) { setMessage('payment-form-message', error.message); }
  }
  function showDetail(client) {
    $('#detail-content').innerHTML = `<div class="dialog-header"><div><p class="eyebrow">CLIENT PROFILE</p><h2>${escapeHtml(client.irl_name)}</h2><p class="muted">${escapeHtml(client.discord_name)} · ${escapeHtml(client.discord_id)}</p></div><button class="dialog-close" type="button" data-close-dialog="detail-dialog">×</button></div><div class="detail-list"><div class="detail-item"><small>Plan</small><b>${escapeHtml(client.plan || '—')}</b></div><div class="detail-item"><small>Subscription status</small><b>${escapeHtml(client.subscription_status || '—')}</b></div><div class="detail-item"><small>Start date</small><b>${formatDate(client.started_at)}</b></div><div class="detail-item"><small>Expiration</small><b>${client.expires_at ? formatDate(client.expires_at) : 'Lifetime / none'}</b></div><div class="detail-item"><small>Amount received</small><b>${formatMoney(client.amount_paid, client.currency || 'EUR')}</b></div><div class="detail-item"><small>Subscription price</small><b>${formatMoney(client.price, client.currency || 'EUR')}</b></div><div class="detail-item"><small>Discord invite</small><b>${client.discord_invite_url ? `<a href="${escapeHtml(client.discord_invite_url)}" target="_blank" rel="noopener">Open invite ↗</a>` : '—'}</b></div><div class="detail-item"><small>Created</small><b>${formatDate(client.created_at, true)}</b></div></div><div class="setting-note"><b>Internal notes</b><p>${escapeHtml(client.notes || 'No notes saved.')}</p></div>`;
    openDialog('detail-dialog');
  }
  async function handleClientAction(event) {
    const button = event.target.closest('[data-client-action]');
    if (!button) return;
    const client = clientsCache.find((item) => String(item.id) === button.dataset.id);
    if (!client) return;
    const action = button.dataset.clientAction;
    if (action === 'view') showDetail(client);
    if (action === 'edit') openClientDialog(client);
    if (action === 'payment') openPaymentDialog(client.id);
    if (action === 'delete') {
      if (!window.confirm(`Archive ${client.irl_name}? The client will be hidden from the active register. Payment and subscription history will be retained.`)) return;
      try {
        await api(`/api/clients/${client.id}`, { method: 'DELETE' });
        showToast('Client archived. Financial history retained.');
        await Promise.all([loadClients(clientPage), loadDashboard()]);
      } catch (error) { showToast(error.message, 'error'); }
    }
  }

  async function loadSubscriptions() {
    try {
      const rows = await api('/api/subscriptions');
      const active = rows.filter((r) => r.display_status === 'ACTIVE').length;
      const expiring = rows.filter((r) => r.display_status === 'ACTIVE' && r.expires_at && new Date(r.expires_at).getTime() <= Date.now() + 30 * 86400000).length;
      const lifetime = rows.filter((r) => r.display_status === 'LIFETIME').length;
      $('#sub-active-count').textContent = active;
      $('#sub-expiring-count').textContent = expiring;
      $('#sub-lifetime-count').textContent = lifetime;
      const filter = $('#subscription-filter').value;
      const filtered = filter ? rows.filter((r) => r.display_status === filter) : rows;
      $('#subscriptions-table').innerHTML = filtered.length ? `<table class="data-table"><thead><tr><th>Client</th><th>Plan</th><th>Duration</th><th>Started</th><th>Expires</th><th>Price</th><th>Status</th><th>Action</th></tr></thead><tbody>${filtered.map((s) => `<tr><td><div class="client-cell-copy"><b>${escapeHtml(s.irl_name)}</b><small>${escapeHtml(s.discord_name)}</small></div></td><td>${planBadge(s.plan)}</td><td>${escapeHtml(s.duration)}</td><td>${formatDate(s.started_at)}</td><td>${s.expires_at ? formatDate(s.expires_at) : 'Never'}</td><td><strong>${formatMoney(s.price,s.currency)}</strong></td><td>${statusBadge(s.display_status)}</td><td><button class="button button-secondary" style="min-height:29px;padding:0 10px;font-size:8px" data-sub-extend="${s.id}" data-sub-plan="${escapeHtml(s.plan)}" data-sub-duration="${escapeHtml(s.duration)}" data-sub-price="${s.price}" data-sub-currency="${s.currency}" data-sub-client="${escapeHtml(s.discord_name)}">Extend</button></td></tr>`).join('')}</tbody></table>` : '<div class="table-empty">No subscriptions match this filter.</div>';
    } catch (error) { $('#subscriptions-table').innerHTML = `<div class="table-empty">${escapeHtml(error.message)}</div>`; }
  }
  function openExtendDialog(button) {
    currentSubscription = button.dataset.subExtend;
    $('#extend-subscription-id').value = currentSubscription;
    $('#subscription-dialog-client').textContent = `Extend the subscription for ${button.dataset.subClient}.`;
    $('#extend-plan').value = button.dataset.subPlan;
    $('#extend-duration').value = button.dataset.subDuration;
    $('#extend-start').value = dateInputValue();
    $('#extend-price').value = Number(button.dataset.subPrice || 0).toFixed(2);
    $('#extend-currency').value = button.dataset.subCurrency || 'EUR';
    $('#extend-custom-field').classList.toggle('hidden', $('#extend-duration').value !== 'Custom');
    $('#subscription-form-message').textContent = '';
    openDialog('subscription-dialog');
  }
  async function submitExtension(event) {
    event.preventDefault();
    try {
      await api(`/api/subscriptions/${encodeURIComponent($('#extend-subscription-id').value)}/extend`, { method: 'POST', body: { plan: $('#extend-plan').value, duration: $('#extend-duration').value, startDate: $('#extend-start').value, customEndDate: $('#extend-custom-end').value, price: $('#extend-price').value, currency: $('#extend-currency').value } });
      closeDialog('subscription-dialog');
      showToast('Subscription extension saved.');
      await Promise.all([loadSubscriptions(), loadDashboard()]);
    } catch (error) { setMessage('subscription-form-message', error.message); }
  }
  async function loadPayments() {
    try {
      const [rows, d] = await Promise.all([api('/api/payments'), api('/api/dashboard')]);
      $('#payments-received').textContent = formatCurrencyBreakdown(d.revenueByCurrency, 'total');
      $('#payments-pending').textContent = formatCurrencyBreakdown(d.revenueByCurrency, 'outstanding');
      $('#payments-count').textContent = rows.length;
      $('#payments-table').innerHTML = rows.length ? `<table class="data-table"><thead><tr><th>Client</th><th>Amount</th><th>Method</th><th>Date</th><th>Status</th><th>Description</th></tr></thead><tbody>${rows.map((p) => `<tr><td><div class="client-cell-copy"><b>${escapeHtml(p.discord_name)}</b><small>ID ${p.client_id}</small></div></td><td><strong>${formatMoney(p.amount,p.currency)}</strong></td><td>${escapeHtml(p.method)}</td><td>${formatDate(p.payment_date)}</td><td>${statusBadge(p.status)}</td><td>${escapeHtml(p.description || '—')}</td></tr>`).join('')}</tbody></table>` : '<div class="table-empty">No payments have been recorded yet.</div>';
    } catch (error) { $('#payments-table').innerHTML = `<div class="table-empty">${escapeHtml(error.message)}</div>`; }
  }

  async function loadSecurity() {
    try {
      const data = await api('/api/security');
      $('#nav-pending').textContent = data.pending.length;
      $('#pending-count').textContent = data.pending.length;
      $('#pending-table').innerHTML = data.pending.length ? `<table class="data-table"><thead><tr><th>Username</th><th>IP address</th><th>Device / browser</th><th>Attempted</th><th>Decision</th></tr></thead><tbody>${data.pending.map((p) => `<tr><td><strong>${escapeHtml(p.username)}</strong></td><td><strong>${escapeHtml(p.ip_address)}</strong></td><td>${escapeHtml(p.user_agent || 'Unknown device').slice(0,80)}</td><td>${formatDate(p.attempted_at,true)}</td><td><div class="approval-actions"><button class="approve-button" data-ip-action="approve" data-id="${p.id}" title="Approve IP">✓</button><button class="reject-button" data-ip-action="reject" data-id="${p.id}" title="Reject and block IP">×</button></div></td></tr>`).join('')}</tbody></table>` : '<div class="table-empty">No pending login requests. New network sign-ins will appear here.</div>';
      $('#trusted-table').innerHTML = data.trusted.length ? `<table class="data-table"><thead><tr><th>IP address</th><th>Status</th><th>Note</th><th>Last seen</th><th>Action</th></tr></thead><tbody>${data.trusted.map((ip) => `<tr><td><strong>${escapeHtml(ip.ip_address)}</strong></td><td>${statusBadge(ip.status)}</td><td>${escapeHtml(ip.note || '—')}</td><td>${formatDate(ip.last_seen,true)}</td><td>${ip.status === 'TRUSTED' ? `<button class="table-action danger" data-remove-ip="${ip.id}" title="Remove trusted IP">×</button>` : '—'}</td></tr>`).join('')}</tbody></table>` : '<div class="table-empty">No network addresses recorded yet.</div>';
      $('#login-history-table').innerHTML = data.logs.length ? `<table class="data-table"><thead><tr><th>User</th><th>IP</th><th>Status</th><th>Device</th><th>Time</th></tr></thead><tbody>${data.logs.map((l) => `<tr><td><strong>${escapeHtml(l.username)}</strong></td><td>${escapeHtml(l.ip_address)}</td><td>${statusBadge(l.status)}</td><td>${escapeHtml(l.user_agent || '—').slice(0,70)}</td><td>${formatDate(l.attempted_at,true)}</td></tr>`).join('')}</tbody></table>` : '<div class="table-empty">No login events yet.</div>';
    } catch (error) { showToast(error.message, 'error'); }
  }
  async function handleSecurityAction(event) {
    const decision = event.target.closest('[data-ip-action]');
    const remove = event.target.closest('[data-remove-ip]');
    if (decision) {
      const approve = decision.dataset.ipAction === 'approve';
      if (!approve && !window.confirm('Reject this login and block the IP address?')) return;
      try { await api(`/api/security/${decision.dataset.id}/${approve ? 'approve' : 'reject'}`, { method: 'POST', body: {} }); showToast(approve ? 'IP address approved.' : 'IP address blocked.'); await loadSecurity(); }
      catch (error) { showToast(error.message, 'error'); }
    }
    if (remove) {
      if (!window.confirm('Remove this trusted IP? The next valid login from it will require approval.')) return;
      try { await api(`/api/security/trusted/${remove.dataset.removeIp}`, { method: 'DELETE' }); showToast('Trusted IP removed.'); await loadSecurity(); }
      catch (error) { showToast(error.message, 'error'); }
    }
  }
  async function loadActivity() {
    try {
      const rows = await api('/api/activity');
      $('#activity-list').innerHTML = rows.length ? rows.map((r) => `<div class="activity-item"><span class="activity-marker">${r.action.includes('PAYMENT') ? '↗' : r.action.includes('CLIENT') ? '♙' : r.action.includes('IP') ? '⌑' : '≋'}</span><span class="activity-copy"><b>${escapeHtml(r.action.replaceAll('_',' '))}</b><p>${escapeHtml(r.details)}</p><small>${escapeHtml(r.actor)} · ${formatDate(r.created_at,true)}</small></span></div>`).join('') : '<div class="table-empty">No activity has been recorded yet.</div>';
    } catch (error) { $('#activity-list').innerHTML = `<div class="table-empty">${escapeHtml(error.message)}</div>`; }
  }
  async function loadDiscord() {
    try {
      const d = await api('/api/discord/stats');
      $('#discord-total').textContent = d.total === null ? '—' : Number(d.total).toLocaleString();
      $('#discord-online').textContent = d.online === null ? '—' : Number(d.online).toLocaleString();
      $('#discord-offline').textContent = d.offline === null ? '—' : Number(d.offline).toLocaleString();
      $('#discord-growth').textContent = d.growthLastMonth === null ? '—' : `${Number(d.growthLastMonth) > 0 ? '+' : ''}${Number(d.growthLastMonth)}`;
      const state = $('#discord-state');
      state.className = `integration-state ${d.connected ? 'connected' : d.configured ? 'offline' : ''}`;
      state.innerHTML = `<i></i> ${d.connected ? 'Connected' : d.configured ? 'Disconnected' : 'Not configured'}`;
      $('#discord-connection-label').textContent = d.connected ? 'Live data available' : 'Connection unavailable';
      $('#discord-error').textContent = d.connected ? 'Membership snapshots are saved every six hours. Thirty-day growth is available after a full 30-day baseline.' : (d.error || 'Configure the bot token on your main server to enable live analytics.');
      $('#discord-top-inviter').innerHTML = d.topInviter ? `<div class="inviter-avatar">♛</div><div class="inviter-copy"><b>${escapeHtml(d.topInviter.name)}</b><small>${Number(d.topInviter.uses)} tracked invite uses</small></div>` : '<div class="empty-state">Top inviter data is unavailable until invite tracking is enabled.</div>';
      $('#settings-discord-status').textContent = d.connected ? 'Connected' : d.configured ? 'Bot configured · disconnected' : 'Not configured';
    } catch (error) { $('#discord-error').textContent = error.message; }
  }
  async function loadSettings() {
    try {
      settingsCache = await api('/api/settings');
      const s = settingsCache.settings;
      $('#idle-timeout').value = String(s.idleTimeoutHours || 6);
      $('#basic-price').value = s.basicPrice;
      $('#premium-price').value = s.premiumPrice;
      $('#business-price').value = s.businessPrice;
      $('#settings-currency').value = s.currency;
      $('#settings-server-url').textContent = apiBase || 'Current web origin';
      $('#settings-server-input').value = apiBase || '';
      $('#settings-server-status').textContent = 'Connected';
      $('#settings-server-status').className = 'status-pill status-active';
      $('#compact-toggle').checked = localStorage.getItem(STORE.compact) === '1';
      applyTheme(currentTheme());
    } catch (error) { showToast(error.message, 'error'); }
  }
  async function saveSettings(body) {
    await api('/api/settings', { method: 'PATCH', body });
    showToast('Settings saved.');
    settingsCache = null;
    await loadSettings();
  }
  async function downloadReport(event) {
    const link = event.target.closest('[data-download-report]');
    if (!link) return;
    event.preventDefault();
    try {
      const response = await fetch(`${getBase()}${link.getAttribute('href')}`, { credentials: 'include' });
      if (!response.ok) throw new Error('Export could not be downloaded. Please sign in again.');
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = objectUrl; a.download = link.href.includes('payments') ? 'digitalbots-payments.csv' : 'digitalbots-clients.csv'; a.click(); URL.revokeObjectURL(objectUrl);
    } catch (error) { showToast(error.message, 'error'); }
  }
  async function logout() {
    try { await api('/api/auth/logout', { method: 'POST', body: {} }); } catch { /* A disconnected server still ends the local view. */ }
    csrfToken = ''; currentUser = ''; configureAuthSetup(false); showAuth();
    $('#login-form').reset(); $('#login-username').value = 'digitalbots';
  }

  // Event wiring
  $('#connect-server-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const raw = $('#server-url').value.trim().replace(/\/+$/, '');
    let url;
    try { url = new URL(raw); } catch { $('#connect-status').textContent = 'Enter a valid server URL.'; return; }
    if (!['https:', 'http:'].includes(url.protocol) || (url.protocol === 'http:' && !['localhost','127.0.0.1'].includes(url.hostname))) {
      $('#connect-status').textContent = 'Production server connections must use HTTPS.'; return;
    }
    $('#connect-status').textContent = 'Checking server connection…';
    try {
      const response = await fetch(`${raw}/api/health`, { credentials: 'include' });
      if (!response.ok) throw new Error('The server returned an error.');
      const result = await response.json();
      if (!result.ok || result.application !== 'DigitalBots') throw new Error('This address is not a DigitalBots server.');
      localStorage.setItem(STORE.server, raw); location.reload();
    } catch (error) { $('#connect-status').textContent = error.message || 'Could not connect to this server.'; }
  });
  $('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    setMessage('login-message', '');
    const setup = $('#login-form').dataset.setup === '1';
    const username = $('#login-username').value.trim();
    const password = $('#login-password').value;
    if (setup && password !== $('#setup-confirm-password').value) { setMessage('login-message', 'The passwords do not match.'); return; }
    const button = $('#login-submit'); button.disabled = true; button.textContent = setup ? 'Creating…' : 'Signing in…';
    try {
      const payload = { username, password };
      if (setup) payload.setupKey = $('#setup-key').value;
      const result = await api(setup ? '/api/setup' : '/api/auth/login', { method: 'POST', body: payload });
      if (result.pending) { setMessage('login-message', result.message); return; }
      csrfToken = result.csrfToken || csrfToken;
      currentUser = result.username || username;
      configureAuthSetup(false);
      enterWorkspace();
    } catch (error) { setMessage('login-message', error.message); }
    finally { button.disabled = false; button.innerHTML = setup ? 'Create administrator <span>→</span>' : 'Sign in <span>→</span>'; }
  });
  $('#auth-theme-toggle').addEventListener('click', () => applyTheme(currentTheme() === 'dark' ? 'light' : 'dark'));
  $('#theme-toggle').addEventListener('click', () => applyTheme(currentTheme() === 'dark' ? 'light' : 'dark'));
  $$('[data-toggle-password]').forEach((button) => button.addEventListener('click', () => {
    const input = document.getElementById(button.dataset.togglePassword);
    input.type = input.type === 'password' ? 'text' : 'password';
    button.textContent = input.type === 'password' ? 'Show' : 'Hide';
  }));
  $$('.nav-item[data-page]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.page)));
  document.body.addEventListener('click', (event) => {
    const go = event.target.closest('[data-go-page]'); if (go) navigate(go.dataset.goPage);
    const openClient = event.target.closest('[data-open-client]'); if (openClient) openClientDialog();
    const openPayment = event.target.closest('[data-open-payment]'); if (openPayment) openPaymentDialog();
    const close = event.target.closest('[data-close-dialog]'); if (close) closeDialog(close.dataset.closeDialog);
    const report = event.target.closest('[data-download-report]'); if (report) downloadReport(event);
  });
  $('#sidebar-collapse').addEventListener('click', () => document.body.classList.toggle('sidebar-collapsed'));
  $('#mobile-menu').addEventListener('click', () => $('#sidebar').classList.toggle('mobile-open'));
  $('#sidebar-logout').addEventListener('click', logout);
  $('#topbar-user').addEventListener('click', logout);
  $('#client-form').addEventListener('submit', submitClient);
  $('#client-duration').addEventListener('change', () => $('#custom-end-field').classList.toggle('hidden', $('#client-duration').value !== 'Custom'));
  $('#client-plan').addEventListener('change', () => setClientPlanPrice($('#client-plan').value));
  $('#edit-subscription-toggle').addEventListener('change', subscriptionToggle);
  $('#client-search').addEventListener('input', () => { window.clearTimeout(clientSearchTimer); clientSearchTimer = window.setTimeout(() => loadClients(1), 260); });
  $('#client-plan-filter').addEventListener('change', () => loadClients(1));
  $('#client-status-filter').addEventListener('change', () => loadClients(1));
  $('#client-prev').addEventListener('click', () => loadClients(Math.max(1, clientPage - 1)));
  $('#client-next').addEventListener('click', () => loadClients(Math.min(clientPageCount, clientPage + 1)));
  $('#clients-table').addEventListener('click', handleClientAction);
  $('#payment-form').addEventListener('submit', submitPayment);
  $('#payments-table').addEventListener('click', () => {});
  $('#subscription-filter').addEventListener('change', loadSubscriptions);
  $('#subscriptions-table').addEventListener('click', (event) => { const button = event.target.closest('[data-sub-extend]'); if (button) openExtendDialog(button); });
  $('#extend-duration').addEventListener('change', () => $('#extend-custom-field').classList.toggle('hidden', $('#extend-duration').value !== 'Custom'));
  $('#subscription-form').addEventListener('submit', submitExtension);
  $('#page-security').addEventListener('click', handleSecurityAction);
  $$('[data-settings-tab]').forEach((button) => button.addEventListener('click', () => {
    $$('[data-settings-tab]').forEach((b) => b.classList.toggle('active', b === button));
    $$('.settings-pane').forEach((pane) => pane.classList.toggle('hidden', pane.id !== `settings-${button.dataset.settingsTab}`));
  }));
  $$('[data-set-theme]').forEach((button) => button.addEventListener('click', () => applyTheme(button.dataset.setTheme)));
  $('#compact-toggle').addEventListener('change', (event) => applyCompact(event.target.checked));
  $('#save-appearance').addEventListener('click', () => { applyCompact($('#compact-toggle').checked); showToast('Appearance preferences saved.'); });
  $('#save-idle-timeout').addEventListener('click', () => saveSettings({ idleTimeoutHours: Number($('#idle-timeout').value) }).catch((e) => showToast(e.message, 'error')));
  $('#plans-form').addEventListener('submit', (event) => {
    event.preventDefault();
    saveSettings({ basicPrice: $('#basic-price').value, premiumPrice: $('#premium-price').value, businessPrice: $('#business-price').value, currency: $('#settings-currency').value }).catch((e) => showToast(e.message, 'error'));
  });
  $('#password-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if ($('#new-password').value !== $('#confirm-password').value) { showToast('New passwords do not match.', 'error'); return; }
    try { await api('/api/auth/change-password', { method: 'POST', body: { currentPassword: $('#current-password').value, newPassword: $('#new-password').value } }); $('#password-form').reset(); showToast('Password updated.'); }
    catch (error) { showToast(error.message, 'error'); }
  });
  $('#server-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const raw = $('#settings-server-input').value.trim().replace(/\/+$/, '');
    let url; try { url = new URL(raw); } catch { showToast('Enter a valid server URL.', 'error'); return; }
    if (url.protocol !== 'https:' && !['localhost','127.0.0.1'].includes(url.hostname)) { showToast('Production servers must use HTTPS.', 'error'); return; }
    if (!window.confirm('Change the server for this desktop/browser installation? You will be signed out.')) return;
    localStorage.setItem(STORE.server, raw); location.reload();
  });
  $('#test-discord').addEventListener('click', async () => { try { const result = await api('/api/discord/test', { method: 'POST', body: {} }); showToast(result.ok ? 'Discord bot is connected.' : 'Discord is not connected.', result.ok ? 'success' : 'warning'); await loadDiscord(); } catch (error) { showToast(error.message, 'error'); } });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') $('#sidebar').classList.remove('mobile-open'); });

  initialize();
})();
