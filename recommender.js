/**
 * Page logic for both recommender pages:
 *   allocation-recommender.html (index.html live) - standard orders
 *   hellofresh.html                               - HelloFresh 40-carton orders
 *   jbs.html                                      - JBS Pork (standard rules +
 *                                                   blast zone / 80-hour rules)
 * Which one is running comes from <body data-mode="hellofresh|jbs">. The
 * HelloFresh panels only exist on that page, so everything touching them is
 * behind HF. The JBS page is live-stock only (its rules need the zone and
 * scan-in time, which the ULD export doesn't carry), so it has no file panels.
 */
(function () {
  'use strict';

  var MODE = document.body.getAttribute('data-mode') || 'standard';
  var HF = MODE === 'hellofresh', JBS = MODE === 'jbs';

  if (typeof StockChecks === 'undefined' || typeof AllocationRecommender === 'undefined') {
    document.getElementById('banner').className = 'banner error';
    document.getElementById('banner').textContent =
      'checks.js and allocation.js did not load. Keep this file alongside them.';
    return;
  }

  var SC = StockChecks, AR = AllocationRecommender;
  var $ = function (id) { return document.getElementById(id); };

  // cartonDates: from the optional Detailed export, HelloFresh orders only.
  var state = { stockRows: [], cartonDates: null };
  var lines = [];       // { id, itemCode, metric, qty, result }
  var nextLineId = 1;

  // Daily export counter on the LCS Hub (hub.lavertoncs.com.au, Usage panel).
  // Anonymous "+1, standard or HelloFresh" - no order data leaves the page.
  // Fire-and-forget: no-cors + text/plain means no preflight, and a failure
  // (offline, hub down) never gets in the way of the download.
  var HUB_COUNT_URL = window.LCS_HUB_COUNT_URL || 'https://hub.lavertoncs.com.au/api/count';
  function countExport() {
    try {
      fetch(HUB_COUNT_URL, {
        method: 'POST', mode: 'no-cors', keepalive: true, credentials: 'omit',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ tool: HF ? 'allocation-hf' : 'allocation' })
      }).catch(function () {});
    } catch (e) { /* never block the export */ }
  }

  function setBanner(kind, text) {
    var b = $('banner');
    b.className = 'banner ' + kind;
    b.textContent = text;
  }

  function readFileAsText(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(reader.error || new Error('Could not read ' + file.name)); };
      reader.readAsText(file);
    });
  }

  function loadFromFiles() {
    var stockFile = $('stockFileInput').files[0];
    if (!stockFile) {
      $('fileLoadStatus').textContent = 'Choose a stock on hand CSV first.';
      return;
    }
    $('fileLoadStatus').textContent = 'Reading ' + stockFile.name + '…';

    readFileAsText(stockFile).then(function (text) {
      var parsed = SC.parseStockText(text);
      state.stockRows = parsed.rows;

      var missing = Object.keys(SC.STOCK_ALIASES).filter(function (f) { return parsed.mapping[f] === undefined; });
      $('fileDiagWrap').hidden = false;
      $('fileDiagOut').textContent =
        'Columns in file: ' + parsed.headers.join(', ') + '\n\n' +
        'Recognised: ' + Object.keys(parsed.mapping).join(', ') + '\n\n' +
        (missing.length ? 'Not found (checks needing these are skipped): ' + missing.join(', ') : 'All known fields found.');

      setBanner('live', 'Loaded from file - ' + state.stockRows.length + ' stock rows (' + stockFile.name + ').');
      $('sourceLine').textContent = 'File: ' + stockFile.name;
      $('fileLoadStatus').textContent = 'Loaded ' + new Date().toLocaleTimeString() + '.';
      populateWarehouses();
      populateTenants();
    }).catch(function (err) {
      $('fileLoadStatus').textContent = 'Failed: ' + err.message;
    });
  }

  if ($('loadFilesBtn')) $('loadFilesBtn').addEventListener('click', loadFromFiles);

  // ---- Live stock from .wms (via the lcs-wms-query Worker) -----------------
  // Connection is shared by both pages (same origin); tenant and item codes
  // are remembered per page, so the HelloFresh codes don't land on the
  // standard page and vice versa.
  var LIVE_KEY = 'lcs.allocation.live';
  var PAGE_KEY = HF ? 'hf' : JBS ? 'jbs' : 'std';
  // Current HelloFresh codes (Hazeldenes) - "subject to change", per Matt 2026-10-22.
  var HELLOFRESH_CODES = '13084, 13085, 13086, 13097, 13098, 13099, 13100, 13102, 13103, 13104';
  if (HF) {
    $('liveItems').value = HELLOFRESH_CODES;
    $('hfCodesBtn').addEventListener('click', function () {
      $('liveTenant').value = 'HAZEL';
      $('liveItems').value = HELLOFRESH_CODES;
    });
  }
  (function restoreLive() {
    try {
      var s = JSON.parse(localStorage.getItem(LIVE_KEY) || '{}');
      var p = s[PAGE_KEY] || (PAGE_KEY === 'std' ? { tenant: s.tenant, items: s.items } : {});  // older single-page settings
      $('liveUrl').value = s.url || 'https://lcs-wms-query.matthew-rowe1982.workers.dev';
      if (s.token) $('liveToken').value = s.token;
      if (p.tenant) $('liveTenant').value = p.tenant;
      if (p.items) $('liveItems').value = p.items;
      if (!s.token) $('liveSettings').open = true;
    } catch (e) { $('liveUrl').value = 'https://lcs-wms-query.matthew-rowe1982.workers.dev'; }
  })();
  function saveLive() {
    try {
      var s = JSON.parse(localStorage.getItem(LIVE_KEY) || '{}');
      s.url = $('liveUrl').value.trim();
      s.token = $('liveToken').value.trim();
      s[PAGE_KEY] = { tenant: $('liveTenant').value.trim(), items: $('liveItems').value.trim() };
      delete s.tenant; delete s.items;
      localStorage.setItem(LIVE_KEY, JSON.stringify(s));
    } catch (e) { /* private window etc. - fine, just not remembered */ }
  }

  /** One Query API table through the Worker, paging 25,000 rows at a time, backing off on 429. */
  function liveQuery(base, token) {
    return function (table, where, join) {
      var rows = [];
      function page(skip, wait, tries) {
        var u = base + '/q?Table=' + encodeURIComponent(table) + '&Limit=25000&Skip=' + skip +
          (join ? '&InnerJoin=' + encodeURIComponent(join) : '') + (where ? '&Where=' + encodeURIComponent(where) : '');
        return fetch(u, { headers: { Authorization: 'Bearer ' + token } }).then(function (r) {
          if (r.status === 429 && tries < 4) {
            return new Promise(function (res) { setTimeout(res, wait); }).then(function () { return page(skip, wait * 2, tries + 1); });
          }
          return r.json().catch(function () { return {}; }).then(function (j) {
            if (!r.ok || (j.Status && j.Status !== 'Success')) {
              throw new Error(table + ': ' + (j.error || j.Message || ('HTTP ' + r.status)));
            }
            var data = j.Data || [];
            rows = rows.concat(data);
            return data.length === 25000 ? page(skip + 25000, 2000, 0) : rows;
          });
        });
      }
      return page(0, 2000, 0);
    };
  }

  $('loadLiveBtn').addEventListener('click', function () {
    var base = $('liveUrl').value.trim().replace(/\/+$/, ''), token = $('liveToken').value.trim();
    var codes = $('liveItems').value.split(/[\s,;]+/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (!base || !token) { $('liveSettings').open = true; $('liveStatus').textContent = 'Enter the Worker URL and access token first.'; return; }
    if (!codes.length) { $('liveStatus').textContent = 'Enter at least one item code.'; return; }
    saveLive();
    var btn = $('loadLiveBtn'); btn.disabled = true;
    LiveStock.loadLiveStock({
      query: liveQuery(base, token),
      tenantCode: $('liveTenant').value.trim().toUpperCase(),
      warehouseCode: $('liveWarehouse').value.trim().toUpperCase(),
      itemCodes: codes,
      onProgress: function (t) { $('liveStatus').textContent = t; }
    }).then(function (out) {
      state.stockRows = out.stockRows;
      state.cartonDates = out.cartonDates;
      var when = out.stats.loadedAt.toLocaleTimeString();
      setBanner('live', 'Live from .wms at ' + when + ' - ' + out.stats.pallets + ' pallets, ' + out.stats.cartons +
        ' cartons of ' + codes.length + ' code(s), allocations and holds included.');
      $('sourceLine').textContent = 'Live .wms ' + when;
      if (HF) $('detailLoadStatus').textContent = 'Carton dates come from the live load (' + when + ') - no Detailed file needed.';
      $('liveStatus').textContent = 'Loaded ' + out.stats.pallets + ' pallets in ' + out.stats.seconds + 's.';
      populateWarehouses();
      populateTenants();
      $('warehouseSelect').value = out.stats.warehouseCode;
      $('tenantSelect').value = out.stats.tenantName;
      // One order line per code that isn't already on the order.
      var have = {};
      lines.forEach(function (l) { if (l.itemCode) have[l.itemCode] = true; });
      lines = lines.filter(function (l) { return l.itemCode; });
      codes.forEach(function (c) {
        if (!have[c]) lines.push({ id: nextLineId++, itemCode: c, metric: 'quantity', qty: null, result: null });
      });
      renderLines();
      renderHfSheet();
    }).catch(function (err) {
      $('liveStatus').textContent = 'Live load failed: ' + err.message + (JBS ? '' : ' - the file uploads still work.');
    }).then(function () { btn.disabled = false; });
  });

  if (HF) $('loadDetailBtn').addEventListener('click', function () {
    var f = $('detailFileInput').files[0];
    if (!f) { $('detailLoadStatus').textContent = 'Choose the Detailed CSV first.'; return; }
    $('detailLoadStatus').textContent = 'Reading ' + f.name + '…';
    readFileAsText(f).then(function (text) {
      var idx = AR.buildCartonDateIndex(text, SC);
      if (!idx.found || !idx.cartons) {
        state.cartonDates = null;
        $('detailLoadStatus').textContent = 'Could not find ULD and carton date columns in ' + f.name +
          ' - still using oldest-carton dates.';
        return;
      }
      state.cartonDates = idx;
      $('detailLoadStatus').textContent = 'Loaded ' + idx.cartons + ' cartons on ' + idx.ulds + ' pallets (' + f.name + ').';
      lines.forEach(function (l) { l.result = null; renderLineResult(l); });
      renderHfSheet();
    }).catch(function (err) { $('detailLoadStatus').textContent = 'Failed: ' + err.message; });
  });

  function fmtDay(key) {
    if (!key || key === 'no date') return 'no date';
    var p = key.split('-');
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return Number(p[2]) + ' ' + months[Number(p[1]) - 1] + ' ' + p[0];
  }

  function escapeHtml(s) {
    return String(s === undefined || s === null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function itemLabel(code) {
    var items = itemOptionsForTenant($('tenantSelect').value);
    for (var i = 0; i < items.length; i++) {
      if (items[i].itemCode === code) return items[i].itemName ? code + ' - ' + items[i].itemName : code;
    }
    return code;
  }

  function renderHfSheet() {
    if (!HF) return;
    var panel = $('hfSheetPanel');
    var hfLines = lines.filter(function (l) { return l.result && l.result.mode === 'hellofresh'; });
    if (!hfLines.length) {
      panel.hidden = true;
      $('hfLinesPanel').hidden = true;
      state.orderLines = [];
      return;
    }
    panel.hidden = false;
    var totalPallets = hfLines.reduce(function (s, l) { return s + l.result.pallets.length; }, 0);
    var html = '<p class="sheetNote">Tenant ' + escapeHtml($('tenantSelect').value) + ' · ' +
      escapeHtml($('warehouseSelect').value) + ' · ' + totalPallets + ' HelloFresh pallet(s) · built ' +
      new Date().toLocaleString() + '<br>Production dates from ' +
      (state.cartonDates ? 'the Detailed export (carton level)' : 'each pallet\'s oldest carton (Detailed export not loaded)') +
      '. Each HelloFresh pallet: one item, one production day, 40 cartons - unless marked.</p>';
    var n = 0;
    hfLines.forEach(function (l) {
      var r = l.result;
      html += '<h3 class="sheetItem">' + escapeHtml(itemLabel(l.itemCode)) + ' - ' + r.totalAllocatedCartons +
        ' of ' + r.requiredQuantity + ' cartons' + (r.shortfall ? ' (SHORT ' + r.shortfall + ')' : '') + '</h3>';
      html += '<table class="sheet"><thead><tr><th>HF pallet</th><th>Production day</th><th class="num">Cartons</th>' +
        '<th>Take from</th><th>Note</th></tr></thead><tbody>';
      r.pallets.forEach(function (p) {
        n++;
        var take = p.lines.map(function (ln) {
          return '<span class="sheetLine">' + ln.take + ' ctn from ULD ' + escapeHtml(ln.uld) + ' at ' +
            escapeHtml(ln.location || '-') + (ln.wholePallet ? ' (whole pallet)' : ' (of ' + ln.uldCartons + ')') +
            (p.days.length > 1 ? ' - ' + fmtDay(ln.day) : '') + '</span>';
        }).join('');
        html += '<tr class="' + (p.kind === 'full' ? '' : p.kind) + '"><td>' + n + '</td><td>' +
          p.days.map(fmtDay).join(' + ') + '</td><td class="num">' + p.cartons + '</td><td>' + take + '</td><td>' +
          (p.kind === 'exception' ? 'EXCEPTION - ' : p.kind === 'short' ? 'SHORT - ' : '') + escapeHtml(p.reason) + '</td></tr>';
      });
      html += '</tbody></table>';
    });
    $('hfSheetBody').innerHTML = html;
    renderOrderLines(hfLines);
  }

  // ---- Order lines for .wms ------------------------------------------------
  // HF pallet numbers run across the whole order on the build sheet, so the
  // per-item numbers from the engine are offset to match it.
  function currentOrderLines(hfLines) {
    var offset = 0, all = [];
    hfLines.forEach(function (l) {
      AR.helloFreshOrderLines(l.itemCode, l.result).forEach(function (ol) {
        ol.pallets = ol.pallets.map(function (p) { return p + offset; });
        all.push(ol);
      });
      offset += l.result.pallets.length;
    });
    return all;
  }

  function renderOrderLines(hfLines) {
    var all = currentOrderLines(hfLines);
    state.orderLines = all;
    $('hfLinesPanel').hidden = !all.length;
    if (!all.length) return;
    var html = '<table class="sheet"><thead><tr><th>#</th><th>Item Code</th><th>Preferred Pick ULD</th>' +
      '<th>Best Before Date</th><th class="num">Quantity</th><th>Location</th><th>For HF pallet(s)</th></tr></thead><tbody>';
    all.forEach(function (ol, i) {
      html += '<tr><td>' + (i + 1) + '</td><td>' + escapeHtml(ol.itemCode) + '</td><td>' + escapeHtml(ol.preferredUld) +
        (ol.wholePallet ? ' <span class="sub">(whole)</span>' : '') + '</td><td>' + escapeHtml(ol.bestBefore) +
        '</td><td class="num">' + ol.quantity + '</td><td>' + escapeHtml(ol.location || '-') + '</td><td>' +
        ol.pallets.join(', ') + '</td></tr>';
    });
    var total = all.reduce(function (s, ol) { return s + ol.quantity; }, 0);
    html += '</tbody></table><p class="sheetNote">' + all.length + ' order line(s), ' + total +
      ' cartons. Best Before Date = production day + 2 years.</p>';
    $('hfLinesBody').innerHTML = html;
  }

  if (HF) $('downloadLinesBtn').addEventListener('click', function () {
    if (!state.orderLines || !state.orderLines.length) return;
    var blob = new Blob([AR.orderLinesToCsv(state.orderLines)], { type: 'text/csv' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'HelloFresh-order-lines.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  });

  // ---- Pre-dispatch check ----------------------------------------------------
  function readRows(file) {
    if (/\.xlsx?$/i.test(file.name)) {
      if (!window.XLSX) return Promise.reject(new Error('the Excel reader did not load - save the export as CSV and try again'));
      return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function () {
          try {
            var wb = XLSX.read(reader.result, { type: 'array', cellDates: true });
            resolve(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' }));
          } catch (e) { reject(e); }
        };
        reader.onerror = function () { reject(reader.error); };
        reader.readAsArrayBuffer(file);
      });
    }
    return readFileAsText(file).then(function (text) {
      var rows = [];
      SC.forEachCsvRecord(text, null, function (values) { rows.push(values); });
      return rows;
    });
  }

  function planFromOrderLines() {
    var plan = {};
    (state.orderLines || []).forEach(function (ol) {
      var p = plan[ol.itemCode] || (plan[ol.itemCode] = {});
      p[ol.bestBefore] = (p[ol.bestBefore] || 0) + ol.quantity;
    });
    return Object.keys(plan).length ? plan : null;
  }

  if (HF) $('checkShipmentBtn').addEventListener('click', function () {
    var f = $('luFileInput').files[0];
    if (!f) { $('luStatus').textContent = 'Choose the Logistic Units export first.'; return; }
    $('luStatus').textContent = 'Reading ' + f.name + '…';
    readRows(f).then(function (rows) {
      var plan = $('comparePlanCheck').checked ? planFromOrderLines() : null;
      var r = AR.checkHelloFreshShipment(rows, { plan: plan });
      $('luStatus').textContent = 'Checked ' + f.name + ' at ' + new Date().toLocaleTimeString() + '.';
      if (!r.found) { $('luResult').innerHTML = '<div class="flagWarning">' + escapeHtml(r.problems[0]) + '</div>'; return; }
      var html = '<div class="lineResult" style="margin:10px 0"><span class="status ' + (r.ok ? 'full' : 'short') + '">' +
        (r.ok ? 'PASS' : 'CHECK ' + r.problems.length + ' issue(s)') + '</span> ' + r.units.length + ' pallet(s), ' +
        r.units.reduce(function (s, u) { return s + u.cartons; }, 0) + ' cartons' +
        (plan ? ' · compared with this page\'s order lines' : '') + '</div>';
      if (r.problems.length) {
        html += '<details class="flagWarning" open><summary>Issues</summary><ul>' +
          r.problems.map(function (p) { return '<li>' + escapeHtml(p) + '</li>'; }).join('') + '</ul></details>';
      }
      html += '<table class="sheet"><thead><tr><th>Item</th><th class="num">Pallets</th><th class="num">Cartons</th>' +
        '<th>Best-before dates (cartons)</th><th class="num">Two-date</th><th class="num">Short</th></tr></thead><tbody>';
      Object.keys(r.items).sort().forEach(function (c) {
        var it = r.items[c];
        html += '<tr class="' + (it.issues.length ? 'short' : '') + '"><td>' + escapeHtml(c) +
          (it.itemName ? ' - ' + escapeHtml(it.itemName) : '') + '</td><td class="num">' + it.units + '</td><td class="num">' +
          it.cartons + '</td><td>' + Object.keys(it.days).sort().map(function (d) { return d + ' (' + it.days[d] + ')'; }).join(', ') +
          '</td><td class="num">' + it.exceptions + '</td><td class="num">' + it.shorts + '</td></tr>';
      });
      html += '</tbody></table>';
      $('luResult').innerHTML = html;
    }).catch(function (err) { $('luStatus').textContent = 'Failed: ' + err.message; });
  });

  if (HF) $('printSheetBtn').addEventListener('click', function () { window.print(); });

  function showNoDataYet() {
    state.stockRows = [];
    setBanner('empty', JBS ? 'No stock loaded yet - load live stock from .wms below.' :
      'No stock data loaded yet - load a CSV below, or load live stock from .wms.');
    $('sourceLine').textContent = 'No data loaded';
    populateWarehouses();
    populateTenants();
  }

  // -------------------------------------------------------------------------
  // Tenant / item population
  // -------------------------------------------------------------------------
  function distinctSorted(values) {
    var seen = {}, out = [];
    values.forEach(function (v) { if (v && !seen[v]) { seen[v] = true; out.push(v); } });
    out.sort();
    return out;
  }

  function populateTenants() {
    var tenants = distinctSorted(state.stockRows.map(function (r) { return r.tenantCode; }));
    var sel = $('tenantSelect');
    var current = sel.value;
    sel.innerHTML = '<option value="">Select tenant…</option>';
    tenants.forEach(function (t) {
      var o = document.createElement('option');
      o.value = t; o.textContent = t;
      sel.appendChild(o);
    });
    if (tenants.indexOf(current) !== -1) sel.value = current;
    refreshAllItemDropdowns();
  }

  /**
   * Populated from whatever's actually in the loaded data, not a hardcoded
   * 613/521/523 — the real "Stock On Hand - ULD" export's Warehouse column
   * carries the name ("LEAKES"), not the numeric ID those file-export IDs
   * refer to. Hardcoding it meant every row failed the warehouse match and
   * silently returned zero stock (found 2026-09-18 against real data).
   */
  function populateWarehouses() {
    var fromStock = state.stockRows.map(function (r) { return r.warehouseId; });
    var warehouses = distinctSorted(fromStock);
    var sel = $('warehouseSelect');
    var current = sel.value;
    sel.innerHTML = '<option value="">Select warehouse…</option>';
    warehouses.forEach(function (w) {
      var o = document.createElement('option');
      o.value = w; o.textContent = w;
      sel.appendChild(o);
    });
    if (warehouses.indexOf(current) !== -1) sel.value = current;
    else if (warehouses.length === 1) sel.value = warehouses[0];
  }

  /** Items available to a tenant — whatever is currently in stock for them. */
  function itemOptionsForTenant(tenant) {
    if (!tenant) return [];
    var seen = {}, out = [];
    state.stockRows.filter(function (r) { return r.tenantCode === tenant; }).forEach(function (r) {
      if (r.itemCode && !seen[r.itemCode]) {
        seen[r.itemCode] = true;
        out.push({ itemCode: r.itemCode, itemName: r.itemName || '' });
      }
    });
    out.sort(function (a, b) { return a.itemCode.localeCompare(b.itemCode); });
    return out;
  }

  function fillItemSelect(select, items, keepValue) {
    var current = keepValue !== undefined ? keepValue : select.value;
    select.innerHTML = '<option value="">Select item…</option>';
    items.forEach(function (it) {
      var o = document.createElement('option');
      o.value = it.itemCode;
      o.textContent = it.itemName ? (it.itemCode + ' - ' + it.itemName) : it.itemCode;
      select.appendChild(o);
    });
    if (items.some(function (it) { return it.itemCode === current; })) select.value = current;
  }

  function refreshAllItemDropdowns() {
    var tenant = $('tenantSelect').value;
    var items = itemOptionsForTenant(tenant);
    lines.forEach(function (line) {
      var select = document.querySelector('[data-line="' + line.id + '"] .itemSelect');
      if (select) fillItemSelect(select, items, line.itemCode);
    });
  }

  $('tenantSelect').addEventListener('change', refreshAllItemDropdowns);

  // -------------------------------------------------------------------------
  // Order lines
  // -------------------------------------------------------------------------
  function addLine() {
    var line = { id: nextLineId++, itemCode: '', metric: 'quantity', qty: null, result: null };
    lines.push(line);
    renderLines();
  }

  function removeLine(id) {
    lines = lines.filter(function (l) { return l.id !== id; });
    renderLines();
  }

  function parseDateInput(s) {
    s = (s || '').trim();
    if (!s) return undefined;
    var d = new Date(s);
    return isNaN(d.getTime()) ? undefined : d;
  }

  function parseEstablishments(s) {
    s = (s || '').trim();
    if (!s) return undefined;
    return s.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
  }

  function renderLines() {
    var tbody = $('linesBody');
    tbody.innerHTML = '';
    var tenant = $('tenantSelect').value;
    var items = itemOptionsForTenant(tenant);

    lines.forEach(function (line) {
      var tr = document.createElement('tr');
      tr.setAttribute('data-line', line.id);

      var itemTd = document.createElement('td');
      itemTd.className = 'itemCell';
      var itemSelect = document.createElement('select');
      itemSelect.className = 'itemSelect';
      fillItemSelect(itemSelect, items, line.itemCode);
      itemSelect.addEventListener('change', function () { line.itemCode = itemSelect.value; line.result = null; renderLineResult(line); });
      itemTd.appendChild(itemSelect);

      var advanced = document.createElement('details');
      advanced.className = 'advanced';
      advanced.innerHTML =
        '<summary>Specific requirement / overrides</summary>' +
        '<div class="grid">' +
        '<div class="field"><label>Oldest allowable date</label><input type="text" class="lineOldest" placeholder="YYYY-MM-DD"></div>' +
        '<div class="field"><label>Establishment(s)</label><input type="text" class="lineEst" placeholder="comma-separated"></div>' +
        '<div class="field"><label>Specific batch</label><input type="text" class="lineBatch"></div>' +
        '<div class="field"><label>Specific ULD</label><input type="text" class="lineUld"></div>' +
        '</div>';
      itemTd.appendChild(advanced);
      tr.appendChild(itemTd);

      var qtyTd = document.createElement('td');
      qtyTd.className = 'qtyCell';
      var qtyInput = document.createElement('input');
      qtyInput.type = 'number'; qtyInput.min = '0';
      qtyInput.placeholder = line.metric === 'weight' ? 'kg required' : 'cartons required';
      qtyInput.value = line.qty || '';
      qtyInput.addEventListener('input', function () { line.qty = Number(qtyInput.value) || 0; line.result = null; renderLineResult(line); });
      qtyTd.appendChild(qtyInput);

      var toggle = document.createElement('div');
      toggle.className = 'metricToggle';
      var cartonsBtn = document.createElement('button'); cartonsBtn.type = 'button'; cartonsBtn.textContent = 'Cartons';
      var weightBtn = document.createElement('button'); weightBtn.type = 'button'; weightBtn.textContent = 'Weight (kg)';
      function syncMetricButtons() {
        cartonsBtn.setAttribute('aria-pressed', line.metric === 'quantity' ? 'true' : 'false');
        weightBtn.setAttribute('aria-pressed', line.metric === 'weight' ? 'true' : 'false');
        qtyInput.placeholder = line.metric === 'weight' ? 'kg required' : 'cartons required';
      }
      cartonsBtn.addEventListener('click', function () { line.metric = 'quantity'; syncMetricButtons(); line.result = null; renderLineResult(line); });
      weightBtn.addEventListener('click', function () { line.metric = 'weight'; syncMetricButtons(); line.result = null; renderLineResult(line); });
      syncMetricButtons();
      toggle.appendChild(cartonsBtn); toggle.appendChild(weightBtn);
      if (HF) toggle.hidden = true;  // HelloFresh is cartons only
      qtyTd.appendChild(toggle);
      tr.appendChild(qtyTd);

      var resultTd = document.createElement('td');
      resultTd.className = 'lineResult';
      resultTd.innerHTML = '<span class="status pending">Not checked</span>';
      tr.appendChild(resultTd);

      var removeTd = document.createElement('td');
      var removeBtn = document.createElement('button');
      removeBtn.className = 'removeBtn'; removeBtn.textContent = '✕ Remove';
      removeBtn.addEventListener('click', function () { removeLine(line.id); });
      removeTd.appendChild(removeBtn);
      tr.appendChild(removeTd);

      tbody.appendChild(tr);
    });

    $('downloadAllBtn').disabled = !lines.some(function (l) { return l.result && l.result.uldNumbers.length; });
  }

  function checkLine(line) {
    var tenant = $('tenantSelect').value;
    var warehouse = $('warehouseSelect').value;
    if (!tenant || !warehouse || !line.itemCode || !line.qty) {
      line.result = null;
      renderLineResult(line);
      return;
    }

    var row = document.querySelector('[data-line="' + line.id + '"]');
    var oldestStr = (row.querySelector('.lineOldest').value || $('orderOldestDate').value);
    var estStr = (row.querySelector('.lineEst').value || $('orderEstablishment').value);
    var batch = row.querySelector('.lineBatch').value.trim();
    var uld = row.querySelector('.lineUld').value.trim();

    var explicit = (batch || uld) ? { batchNumber: batch || undefined, uld: uld || undefined } : undefined;

    var request = {
      tenantCode: tenant,
      warehouseId: warehouse,
      itemCode: line.itemCode,
      requiredQuantity: line.qty,
      metric: line.metric,
      oldestAllowableProductionDate: parseDateInput(oldestStr),
      establishment: parseEstablishments(estStr),
      explicit: explicit
    };

    if (HF) {
      request.metric = 'quantity';
      request.cartonDates = state.cartonDates;
      line.result = AR.recommendHelloFresh(state.stockRows, request);
    } else {
      if (JBS) request.exclude = AR.jbsPorkExclusions({ now: new Date() });
      line.result = AR.recommendAllocation(state.stockRows, request);
    }
    renderLineResult(line);
  }

  /** The HelloFresh part of a line's result: pallets built, exceptions, leftovers. */
  function hfSummaryHtml(r) {
    var counts = { full: 0, exception: 0, short: 0 };
    r.pallets.forEach(function (p) { counts[p.kind]++; });
    var html = '<div class="detail"><span class="hfBadge">HelloFresh</span> <strong>' + r.pallets.length +
      ' pallet(s) of up to ' + r.palletSize + '</strong>: ' + counts.full + ' full' +
      (counts.exception ? ', 1 two-day exception' : '') + (counts.short ? ', ' + counts.short + ' short' : '') + '</div>';
    r.pallets.forEach(function (p) {
      if (p.kind !== 'full') html += '<div class="flagWarning">' + (p.kind === 'exception' ? 'Exception' : 'Short') +
        ' pallet: ' + p.cartons + ' ctn, ' + p.days.map(fmtDay).join(' + ') + ' - ' + escapeHtml(p.reason) + '</div>';
    });
    if (r.leftovers.length) {
      html += '<details class="flagWarning" open><summary>' + r.leftovers.length +
        ' older production day(s) left with cartons that can\'t make a full ' + r.palletSize + '</summary><ul>' +
        r.leftovers.map(function (lo) {
          return '<li>' + fmtDay(lo.day) + ': ' + lo.cartons + ' ctn on ' +
            lo.ulds.map(function (u) { return escapeHtml(u.uld) + ' (' + u.cartons + ')'; }).join(', ') + '</li>';
        }).join('') + '</ul></details>';
    }
    if (r.nextDay) html += '<div class="nextEligible">Next production day not needed: ' + fmtDay(r.nextDay.day) +
      ' (' + r.nextDay.cartons + ' ctn)</div>';
    if (r.dateSource !== 'detailed') {
      html += '<div class="nextEligible">Dates are each pallet\'s oldest carton. Load the Detailed export if any pallet may hold two production days.</div>';
    }
    if (r.detailMismatches.length) {
      html += '<details class="flagWarning"><summary>' + r.detailMismatches.length +
        ' pallet(s) where the Detailed and ULD exports disagree on carton count</summary><ul>' +
        r.detailMismatches.map(function (m) {
          return '<li>' + escapeHtml(m.uld) + ' at ' + escapeHtml(m.location || '-') + ': ULD export ' + m.uldReport +
            ', Detailed ' + m.detailed + ' - were they exported at different times?</li>';
        }).join('') + '</ul></details>';
    }
    return html;
  }

  function renderLineResult(line) {
    var row = document.querySelector('[data-line="' + line.id + '"]');
    if (!row) return;
    var cell = row.querySelector('.lineResult');
    if (!line.result) {
      cell.innerHTML = '<span class="status pending">Not checked</span>';
      return;
    }
    var r = line.result;
    var full = r.shortfall <= 0;
    var unit = r.metric === 'weight' ? 'kg' : 'ctn';
    var fmtDate = function (d) { return d ? d.toISOString().slice(0, 10) : 'unknown date'; };
    var html = '<span class="status ' + (full ? 'full' : 'short') + '">' +
      (full ? 'Can fulfil' : 'Short by ' + r.shortfall + ' ' + unit) + '</span>' +
      '<div class="detail"><strong>' + r.cartonsForOrderEntry + ' carton(s) to enter on the sales order</strong></div>' +
      '<div class="detail">' + r.uldNumbers.length + ' ULD(s) tagged for allocation (' + r.totalAllocatedCartons +
      ' ctn) from ' + r.touchedLocations.length + ' location(s)' +
      (r.mode === 'explicit' ? ' · specific requirement' : '') + '</div>' +
      '<div class="detail">' + r.totalAllocatedQuantity + ' / ' + r.requiredQuantity + ' ' + unit + ' covered</div>';
    if (r.mode === 'hellofresh') html += hfSummaryHtml(r);
    var uldList = r.uldNumbers.map(function (u) {
      return (r.uldComments && r.uldComments[u]) ? (u + ' (' + r.uldComments[u] + ')') : u;
    }).join(', ');
    html += '<details class="lineDiag"><summary>' + r.uldNumbers.length + ' ULD(s)</summary>' +
      '<div class="ulds">' + (uldList || '-') + '</div></details>';

    var next = r.mode !== 'hellofresh' && r.diagnostics && r.diagnostics.nextEligible;
    if (next) {
      html += '<div class="nextEligible">Next oldest not needed: ' + next.uld + ' at ' + (next.location || '-') +
        ', produced ' + fmtDate(next.productionDate) +
        (next.groupUldCount > 1 ? ' (' + next.groupUldCount + ' ULDs at that location)' : '') + '</div>';
    }

    var flagged = (r.diagnostics && r.diagnostics.flagged) || [];
    if (flagged.length) {
      html += '<details class="flagWarning" open><summary>⚠ ' + flagged.length +
        ' otherwise-compliant pallet(s) excluded - check before allocating</summary><ul>' +
        flagged.map(function (f) {
          return '<li>' + f.uld + ' at ' + (f.location || '-') +
            ', produced ' + fmtDate(f.productionDate) +
            ' - ' + f.reasons.join(', ') + '</li>';
        }).join('') + '</ul></details>';
    }

    var mixedLoc = (r.diagnostics && r.diagnostics.mixedLocationPallets) || [];
    if (mixedLoc.length) {
      html += '<details class="flagWarning" open><summary>' + mixedLoc.length +
        ' pallet(s) not offered because another SKU shares the location</summary><ul>' +
        mixedLoc.map(function (f) {
          return '<li>' + f.uld + ' at ' + (f.location || '-') +
            ', produced ' + fmtDate(f.productionDate) +
            ' - shares the slot with ' + (f.otherItems.length ? f.otherItems.join(', ') : 'another item') +
            '</li>';
        }).join('') + '</ul></details>';
    }

    var excludedByDate = (r.diagnostics && r.diagnostics.excludedByDate) || [];
    if (excludedByDate.length) {
      html += '<details class="dateExcluded" open><summary>' + excludedByDate.length +
        ' pallet(s) excluded by the oldest-allowable-date cutoff</summary><ul>' +
        excludedByDate.map(function (f) {
          return '<li>' + f.uld + ' at ' + (f.location || '-') +
            ', produced ' + fmtDate(f.productionDate) +
            ' - ' + f.daysBeforeCutoff + ' day(s) too old</li>';
        }).join('') + '</ul></details>';
    }
    cell.innerHTML = html;
    $('downloadAllBtn').disabled = !lines.some(function (l) { return l.result && l.result.uldNumbers.length; });
    renderOrderStats();
    renderHfSheet();
  }

  function renderOrderStats() {
    var checked = lines.filter(function (l) { return l.result; });
    var statRow = $('orderStats');
    if (!checked.length) { statRow.hidden = true; return; }
    statRow.hidden = false;
    var short = checked.filter(function (l) { return l.result.shortfall > 0; }).length;
    var totalUlds = checked.reduce(function (s, l) { return s + l.result.uldNumbers.length; }, 0);
    statRow.innerHTML = '';
    function stat(cls, n, k) {
      var d = document.createElement('div');
      d.className = 'stat' + (cls ? ' ' + cls : '');
      d.innerHTML = '<div class="n">' + n + '</div><div class="k">' + k + '</div>';
      statRow.appendChild(d);
    }
    var totalFlagged = checked.reduce(function (s, l) {
      return s + ((l.result.diagnostics && l.result.diagnostics.flagged) || []).length;
    }, 0);
    stat('', checked.length + ' / ' + lines.length, 'Lines checked');
    stat(short ? 'shortfall' : 'ok', short, 'Lines short');
    stat('', totalUlds, 'Total ULDs to allocate');
    if (totalFlagged) stat('shortfall', totalFlagged, 'Flagged - check before allocating');
  }

  $('addLineBtn').addEventListener('click', addLine);
  $('checkAllBtn').addEventListener('click', function () { lines.forEach(checkLine); });

  $('downloadAllBtn').addEventListener('click', function () {
    var allUlds = [];
    var allComments = {};
    var seen = {};
    lines.forEach(function (l) {
      if (!l.result) return;
      l.result.uldNumbers.forEach(function (u) { if (!seen[u]) { seen[u] = true; allUlds.push(u); } });
      var rc = l.result.uldComments || {};
      Object.keys(rc).forEach(function (u) { allComments[u] = rc[u]; });
    });
    var csv = AR.toUldCsv({ uldNumbers: allUlds, uldComments: allComments });
    var blob = new Blob([csv], { type: 'text/csv' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'TableGroup-ULDs.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
    countExport();
  });

  // -------------------------------------------------------------------------
  showNoDataYet();
  addLine();
})();
