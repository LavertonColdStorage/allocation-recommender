/**
 * Live stock from the dotWMS Query API (2026-10-23)
 * ==================================================
 * Builds the same stock rows the page gets from the "Stock On Hand - ULD"
 * export, plus the carton-date index it gets from the "Stock On Hand -
 * Detailed" export, straight from .wms - for a given tenant, warehouse and
 * list of item codes (the HelloFresh codes).
 *
 * The .wms login stays in the lcs-wms-query Worker; this file only knows how
 * to ask for tables and join them. All network access goes through the
 * `query(table, where, join)` function the caller passes in, so the joining
 * logic (buildLiveStock) is pure and unit-tested.
 *
 * Route (verified against same-morning exports: 506/506 pallets identical):
 *   TNT, WHS              tenant and warehouse codes -> IDs
 *   ITM                   item codes -> ItemIDs
 *   ULD1 (per item)       cartons, with BestBeforeDate and UnitQuantity
 *   ULD  (tenant+whs)     pallet barcodes
 *   ULDB (ULDID range)    pallet -> bin;  BIN (warehouse) -> bin code
 *   ATR + InnerJoin=ULD   pallet attributes: Allocation, Disposition,
 *                         PalletStatus, PalletType, EST, OldestCarton...
 *                         (undocumented join - DOTWMS_QUERY_API.md s10)
 *
 *   Browser:  <script src="livestock.js"></script> -> window.LiveStock
 *   Node:     const LS = require('./livestock.js');
 */
