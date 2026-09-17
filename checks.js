/**
 * dotWMS Stock Check Engine
 * =========================
 * Runs exception checks over a Stock On Hand snapshot exported from Thomax /
 * dotWMS, optionally cross-referenced against the Item Master.
 *
 * Rebuilt 21 Aug 2026 from HANDOVER.md.
 *
 * Runs in the browser (dashboard) and in node (tests). No dependencies.
 *
 *   Browser:  <script src="checks.js"></script>  ->  window.StockChecks
 *   Node:     const SC = require('./checks.js');
 *
 * ---------------------------------------------------------------------------
 * EVERYTHING YOU'D WANT TO TUNE IS IN THE CONFIG BLOCK DIRECTLY BELOW.
 * ---------------------------------------------------------------------------
 */
(function (global) {
  'use strict';

  // ===========================================================================
  // CONFIG — change the rules here
  // ===========================================================================
  var CONFIG = {
    warehouse: '613',                 // Leakes

    // Rows in these states are not real stock; excluded from every check.
    excludeStatuses: ['DESPATCHED', 'CANCELLED'],

    expiry: {
      criticalDays: 7,                // expires within this many days -> critical
      warningDays: 30,                // expires within this many days -> warning
      // The item master carries CartonDateToleranceDays (observed 15 and 90).
      // When present it is a real, system-native window, so we use it in place
      // of warningDays for that item. Set to false to always use warningDays.
      useMasterCartonTolerance: true,
      fefo: {
        staleDays: 30,                // oldest lot has sat this long...
        newerByDays: 14               // ...while a lot dated this much later moved
      }
    },

    integrity: {
      noMovementDays: 180             // no movement in this many days -> warning
    },

    barcode: {
      // The GTIN check only runs for tenants that genuinely populate GTINs.
      // A tenant is "in scope" when its item master rows meet BOTH of these.
      // (UnitGTIN in dotWMS is "required if serialised item otherwise Item
      // Code", so for most tenants it is not a GTIN at all.)
      minTenantItems: 20,             // need at least this many master rows
      minTenantGtinCoverage: 0.5,     // ...and this share must be real GTINs
      // Tenants forced in or out regardless of the numbers above, by code.
      forceInScope: [],               // e.g. ['MID', 'MCH']
      forceOutOfScope: []             // e.g. ['JBS', 'COLT', 'HAZEL']
    },

    weight: {
      defaultTolerancePct: 7,         // +/- % where the master gives no tolerance
      // Catchweight items have no meaningful nominal weight (only 880 of 16,226
      // items are Standard), so they are checked against their own spread.
      outlier: {
        minSamples: 8,                // need this many lots of a SKU to judge
        madMultiplier: 3.5            // robust z-score cut-off
      }
    },

    // Capture flags on the item master say whether an item records a
    // BestBeforeDate / ExpiryDate / BatchNumber at all. When the master says
    // "No", a missing value is correct, not an exception.
    useCaptureFlags: true
  };

  // ===========================================================================
  // COLUMN MAPPING
  // The export's real column names are confirmed against live data via the
  // Worker's /columns endpoint. Add aliases here as they turn up.
  // ===========================================================================
  var STOCK_ALIASES = {
    tenantCode:       ['tenantcode', 'tenant', 'client', 'clientcode', 'customer', 'customercode', 'owner', 'ownercode'],
    itemCode:         ['itemcode', 'sku', 'item', 'productcode', 'product', 'itemno', 'itemnumber', 'stockcode'],
    itemName:         ['itemname', 'itemdescription', 'description', 'productname', 'productdescription'],
    warehouseId:      ['warehouseid', 'warehouse', 'warehousecode', 'whid', 'site', 'sitecode'],
    location:         ['location', 'locationcode', 'locationname', 'bin', 'bincode', 'binlocation', 'slot', 'storagelocation'],
    uld:              ['uld', 'uldcode', 'uldid', 'palletid', 'pallet', 'palletcode', 'lpn', 'licenseplate', 'sscc'],
    batchNumber:      ['batchnumber', 'batch', 'batchcode', 'lot', 'lotnumber', 'lotcode'],
    serialNumber:     ['serialnumber', 'serial', 'serialno'],
    barcode:          ['barcode', 'itembarcode', 'scannedbarcode', 'gtin', 'unitgtin', 'ean', 'upc', 'eancode'],
    quantity:         ['quantity', 'qty', 'cartons', 'cartonqty', 'cartonquantity', 'quantityonhand', 'qtyonhand', 'stockonhand', 'soh', 'cases', 'caseqty', 'units'],
    availableQuantity:['availablequantity', 'availableqty', 'qtyavailable', 'available'],
    weight:           ['weight', 'totalweight', 'netweight', 'grossweight', 'weightkg', 'kg', 'kgs'],
    bestBeforeDate:   ['bestbeforedate', 'bestbefore', 'bbd', 'bbe', 'useby', 'usebydate'],
    expiryDate:       ['expirydate', 'expiry', 'expdate', 'expirationdate'],
    productionDate:   ['productiondate', 'proddate', 'packdate', 'packagingdate', 'killdate', 'productiondatetime', 'oldestcarton'],
    receivedDate:     ['receiveddate', 'receiptdate', 'datereceived', 'inbounddate', 'grndate', 'putawaydate'],
    lastMovementDate: ['lastmovementdate', 'lastmoveddate', 'lastmoved', 'lastmovedate', 'lastactivitydate', 'lasttransactiondate', 'lastmovement'],
    status:           ['status', 'stockstatus', 'statuscode', 'uldstatus', 'inventorystatus'],
    // Confirmed 2026-09-17 against the full "Stock On Hand - ULD" export
    // (v6, with Disposition/Pallet Type/Pallet Status/Weight/Batch/MTC).
    // Pallet Status ("Located" / "Pending Putaway" / "Staging", blank for
    // SMC) is deliberately its own field, separate from the generic
    // order/transaction `status` above — they answer different questions.
    palletStatus:     ['palletstatus'],
    // Disposition ("Available" / "Domestic" / "Damaged" / "Quarantine") —
    // separate again from both of the above.
    disposition:      ['disposition', 'dispositioncode', 'stockdisposition'],
    // "Single" / "Mixed" — a direct flag for a genuinely mixed pallet,
    // confirmed 2026-09-18, rather than relying on Item Code being a
    // comma-separated list to imply it.
    palletType:       ['pallettype'],
    // Confirmed 2026-09-17 against a real "Stock On Hand - ULD" export: the
    // column is literally "EST". Kept the guessed aliases too in case other
    // reports use a fuller name.
    establishment:    ['est', 'establishment', 'establishmentnumber', 'establishmentno', 'estnumber', 'meatestablishment', 'exportestablishment', 'abattoirnumber', 'plantnumber'],
    // Confirmed 2026-09-17 against the same export: a ULD already committed
    // to something else (an order, a hold) carries a value here — anything
    // from an allocation reference number to a free-text hold note like
    // "DO NOT LOAD AUGUST PRODUCT WITH JULY". Any non-blank value means the
    // ULD is not free to allocate to a new order.
    existingAllocation: ['allocation', 'allocationref', 'allocationreference', 'allocationcode']
  };

  // The item master (report key 3899) reuses date column NAMES for Yes/No
  // capture flags, so it gets its own map.
  var MASTER_ALIASES = {
    tenantCode:              ['tenantcode', 'tenant', 'client', 'clientcode'],
    itemCode:                ['itemcode', 'sku', 'item', 'productcode'],
    itemName:                ['itemname', 'description', 'itemdescription'],
    itemGroup:               ['itemgroup', 'group', 'category'],
    unitGTIN:                ['unitgtin', 'gtin', 'barcode', 'ean', 'eancode'],
    itemWeight:              ['itemweight', 'nominalweight', 'standardweight', 'cartonweight', 'weight'],
    packFactor:              ['packfactor', 'unitspercarton', 'packsize'],
    quantityMode:            ['quantitymode', 'qtymode', 'weightmode'],
    cartonDateToleranceDays: ['cartondatetolerancedays', 'datetolerancedays', 'tolerancedays'],
    agedDays:                ['ageddays'],
    capturesBestBefore:      ['bestbeforedate', 'bestbefore', 'capturesbestbefore'],
    capturesExpiry:          ['expirydate', 'expiry', 'capturesexpiry'],
    capturesProduction:      ['productiondate', 'capturesproduction'],
    capturesBatch:           ['batchnumber', 'batch', 'capturesbatch'],
    capturesSerial:          ['serialnumber', 'serial', 'capturesserial'],
    weightTolerancePct:      ['weighttolerancepct', 'weighttolerance', 'tolerancepct']
  };

  // ===========================================================================
  // Small helpers
  // ===========================================================================
  function norm(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function buildHeaderIndex(headers) {
    var idx = {};
    (headers || []).forEach(function (h) { idx[norm(h)] = h; });
    return idx;
  }

  /** Work out which real column feeds each canonical field. */
  function resolveMapping(headers, aliases) {
    var idx = buildHeaderIndex(headers);
    var mapping = {};
    Object.keys(aliases).forEach(function (field) {
      for (var i = 0; i < aliases[field].length; i++) {
        var hit = idx[aliases[field][i]];
        if (hit !== undefined) { mapping[field] = hit; return; }
      }
    });
    return mapping;
  }

  function pick(row, mapping, field) {
    var col = mapping[field];
    if (col === undefined) return undefined;
    var v = row[col];
    if (v === null || v === undefined) return undefined;
    v = String(v).trim();
    return v === '' ? undefined : v;
  }

  function toNumber(v) {
    if (v === undefined || v === null || v === '') return undefined;
    var s = String(v).replace(/,/g, '').replace(/\s/g, '').replace(/kgs?$/i, '');
    var n = Number(s);
    return isFinite(n) ? n : undefined;
  }

  function toBool(v) {
    if (v === undefined || v === null || v === '') return undefined;
    var s = String(v).trim().toLowerCase();
    if (s === 'y' || s === 'yes' || s === 'true' || s === '1') return true;
    if (s === 'n' || s === 'no' || s === 'false' || s === '0') return false;
    return undefined;
  }

  var MONTHS = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };

  /**
   * Parse a date out of the export. Australian day-first where ambiguous.
   * Returns a Date at UTC midnight, or undefined.
   */
  function parseDate(v) {
    if (v === undefined || v === null || v === '') return undefined;
    if (v instanceof Date) return isNaN(v.getTime()) ? undefined : utcMidnight(v);
    var s = String(v).trim();
    if (!s || /^(null|n\/a|na|-|0|00\/00\/0000)$/i.test(s)) return undefined;

    var m;
    // ISO / yyyy-mm-dd (also yyyy/mm/dd), with optional time
    m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
    if (m) return mkUTC(+m[1], +m[2], +m[3]);

    // dd/mm/yyyy or dd-mm-yyyy or dd.mm.yyyy, 2 or 4 digit year
    m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})/);
    if (m) {
      var d = +m[1], mo = +m[2], y = +m[3];
      if (y < 100) y += y < 70 ? 2000 : 1900;
      if (d > 31 || mo > 12) return undefined;
      return mkUTC(y, mo, d);
    }

    // dd-MMM-yyyy / dd MMM yyyy
    m = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*[-\s](\d{2,4})/);
    if (m) {
      var mm = MONTHS[m[2].toLowerCase()];
      if (mm === undefined) return undefined;
      var yy = +m[3]; if (yy < 100) yy += yy < 70 ? 2000 : 1900;
      return mkUTC(yy, mm + 1, +m[1]);
    }

    var t = Date.parse(s);
    return isNaN(t) ? undefined : utcMidnight(new Date(t));
  }

  function mkUTC(y, m, d) {
    var dt = new Date(Date.UTC(y, m - 1, d));
    return isNaN(dt.getTime()) ? undefined : dt;
  }

  function utcMidnight(dt) {
    return new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()));
  }

  function daysBetween(a, b) {
    return Math.round((b.getTime() - a.getTime()) / 86400000);
  }

  function fmtDate(d) {
    if (!d) return '';
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(d.getUTCDate()) + '/' + p(d.getUTCMonth() + 1) + '/' + d.getUTCFullYear();
  }

  // ===========================================================================
  // GTIN / barcode maths
  // ===========================================================================
  function isDigits(s) { return /^\d+$/.test(String(s || '')); }

  /** GS1 mod-10 check digit. Valid lengths: 8, 12, 13, 14. */
  function gtinCheckDigitValid(code) {
    var s = String(code || '').trim();
    if (!isDigits(s)) return false;
    if ([8, 12, 13, 14].indexOf(s.length) === -1) return false;
    var sum = 0, mult = 3;
    for (var i = s.length - 2; i >= 0; i--) {
      sum += Number(s[i]) * mult;
      mult = mult === 3 ? 1 : 3;
    }
    var check = (10 - (sum % 10)) % 10;
    return check === Number(s[s.length - 1]);
  }

  /** Zero-pad a GTIN-8/12/13 to 14 so codes compare like with like. */
  function toGtin14(code) {
    var s = String(code || '').trim();
    if (!isDigits(s) || s.length > 14) return s;
    while (s.length < 14) s = '0' + s;
    return s;
  }

  /** A "real" GTIN: right length, right check digit. */
  function looksLikeGtin(code) {
    return gtinCheckDigitValid(code);
  }

  // ===========================================================================
  // Statistics (robust, for catchweight outliers)
  // ===========================================================================
  function median(nums) {
    if (!nums.length) return undefined;
    var a = nums.slice().sort(function (x, y) { return x - y; });
    var mid = Math.floor(a.length / 2);
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  }

  /** Median absolute deviation, scaled to be comparable with a std deviation. */
  function mad(nums, med) {
    if (!nums.length) return undefined;
    var m = med === undefined ? median(nums) : med;
    var devs = nums.map(function (n) { return Math.abs(n - m); });
    return median(devs) * 1.4826;
  }

  // ===========================================================================
  // CSV parsing (quoted fields, CRLF, comma/tab/pipe/semicolon)
  // ===========================================================================
  function detectDelimiter(text) {
    var line = text.split(/\r?\n/)[0] || '';
    var best = ',', bestCount = -1;
    [',', '\t', '|', ';'].forEach(function (d) {
      var c = line.split(d).length - 1;
      if (c > bestCount) { bestCount = c; best = d; }
    });
    return best;
  }

  function parseCSV(text, delimiter) {
    if (text == null) return { headers: [], rows: [] };
    var s = String(text).replace(/^﻿/, '');
    var d = delimiter || detectDelimiter(s);
    var rows = [], field = '', row = [], inQuotes = false;

    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (inQuotes) {
        if (ch === '"') {
          if (s[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += ch;
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === d) {
        row.push(field); field = '';
      } else if (ch === '\n') {
        row.push(field); rows.push(row); row = []; field = '';
      } else if (ch === '\r') {
        // swallowed; \n ends the record
      } else {
        field += ch;
      }
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    if (!rows.length) return { headers: [], rows: [] };

    var headers = rows.shift().map(function (h) { return String(h).trim(); });
    var out = rows
      .filter(function (r) { return r.some(function (c) { return String(c).trim() !== ''; }); })
      .map(function (r) {
        var o = {};
        headers.forEach(function (h, j) { o[h] = r[j] === undefined ? '' : String(r[j]).trim(); });
        return o;
      });
    return { headers: headers, rows: out };
  }

  // ===========================================================================
  // Normalising rows
  //
  // Two ways in. The object path is for demo data and tests. The text path is
  // for the real export: it walks the CSV a record at a time and builds only
  // the normalised row, never an intermediate object per line. On a 56 MB push
  // that is the difference between working and running the browser out of
  // memory — the export carries ~40 columns and the checks read 18 of them.
  // ===========================================================================
  function objectGetter(raw, mapping) {
    return function (field) { return pick(raw, mapping, field); };
  }

  function arrayGetter(values, indexes) {
    return function (field) {
      var i = indexes[field];
      if (i === undefined) return undefined;
      var v = values[i];
      if (v === undefined || v === null) return undefined;
      v = String(v).trim();
      return v === '' ? undefined : v;
    };
  }

  function buildStockRow(get, i, raw) {
    var qty = toNumber(get('quantity'));
    var avail = toNumber(get('availableQuantity'));
    return {
      _i: i,
      raw: raw,
      tenantCode: (get('tenantCode') || '').toUpperCase() || undefined,
      itemCode: get('itemCode'),
      itemName: get('itemName'),
      warehouseId: get('warehouseId'),
      location: get('location'),
      uld: get('uld'),
      batchNumber: get('batchNumber'),
      serialNumber: get('serialNumber'),
      barcode: get('barcode'),
      quantity: qty,
      availableQuantity: avail === undefined ? qty : avail,
      weight: toNumber(get('weight')),
      bestBeforeDate: parseDate(get('bestBeforeDate')),
      expiryDate: parseDate(get('expiryDate')),
      productionDate: parseDate(get('productionDate')),
      receivedDate: parseDate(get('receivedDate')),
      lastMovementDate: parseDate(get('lastMovementDate')),
      status: (get('status') || '').toUpperCase() || undefined,
      establishment: get('establishment'),
      existingAllocation: get('existingAllocation'),
      palletStatus: get('palletStatus'),
      disposition: get('disposition'),
      palletType: get('palletType')
    };
  }

  function buildMasterRow(get, raw) {
    return {
      raw: raw,
      tenantCode: (get('tenantCode') || '').toUpperCase() || undefined,
      itemCode: get('itemCode'),
      itemName: get('itemName'),
      itemGroup: get('itemGroup'),
      unitGTIN: get('unitGTIN'),
      itemWeight: toNumber(get('itemWeight')),
      packFactor: toNumber(get('packFactor')),
      quantityMode: get('quantityMode'),
      cartonDateToleranceDays: toNumber(get('cartonDateToleranceDays')),
      weightTolerancePct: toNumber(get('weightTolerancePct')),
      capturesBestBefore: toBool(get('capturesBestBefore')),
      capturesExpiry: toBool(get('capturesExpiry')),
      capturesProduction: toBool(get('capturesProduction')),
      capturesBatch: toBool(get('capturesBatch')),
      capturesSerial: toBool(get('capturesSerial'))
    };
  }

  function normaliseStock(rawRows, mapping) {
    return rawRows.map(function (raw, i) {
      return buildStockRow(objectGetter(raw, mapping), i, raw);
    });
  }

  function normaliseMaster(rawRows, mapping) {
    return rawRows.map(function (raw) {
      return buildMasterRow(objectGetter(raw, mapping), raw);
    });
  }

  /** Field name -> column index, from the header row. */
  function resolveIndexes(headers, aliases) {
    var idx = buildHeaderIndex(headers);
    var positions = {};
    headers.forEach(function (h, i) { if (positions[h] === undefined) positions[h] = i; });
    var out = {};
    Object.keys(aliases).forEach(function (field) {
      for (var i = 0; i < aliases[field].length; i++) {
        var hit = idx[aliases[field][i]];
        if (hit !== undefined) { out[field] = positions[hit]; return; }
      }
    });
    return out;
  }

  /**
   * Walk a CSV a record at a time without building an array of every record
   * first. Records containing a quoted newline are joined back together.
   */
  function forEachCsvRecord(text, delimiter, cb) {
    var s = String(text == null ? '' : text).replace(/^﻿/, '');
    var d = delimiter || detectDelimiter(s);
    var pos = 0, n = s.length, index = 0;

    while (pos < n) {
      var start = pos;
      var end = -1;
      var quotes = 0;

      // Extend to the next newline that is not inside a quoted field.
      while (pos <= n) {
        var nl = s.indexOf('\n', pos);
        var stop = nl === -1 ? n : nl;
        for (var i = pos; i < stop; i++) if (s.charCodeAt(i) === 34) quotes++;
        if (quotes % 2 === 0 || nl === -1) { end = stop; pos = nl === -1 ? n : nl + 1; break; }
        pos = nl + 1;          // that newline sat inside a quoted field — keep going
      }

      var record = s.slice(start, end);
      if (record.charCodeAt(record.length - 1) === 13) record = record.slice(0, -1);
      if (record !== '') {
        cb(record.indexOf('"') === -1 ? record.split(d) : splitQuoted(record, d), index);
        index++;
      }
      if (end === n) break;
    }
    return d;
  }

  function splitQuoted(record, d) {
    var out = [], field = '', inQuotes = false;
    for (var i = 0; i < record.length; i++) {
      var ch = record[i];
      if (inQuotes) {
        if (ch === '"') {
          if (record[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += ch;
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === d) {
        out.push(field); field = '';
      } else field += ch;
    }
    out.push(field);
    return out;
  }

  /**
   * Parse raw CSV text straight into normalised rows.
   *
   * Some dotWMS exports (e.g. "Stock On Hand - ULD") lead with a one-cell
   * report-title row before the real header row:
   *   Stock On Hand - ULD,,,,,,,,,
   *   Warehouse,Tenant,ULD,Location,...
   * A row that matches none of the known aliases and has at most one
   * non-empty cell is treated as such a preamble and skipped, up to a
   * handful of rows, rather than being mistaken for the header row.
   */
  function parseText(text, aliases, build) {
    var headers = null, indexes = null, delimiter = null;
    var rows = [];
    var preambleRowsSkipped = 0, maxPreambleRows = 5;

    forEachCsvRecord(text, null, function (values, i) {
      if (headers === null) {
        var candidateHeaders = values.map(function (h) { return String(h).replace(/^"|"$/g, '').trim(); });
        var candidateIndexes = resolveIndexes(candidateHeaders, aliases);
        var nonEmptyCells = candidateHeaders.filter(function (h) { return h !== ''; }).length;
        if (Object.keys(candidateIndexes).length === 0 && nonEmptyCells <= 1 &&
            preambleRowsSkipped < maxPreambleRows) {
          preambleRowsSkipped++;
          return;
        }
        headers = candidateHeaders;
        indexes = candidateIndexes;
        return;
      }
      rows.push(build(arrayGetter(values, indexes), rows.length));
    });

    if (!headers) return { headers: [], mapping: {}, rows: [] };

    // Report the mapping in the same shape the object path produces.
    var mapping = {};
    Object.keys(indexes).forEach(function (field) { mapping[field] = headers[indexes[field]]; });

    return { headers: headers, mapping: mapping, indexes: indexes, rows: rows, delimiter: delimiter };
  }

  function parseStockText(text) {
    return parseText(text, STOCK_ALIASES, function (get, i) { return buildStockRow(get, i, null); });
  }

  function parseMasterText(text) {
    return parseText(text, MASTER_ALIASES, function (get) { return buildMasterRow(get, null); });
  }

  function masterKey(tenantCode, itemCode) {
    return (tenantCode || '') + ' ' + (itemCode || '');
  }

  function indexMaster(masterRows) {
    var byKey = {}, byItem = {};
    masterRows.forEach(function (m) {
      if (!m.itemCode) return;
      byKey[masterKey(m.tenantCode, m.itemCode)] = m;
      // byItem is only a fallback for when the stock row has no tenant code.
      // If two tenants share an item code the fallback is ambiguous, so drop it.
      if (byItem[m.itemCode] === undefined) byItem[m.itemCode] = m;
      else if (byItem[m.itemCode] && byItem[m.itemCode].tenantCode !== m.tenantCode) byItem[m.itemCode] = null;
    });
    return {
      size: masterRows.length,
      lookup: function (tenantCode, itemCode) {
        if (!itemCode) return undefined;
        var hit = byKey[masterKey((tenantCode || '').toUpperCase(), itemCode)];
        if (hit) return hit;
        if (tenantCode) return undefined;   // tenant known and no match = no match
        return byItem[itemCode] || undefined; // null means ambiguous across tenants
      }
    };
  }

  /**
   * Which tenants actually populate real GTINs?
   * UnitGTIN is "required if serialised item otherwise Item Code", so most
   * tenants carry the item code, an 'x', or item code + 'X' instead.
   */
  function gtinTenantScope(masterRows, config) {
    var cfg = config.barcode;
    var per = {};
    masterRows.forEach(function (m) {
      var t = m.tenantCode || '(none)';
      if (!per[t]) per[t] = { tenant: t, items: 0, gtins: 0 };
      per[t].items++;
      var g = m.unitGTIN;
      if (g && g !== m.itemCode && looksLikeGtin(g)) per[t].gtins++;
    });
    var scope = {};
    Object.keys(per).forEach(function (t) {
      var s = per[t];
      s.coverage = s.items ? s.gtins / s.items : 0;
      s.inScope = s.items >= cfg.minTenantItems && s.coverage >= cfg.minTenantGtinCoverage;
      if (cfg.forceInScope.indexOf(t) !== -1) s.inScope = true;
      if (cfg.forceOutOfScope.indexOf(t) !== -1) s.inScope = false;
      scope[t] = s;
    });
    return scope;
  }

  // ===========================================================================
  // Findings
  // ===========================================================================
  var SEVERITY_ORDER = { critical: 0, serious: 1, warning: 2 };

  function makeFinding(family, code, severity, title, detail, row, extra) {
    var f = {
      family: family,
      code: code,
      severity: severity,
      title: title,
      detail: detail,
      tenantCode: row ? row.tenantCode : undefined,
      itemCode: row ? row.itemCode : undefined,
      itemName: row ? row.itemName : undefined,
      location: row ? row.location : undefined,
      uld: row ? row.uld : undefined,
      batchNumber: row ? row.batchNumber : undefined,
      quantity: row ? row.quantity : undefined,
      rowIndex: row ? row._i : undefined
    };
    if (extra) Object.keys(extra).forEach(function (k) { f[k] = extra[k]; });
    f.id = [family, code, f.tenantCode, f.itemCode, f.uld || f.location, f.batchNumber, f.rowIndex].join('|');
    return f;
  }

  // --- expiry ----------------------------------------------------------------
  function effectiveDate(row) {
    return row.expiryDate || row.bestBeforeDate;
  }

  function checkExpiry(rows, master, config, today) {
    var out = [];
    var cfg = config.expiry;

    rows.forEach(function (r) {
      var m = master ? master.lookup(r.tenantCode, r.itemCode) : undefined;
      var eff = effectiveDate(r);
      var qty = r.quantity === undefined ? 0 : r.quantity;

      if (eff) {
        var days = daysBetween(today, eff);
        if (days < 0) {
          if (qty > 0) {
            out.push(makeFinding('expiry', 'EXPIRED_AVAILABLE', 'critical',
              'Expired but still available',
              'Best-before ' + fmtDate(eff) + ' — ' + Math.abs(days) + ' days ago, ' + qty + ' still on hand',
              r, { date: eff, days: days }));
          }
        } else if (days <= cfg.criticalDays) {
          out.push(makeFinding('expiry', 'EXPIRING_CRITICAL', 'critical',
            'Expires within ' + cfg.criticalDays + ' days',
            'Best-before ' + fmtDate(eff) + ' — ' + days + ' days away',
            r, { date: eff, days: days }));
        } else {
          var window = cfg.warningDays;
          if (cfg.useMasterCartonTolerance && m && m.cartonDateToleranceDays > 0) {
            window = m.cartonDateToleranceDays;
          }
          if (days <= window) {
            out.push(makeFinding('expiry', 'EXPIRING_SOON', 'warning',
              'Expires within ' + window + ' days',
              'Best-before ' + fmtDate(eff) + ' — ' + days + ' days away' +
                (window !== cfg.warningDays ? ' (item tolerance ' + window + 'd)' : ''),
              r, { date: eff, days: days }));
          }
        }
      } else if (qty > 0) {
        // No date at all. Only an exception if this item is meant to carry one.
        var shouldCapture = true;
        if (config.useCaptureFlags && m) {
          if (m.capturesBestBefore === false && m.capturesExpiry === false) shouldCapture = false;
        }
        if (shouldCapture) {
          out.push(makeFinding('expiry', 'NO_BEST_BEFORE', 'serious',
            'No best-before captured',
            'Stock on hand with no best-before or expiry date',
            r));
        }
      }
    });

    out = out.concat(checkFEFO(rows, config, today));
    return out;
  }

  /**
   * FEFO breach: the oldest lot of a SKU has sat 30+ days while a lot dated
   * 14+ days later has moved after it.
   */
  function checkFEFO(rows, config, today) {
    var cfg = config.expiry.fefo;
    var groups = {};
    rows.forEach(function (r) {
      if (!r.itemCode) return;
      if (!(r.quantity > 0)) return;
      if (!effectiveDate(r)) return;
      var k = masterKey(r.tenantCode, r.itemCode);
      (groups[k] = groups[k] || []).push(r);
    });

    var out = [];
    Object.keys(groups).forEach(function (k) {
      var lots = groups[k];
      if (lots.length < 2) return;

      var oldest = lots.reduce(function (a, b) {
        return effectiveDate(a).getTime() <= effectiveDate(b).getTime() ? a : b;
      });
      var oldestMoved = oldest.lastMovementDate || oldest.receivedDate;
      if (!oldestMoved) return;
      if (daysBetween(oldestMoved, today) < cfg.staleDays) return;

      var jumper = null;
      for (var i = 0; i < lots.length; i++) {
        var l = lots[i];
        if (l === oldest) continue;
        var gap = daysBetween(effectiveDate(oldest), effectiveDate(l));
        if (gap < cfg.newerByDays) continue;
        var lMoved = l.lastMovementDate || l.receivedDate;
        if (!lMoved) continue;
        if (lMoved.getTime() > oldestMoved.getTime()) { jumper = l; break; }
      }
      if (!jumper) return;

      out.push(makeFinding('expiry', 'FEFO_BREACH', 'serious',
        'FEFO breach',
        'Oldest lot (best-before ' + fmtDate(effectiveDate(oldest)) + ') last moved ' +
        fmtDate(oldestMoved) + ', but a lot dated ' + fmtDate(effectiveDate(jumper)) +
        ' moved on ' + fmtDate(jumper.lastMovementDate || jumper.receivedDate),
        oldest, { jumperLocation: jumper.location, jumperUld: jumper.uld }));
    });
    return out;
  }

  // --- integrity -------------------------------------------------------------
  function checkIntegrity(rows, master, config, today) {
    var out = [];
    var cfg = config.integrity;

    rows.forEach(function (r) {
      var qty = r.quantity;

      if (qty !== undefined && qty < 0) {
        out.push(makeFinding('integrity', 'NEGATIVE_QTY', 'critical',
          'Negative quantity',
          'Quantity is ' + qty, r));
      }

      if (qty !== undefined && qty > 0 && !r.location) {
        out.push(makeFinding('integrity', 'QTY_NO_LOCATION', 'critical',
          'Quantity with no location',
          qty + ' on hand with no location recorded', r));
      }

      if (!r.itemCode) {
        out.push(makeFinding('integrity', 'NO_SKU', 'critical',
          'No SKU',
          'Stock record with no item code', r));
      } else if (master && master.size > 0) {
        if (!master.lookup(r.tenantCode, r.itemCode)) {
          out.push(makeFinding('integrity', 'NO_MASTER_MATCH', 'serious',
            'No product master match',
            'Item ' + r.itemCode + ' is not in the item master', r));
        }
      }

      if (qty === 0 && r.location) {
        out.push(makeFinding('integrity', 'ZERO_QTY_LOCATION', 'warning',
          'Zero quantity holding a location',
          'Location ' + r.location + ' is held by a zero-quantity record', r));
      }

      if (qty > 0) {
        var moved = r.lastMovementDate || r.receivedDate;
        if (moved) {
          var age = daysBetween(moved, today);
          if (age >= cfg.noMovementDays) {
            out.push(makeFinding('integrity', 'NO_MOVEMENT', 'warning',
              'No movement in ' + cfg.noMovementDays + ' days',
              'Last movement ' + fmtDate(moved) + ' — ' + age + ' days ago',
              r, { days: age }));
          }
        }
      }
    });
    return out;
  }

  // --- barcode ---------------------------------------------------------------
  function checkBarcode(rows, master, config, scope) {
    var out = [];
    if (!master || master.size === 0) return out;

    rows.forEach(function (r) {
      var tenant = r.tenantCode || '(none)';
      var s = scope[tenant];
      if (!s || !s.inScope) return;           // tenant doesn't do real GTINs

      var m = master.lookup(r.tenantCode, r.itemCode);
      var masterGtin = m && m.unitGTIN && m.unitGTIN !== m.itemCode && looksLikeGtin(m.unitGTIN)
        ? toGtin14(m.unitGTIN) : undefined;

      if (!r.barcode) {
        out.push(makeFinding('barcode', 'NO_BARCODE', 'serious',
          'No barcode captured',
          'No barcode on a record for a tenant that carries GTINs', r));
        return;
      }

      if (!gtinCheckDigitValid(r.barcode)) {
        out.push(makeFinding('barcode', 'BAD_CHECK_DIGIT', 'critical',
          'Barcode fails GS1 check digit',
          'Barcode ' + r.barcode + ' is not a valid GTIN', r, { barcode: r.barcode }));
        return;
      }

      if (!masterGtin) {
        out.push(makeFinding('barcode', 'MASTER_NO_GTIN', 'warning',
          'Item master has no GTIN',
          'Barcode ' + r.barcode + ' scanned, but the master has no GTIN to check it against',
          r, { barcode: r.barcode }));
        return;
      }

      if (toGtin14(r.barcode) !== masterGtin) {
        out.push(makeFinding('barcode', 'GTIN_MISMATCH', 'critical',
          'Barcode does not match the item master',
          'Scanned ' + toGtin14(r.barcode) + ', master says ' + masterGtin,
          r, { barcode: r.barcode, masterGtin: masterGtin }));
      }
    });
    return out;
  }

  // --- weight ----------------------------------------------------------------
  function avgCartonWeight(r) {
    if (r.weight === undefined) return undefined;
    if (!(r.quantity > 0)) return undefined;
    return r.weight / r.quantity;
  }

  function checkWeight(rows, master, config) {
    var out = [];
    var cfg = config.weight;

    // Pass 1 — nominal vs actual on Standard (fixed weight) items,
    //          and collect catchweight samples per SKU.
    var samples = {};
    rows.forEach(function (r) {
      if (!(r.quantity > 0)) return;
      var m = master ? master.lookup(r.tenantCode, r.itemCode) : undefined;
      var avg = avgCartonWeight(r);

      if (avg === undefined) {
        out.push(makeFinding('weight', 'NO_WEIGHT', 'serious',
          'No weight captured',
          'Stock on hand with no weight recorded', r));
        return;
      }

      var isStandard = m && String(m.quantityMode || '').toLowerCase() === 'standard';

      if (isStandard && m.itemWeight > 0) {
        var tol = (m.weightTolerancePct > 0 ? m.weightTolerancePct : cfg.defaultTolerancePct) / 100;
        var devPct = (avg - m.itemWeight) / m.itemWeight;
        var absDev = Math.abs(devPct);
        if (absDev > tol * 2) {
          out.push(makeFinding('weight', 'WEIGHT_WAY_OFF', 'critical',
            'Carton weight far outside tolerance',
            'Average ' + avg.toFixed(2) + ' kg vs nominal ' + m.itemWeight.toFixed(2) +
            ' kg (' + (devPct * 100).toFixed(1) + '%, tolerance +/-' + (tol * 100).toFixed(0) + '%)',
            r, { avgWeight: avg, nominal: m.itemWeight, deviationPct: devPct * 100 }));
        } else if (absDev > tol) {
          out.push(makeFinding('weight', 'WEIGHT_OUT_OF_TOLERANCE', 'serious',
            'Carton weight outside tolerance',
            'Average ' + avg.toFixed(2) + ' kg vs nominal ' + m.itemWeight.toFixed(2) +
            ' kg (' + (devPct * 100).toFixed(1) + '%, tolerance +/-' + (tol * 100).toFixed(0) + '%)',
            r, { avgWeight: avg, nominal: m.itemWeight, deviationPct: devPct * 100 }));
        }
        return;
      }

      // Catchweight (or unknown) — judged against the SKU's own spread.
      var k = masterKey(r.tenantCode, r.itemCode);
      (samples[k] = samples[k] || []).push({ row: r, avg: avg });
    });

    // Pass 2 — catchweight outliers.
    var oc = cfg.outlier;
    Object.keys(samples).forEach(function (k) {
      var set = samples[k];
      if (set.length < oc.minSamples) return;
      var values = set.map(function (s) { return s.avg; });
      var med = median(values);
      var spread = mad(values, med);
      if (!spread || spread <= 0) return;

      set.forEach(function (s) {
        var z = Math.abs(s.avg - med) / spread;
        if (z > oc.madMultiplier) {
          var sev = z > oc.madMultiplier * 2 ? 'critical' : 'serious';
          out.push(makeFinding('weight', 'CATCHWEIGHT_OUTLIER', sev,
            'Carton weight is an outlier for this SKU',
            'Average ' + s.avg.toFixed(2) + ' kg against a SKU median of ' + med.toFixed(2) +
            ' kg across ' + set.length + ' lots (robust z ' + z.toFixed(1) + ')',
            s.row, { avgWeight: s.avg, skuMedian: med, robustZ: z, sampleSize: set.length }));
        }
      });
    });

    return out;
  }

  // ===========================================================================
  // Main entry point
  // ===========================================================================
  /**
   * @param {Object}  input
   * @param {Array}   input.stock          raw stock rows (objects keyed by header)
   * @param {Array}   [input.stockHeaders] header order, if known
   * @param {Array}   [input.products]     raw item master rows
   * @param {Object}  [input.config]       config overrides (deep-merged)
   * @param {Date}    [input.today]        for testing
   */
  function runChecks(input) {
    input = input || {};
    var config = mergeConfig(CONFIG, input.config);
    var today = input.today ? utcMidnight(new Date(input.today)) : utcMidnight(new Date());

    var stockHeaders, stockMapping, allRows;
    if (typeof input.stockText === 'string') {
      var parsedStock = parseStockText(input.stockText);
      stockHeaders = parsedStock.headers;
      stockMapping = parsedStock.mapping;
      allRows = parsedStock.rows;
    } else {
      var stockRaw = input.stock || [];
      stockHeaders = input.stockHeaders || (stockRaw.length ? Object.keys(stockRaw[0]) : []);
      stockMapping = resolveMapping(stockHeaders, STOCK_ALIASES);
      allRows = normaliseStock(stockRaw, stockMapping);
    }

    var excluded = 0;
    var rows = allRows.filter(function (r) {
      if (r.status && config.excludeStatuses.indexOf(r.status) !== -1) { excluded++; return false; }
      return true;
    });

    var masterHeaders, masterMapping, masterRows;
    if (typeof input.productsText === 'string') {
      var parsedMaster = parseMasterText(input.productsText);
      masterHeaders = parsedMaster.headers;
      masterMapping = parsedMaster.mapping;
      masterRows = parsedMaster.rows;
    } else {
      var productsRaw = input.products || [];
      masterHeaders = input.productHeaders || (productsRaw.length ? Object.keys(productsRaw[0]) : []);
      masterMapping = resolveMapping(masterHeaders, MASTER_ALIASES);
      masterRows = normaliseMaster(productsRaw, masterMapping);
    }
    var master = indexMaster(masterRows);
    var scope = gtinTenantScope(masterRows, config);

    var findings = []
      .concat(checkExpiry(rows, master.size ? master : null, config, today))
      .concat(checkIntegrity(rows, master.size ? master : null, config, today))
      .concat(checkBarcode(rows, master.size ? master : null, config, scope))
      .concat(checkWeight(rows, master.size ? master : null, config));

    findings.sort(function (a, b) {
      var d = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
      if (d) return d;
      return String(a.tenantCode || '').localeCompare(String(b.tenantCode || '')) ||
             String(a.itemCode || '').localeCompare(String(b.itemCode || ''));
    });

    var counts = { critical: 0, serious: 0, warning: 0 };
    var byFamily = { expiry: 0, integrity: 0, barcode: 0, weight: 0 };
    findings.forEach(function (f) {
      counts[f.severity]++;
      byFamily[f.family]++;
    });

    var tenants = {};
    rows.forEach(function (r) { if (r.tenantCode) tenants[r.tenantCode] = true; });

    return {
      generatedAt: new Date().toISOString(),
      today: today.toISOString().slice(0, 10),
      findings: findings,
      counts: counts,
      byFamily: byFamily,
      stats: {
        stockRows: allRows.length,
        checkedRows: rows.length,
        excludedRows: excluded,
        masterRows: masterRows.length,
        tenants: Object.keys(tenants).sort(),
        gtinScope: scope
      },
      mapping: {
        stock: stockMapping,
        products: masterMapping,
        unmappedStockColumns: stockHeaders.filter(function (h) {
          return Object.keys(stockMapping).every(function (f) { return stockMapping[f] !== h; });
        }),
        missingStockFields: Object.keys(STOCK_ALIASES).filter(function (f) {
          return stockMapping[f] === undefined;
        })
      },
      config: config
    };
  }

  function mergeConfig(base, override) {
    var out = JSON.parse(JSON.stringify(base));
    if (!override) return out;
    (function walk(dst, src) {
      Object.keys(src).forEach(function (k) {
        if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k])) {
          dst[k] = dst[k] && typeof dst[k] === 'object' ? dst[k] : {};
          walk(dst[k], src[k]);
        } else {
          dst[k] = src[k];
        }
      });
    })(out, override);
    return out;
  }

  // ===========================================================================
  var API = {
    CONFIG: CONFIG,
    STOCK_ALIASES: STOCK_ALIASES,
    MASTER_ALIASES: MASTER_ALIASES,
    runChecks: runChecks,
    parseCSV: parseCSV,
    parseStockText: parseStockText,
    parseMasterText: parseMasterText,
    forEachCsvRecord: forEachCsvRecord,
    parseDate: parseDate,
    fmtDate: fmtDate,
    daysBetween: daysBetween,
    gtinCheckDigitValid: gtinCheckDigitValid,
    toGtin14: toGtin14,
    looksLikeGtin: looksLikeGtin,
    resolveMapping: resolveMapping,
    gtinTenantScope: gtinTenantScope,
    median: median,
    mad: mad,
    mergeConfig: mergeConfig
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else global.StockChecks = API;

})(typeof globalThis !== 'undefined' ? globalThis : this);