(function (global) {
  'use strict';

  function str(v) { return v === undefined || v === null ? '' : String(v); }
  function day(v) { var m = str(v).match(/^(\d{4})-(\d\d)-(\d\d)/); return m ? m[0] : ''; }
  function minusYears(key, years) {
    if (!key) return '';
    var md = key.slice(5);
    return (Number(key.slice(0, 4)) - years) + '-' + md;
  }
  // ULD.CreateDateUTC "2026-10-30 04:28:11" -> Date (when the pallet was scanned in).
  function parseUtc(v) {
    var m = str(v).match(/^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d):(\d\d)/);
    return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : undefined;
  }
  function parseDay(key) {
    var m = str(key).match(/^(\d{4})-(\d\d)-(\d\d)/);
    return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : undefined;
  }

  /** Sorted ULDIDs -> [lo, hi] ranges, splitting where the gap exceeds `gap`. */
  function ranges(ids, gap) {
    var s = ids.map(Number).filter(function (n) { return !isNaN(n); }).sort(function (a, b) { return a - b; });
    var out = [];
    for (var i = 0; i < s.length; i++) {
      if (!out.length || s[i] - out[out.length - 1][1] > gap) out.push([s[i], s[i]]);
      else out[out.length - 1][1] = s[i];
    }
    return out;
  }

  /**
   * Pure join. raw = { tenant, warehouse, items, cartons, ulds, links, bins, attrs }
   * (arrays of Query API rows). Returns { stockRows, cartonDates, stats }.
   * opts.bestBeforeYears: carton production day = best before - this (default 2).
   */
  function buildLiveStock(raw, opts) {
    var years = (opts && opts.bestBeforeYears) || 2;
    var tenantName = str(raw.tenant.TenantName || raw.tenant.TenantCode).toUpperCase();
    var whCode = str(raw.warehouse.WarehouseCode);
    var itemCode = {};
    raw.items.forEach(function (i) { itemCode[str(i.ItemID)] = str(i.ItemCode); });
    var barcode = {}, created = {};
    raw.ulds.forEach(function (u) {
      barcode[str(u.ULDID)] = str(u.Barcode);
      created[str(u.ULDID)] = parseUtc(u.CreateDateUTC);
    });
    var binCode = {}, binZone = {};
    raw.bins.forEach(function (b) {
      binCode[str(b.BinID)] = str(b.BinCode);
      binZone[str(b.BinID)] = str(b.WarehouseZone);
    });
    var binOf = {};
    raw.links.forEach(function (l) { binOf[str(l.ULDID)] = str(l.BinID); });
    var atr = {};
    raw.attrs.forEach(function (a) {
      var k = str(a.ReferenceID);
      (atr[k] = atr[k] || {})[str(a.AttributeName)] = str(a.AttributeValue);
    });

    // Count cartons per pallet per item (UnitQuantity 0 = picked, still listed on an emptied pallet).
    // UnitQuantity is the carton's weight (6.60, 22.85...), so summing it gives the pallet's weight
    // for weight-based orders.
    var perPallet = {}, weightOf = {}, byUld = {}, newest = {}, cartons = 0, skippedPicked = 0;
    raw.cartons.forEach(function (c) {
      var id = str(c.ULDID), item = itemCode[str(c.ItemID)];
      if (!item || !barcode[id]) return;            // not this tenant/warehouse
      if (!(Number(c.UnitQuantity) > 0)) { skippedPicked++; return; }
      var p = perPallet[id] || (perPallet[id] = {});
      p[item] = (p[item] || 0) + 1;
      var w = weightOf[id] || (weightOf[id] = {});
      w[item] = (w[item] || 0) + Number(c.UnitQuantity);
      var prod = minusYears(day(c.BestBeforeDate), years) || 'no date';
      // Newest carton date per pallet and item, for "scanned in recently but
      // the stock is old" rules (JBS Pork). JBS cartons carry PackagingDate,
      // HelloFresh ones only a best before.
      var cd = day(c.PackagingDate) || day(c.ProductionDate) || (prod !== 'no date' ? prod : '');
      if (cd) {
        var nk = id + '|' + item;
        if (!newest[nk] || cd > newest[nk]) newest[nk] = cd;
      }
      var bc = barcode[id];
      var u = byUld[bc] || (byUld[bc] = {});
      u[prod] = (u[prod] || 0) + 1;
      cartons++;
    });

    var stockRows = [], emptied = 0, i = 0;
    Object.keys(perPallet).forEach(function (id) {
      var a = atr[id] || {};
      if (a.PalletStatus === 'Empty') { emptied++; return; }
      var loc = binOf[id] ? (binCode[binOf[id]] || '') : 'No Location';
      Object.keys(perPallet[id]).forEach(function (item) {
        var qty = perPallet[id][item];
        stockRows.push({
          _i: i++, raw: null, live: true,
          tenantCode: tenantName, itemCode: item, warehouseId: whCode,
          location: loc, uld: barcode[id],
          quantity: qty, availableQuantity: qty,
          weight: Math.round(weightOf[id][item] * 100) / 100,
          productionDate: parseDay(a.OldestCarton),
          establishment: a.EST || undefined,
          existingAllocation: a.Allocation || undefined,
          palletStatus: a.PalletStatus || undefined,
          disposition: a.Disposition || undefined,
          palletType: a.PalletType || undefined,
          zone: binOf[id] ? (binZone[binOf[id]] || undefined) : undefined,
          receivedAt: created[id],
          newestCartonDate: parseDay(newest[id + '|' + item])
        });
      });
    });

    // Normal orders sweep a whole location only if it holds a single item, so
    // the recommender must see EVERY pallet in the locations it might touch -
    // not just the items being ordered. raw.binLinks lists all pallets linked
    // to those bins; any that isn't one of ours holds something else. Each is
    // added as a placeholder row (no tenant, no quantity, never pickable) so
    // the existing mixed-location check works exactly as with the ULD export.
    var ours = {}, touchedBins = {}, others = 0;
    Object.keys(perPallet).forEach(function (id) {
      ours[id] = true;
      if (binOf[id]) touchedBins[binOf[id]] = true;
    });
    (raw.binLinks || []).forEach(function (l) {
      var id = str(l.ULDID), bin = str(l.BinID);
      if (ours[id] || !touchedBins[bin] || !binCode[bin]) return;
      stockRows.push({
        _i: i++, raw: null, live: true, placeholder: true,
        tenantCode: undefined, itemCode: '(other item)', warehouseId: whCode,
        location: binCode[bin], uld: 'ULDID:' + id, quantity: 0, availableQuantity: 0
      });
      others++;
    });

    var ulds = Object.keys(byUld).length;
    return {
      stockRows: stockRows,
      cartonDates: { found: true, byUld: byUld, cartons: cartons, ulds: ulds, source: 'live' },
      stats: { pallets: stockRows.length - others, cartons: cartons, emptiedPallets: emptied, pickedCartonLines: skippedPicked, otherPalletsInSameLocations: others }
    };
  }

  /** Run `jobs` (functions returning promises) at most `n` at a time. */
  function pool(jobs, n) {
    var results = new Array(jobs.length), next = 0;
    function worker() {
      if (next >= jobs.length) return Promise.resolve();
      var k = next++;
      return jobs[k]().then(function (r) { results[k] = r; return worker(); });
    }
    var starters = [];
    for (var w = 0; w < Math.min(n, jobs.length); w++) starters.push(worker());
    return Promise.all(starters).then(function () { return results; });
  }

  function q(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

  /**
   * Fetch everything and build. opts:
   *   query(table, where, join) -> Promise<rows[]>   (pages through results itself)
   *   tenantCode ('HAZEL'), warehouseCode ('LEAKES'), itemCodes ([...])
   *   onProgress(text), concurrency (default 4)
   */
  function loadLiveStock(opts) {
    var query = opts.query, say = opts.onProgress || function () {}, conc = opts.concurrency || 4;
    var started = Date.now(), raw = {};
    say('Finding tenant and warehouse…');
    return Promise.all([
      query('TNT', 'TenantCode eq ' + q(opts.tenantCode)),
      query('WHS', 'WarehouseCode eq ' + q(opts.warehouseCode))
    ]).then(function (r) {
      if (!r[0].length) throw new Error('Tenant ' + opts.tenantCode + ' not found in .wms');
      if (!r[1].length) throw new Error('Warehouse ' + opts.warehouseCode + ' not found in .wms');
      raw.tenant = r[0][0]; raw.warehouse = r[1][0];
      var tid = raw.tenant.TenantID, wid = raw.warehouse.WarehouseID;
      say('Looking up ' + opts.itemCodes.length + ' item codes…');
      return pool(opts.itemCodes.map(function (code) {
        return function () { return query('ITM', 'TenantID eq ' + q(tid) + ' AND ItemCode eq ' + q(code)); };
      }), conc).then(function (lists) {
        raw.items = [].concat.apply([], lists);
        if (!raw.items.length) throw new Error('None of those item codes exist for ' + opts.tenantCode);
        say('Reading cartons…');
        return Promise.all([
          pool(raw.items.map(function (it) {
            return function () { return query('ULD1', 'ItemID eq ' + q(it.ItemID)); };
          }), conc),
          query('ULD', 'TenantID eq ' + q(tid) + ' AND WarehouseID eq ' + q(wid)),
          query('BIN', 'WarehouseID eq ' + q(wid))
        ]);
      }).then(function (r2) {
        raw.cartons = [].concat.apply([], r2[0]);
        raw.ulds = r2[1]; raw.bins = r2[2];
        var inWh = {};
        raw.ulds.forEach(function (u) { inWh[str(u.ULDID)] = true; });
        var ids = {};
        raw.cartons.forEach(function (c) { if (inWh[str(c.ULDID)] && Number(c.UnitQuantity) > 0) ids[str(c.ULDID)] = true; });
        var idList = Object.keys(ids);
        if (!idList.length) { raw.links = []; raw.attrs = []; return null; }
        var whole = ranges(idList, Infinity)[0];
        var parts = ranges(idList, 2000);
        say('Reading locations and pallet status for ' + idList.length + ' pallets…');
        var done = 0;
        return Promise.all([
          query('ULDB', 'ULDID ge ' + q(whole[0]) + ' AND ULDID le ' + q(whole[1])),
          pool(parts.map(function (rg) {
            return function () {
              return query('ATR', 'ReferenceID ge ' + q(rg[0]) + ' AND ReferenceID le ' + q(rg[1]), 'ULD').then(function (rows) {
                done++; say('Reading pallet status… ' + done + ' of ' + parts.length);
                return rows;
              });
            };
          }), conc)
        ]).then(function (r3) {
          raw.links = r3[0]; raw.attrs = [].concat.apply([], r3[1]);
          // Every other pallet in the same bins (any tenant/item) - for the
          // single-item-location check normal orders depend on.
          var bins = {};
          raw.links.forEach(function (l) { if (ids[str(l.ULDID)]) bins[str(l.BinID)] = true; });
          var binParts = ranges(Object.keys(bins), 200);
          say('Checking which locations are shared (' + Object.keys(bins).length + ' locations)…');
          return pool(binParts.map(function (rg) {
            return function () { return query('ULDB', 'BinID ge ' + q(rg[0]) + ' AND BinID le ' + q(rg[1])); };
          }), conc).then(function (lists) { raw.binLinks = [].concat.apply([], lists); });
        });
      });
    }).then(function () {
      var out = buildLiveStock(raw, opts);
      out.stats.seconds = Math.round((Date.now() - started) / 1000);
      out.stats.loadedAt = new Date();
      out.stats.tenantName = str(raw.tenant.TenantName || raw.tenant.TenantCode).toUpperCase();
      out.stats.warehouseCode = str(raw.warehouse.WarehouseCode);
      return out;
    });
  }

  var API = { buildLiveStock: buildLiveStock, loadLiveStock: loadLiveStock, ranges: ranges };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else global.LiveStock = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
