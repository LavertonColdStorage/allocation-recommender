/**
 * dotWMS Allocation Recommender
 * ==============================
 * Given a Stock On Hand snapshot (same shape as StockChecks.parseStockText
 * produces) and an order requirement (tenant, item, warehouse, quantity),
 * works out which ULDs to bulk-allocate so manual order entry in dotWMS can
 * only pick from them.
 *
 * The rules, as given by the warehouse (2026-09):
 *
 *   - Prefer whole ULDs over breaking a pallet, even if that means allocating
 *     slightly more than the order needs. The cap on that overpick is the
 *     nearest whole pallet — never more.
 *   - Oldest production date first (FEFO by production date, not expiry).
 *   - No 15-day-window check here — putaway already enforces single-SKU,
 *     date-consistent locations (mixed-SKU pallets have their own putaway
 *     zones and are excluded outright). A pallet can legitimately span more
 *     than 15 days on its own if that's how it arrived — that's fine.
 *   - A location holding more than one SKU is not used for full-pallet
 *     picking at all.
 *   - Once a location is touched, every ULD in it is listed as eligible —
 *     not just the ones strictly needed — so the operator isn't hunting for
 *     specific serials. dotWMS's own order-quantity limit is what actually
 *     stops the operator overpicking.
 *   - An explicit requirement (a specific batch, ULD or production date)
 *     bypasses all of the above and just picks that stock, oldest first.
 *
 * Runs in the browser and in node. No dependencies.
 *
 *   Browser:  <script src="allocation.js"></script>  ->  window.AllocationRecommender
 *   Node:     const AR = require('./allocation.js');
 */
(function (global) {
  'use strict';

  var DEFAULT_CONFIG = {
    // Rows in these states are not real, pickable stock.
    excludeStatuses: ['DESPATCHED', 'CANCELLED'],
    // Location values that are never pickable at all, regardless of pallet
    // status — just "DAMAGE" (quarantined, not sellable). "No Location" is
    // NOT blocked: it's real, pickable stock awaiting putaway, just always
    // single-ULD (see usesWholeLocationClearing) rather than something to
    // sweep as a whole location — there's no "location" to sweep.
    blockedLocations: ['DAMAGE'],
    // Disposition values that mean the stock isn't sellable at all, wherever
    // it happens to be sitting — confirmed separately from location
    // (2026-09-17: "ignore all in location Damage also any with disposition
    // of damage"; 2026-09-18: Quarantine added the same way).
    blockedDispositions: ['DAMAGED', 'QUARANTINE'],
    // A genuinely mixed pallet (confirmed 2026-09-18) — separate from, and
    // more direct than, inferring it from a comma-separated Item Code.
    blockedPalletTypes: ['MIXED']
  };

  function mergeConfig(override) {
    var out = {
      excludeStatuses: DEFAULT_CONFIG.excludeStatuses.slice(),
      blockedLocations: DEFAULT_CONFIG.blockedLocations.slice(),
      blockedDispositions: DEFAULT_CONFIG.blockedDispositions.slice(),
      blockedPalletTypes: DEFAULT_CONFIG.blockedPalletTypes.slice()
    };
    if (override && override.excludeStatuses) out.excludeStatuses = override.excludeStatuses.slice();
    if (override && override.blockedLocations) out.blockedLocations = override.blockedLocations.slice();
    if (override && override.blockedDispositions) out.blockedDispositions = override.blockedDispositions.slice();
    if (override && override.blockedPalletTypes) out.blockedPalletTypes = override.blockedPalletTypes.slice();
    return out;
  }

  function isRobotLocation(loc) {
    return !!loc && /^ROBOT_/i.test(String(loc));
  }

  function isSmcLocation(loc) {
    return String(loc || '').toUpperCase() === 'SMC';
  }

  /**
   * Whether a row's location should be fully cleared once touched (take
   * every ULD there), or only the specific ULD itself.
   *
   * Confirmed 2026-09-17: "Located" pallets get the whole location cleared.
   * "Pending Putaway" and "Staging" are work-in-progress lanes — allocate
   * only that specific ULD, never the rest of what's sitting there. SMC
   * carries no Pallet Status at all and gets the same single-ULD treatment,
   * plus a BLAST comment on the output CSV. Robot locations (which do show
   * a nominal "Located" status in the data) are treated the same as
   * Pending Putaway/Staging regardless of that status.
   */
  function usesWholeLocationClearing(r) {
    if (isRobotLocation(r.location) || isSmcLocation(r.location)) return false;
    return (r.palletStatus || '').toUpperCase() === 'LOCATED';
  }

  function sameDay(a, b) {
    if (!a || !b) return false;
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  function oldestOf(dates) {
    var valid = dates.filter(Boolean);
    if (!valid.length) return null;
    var min = valid[0];
    for (var i = 1; i < valid.length; i++) if (valid[i] < min) min = valid[i];
    return min;
  }

  /** cartons/units, or weight when the order is specified that way instead. */
  function metricValue(r, metric) {
    return (metric === 'weight' ? r.weight : r.availableQuantity) || 0;
  }

  /** Sum of the chosen metric over rows, deduped by ULD (a pallet shouldn't be counted twice). */
  function sumByUld(rows, metric) {
    var seen = {}, total = 0;
    rows.forEach(function (r) {
      var key = r.uld || ('#' + r._i);
      if (seen[key]) return;
      seen[key] = true;
      total += metricValue(r, metric);
    });
    return total;
  }

  function dedupeStrings(values) {
    var seen = {}, out = [];
    values.forEach(function (v) {
      if (v === undefined || v === null || seen[v]) return;
      seen[v] = true;
      out.push(v);
    });
    return out;
  }

  /**
   * Walk groups (already sorted oldest first), taking whole groups until the
   * running total meets or passes requiredQuantity. Mirrors "touch a
   * location, take everything in it" for both location-grouped and
   * single-ULD-grouped callers. Also returns the next group that would have
   * been touched next (the next-oldest eligible stock not needed this
   * time), so a person can see what's waiting in the wings.
   */
  function accumulateUntilMet(groups, requiredQuantity) {
    var picked = [], touched = [], runningTotal = 0, i;
    for (i = 0; i < groups.length && runningTotal < requiredQuantity; i++) {
      var g = groups[i];
      picked = picked.concat(g.rows);
      runningTotal += g.quantity;
      touched.push(g.label);
    }
    return {
      picked: picked,
      touched: dedupeStrings(touched),
      runningTotal: runningTotal,
      nextGroup: groups[i] || null
    };
  }

  /** The single oldest row within a group — used to describe "the next ULD in line". */
  function oldestRowIn(rows) {
    return rows.reduce(function (best, r) {
      if (!best) return r;
      if (r.productionDate && (!best.productionDate || r.productionDate < best.productionDate)) return r;
      return best;
    }, null);
  }

  function describeNextEligible(group) {
    if (!group || !group.rows.length) return null;
    var oldest = oldestRowIn(group.rows);
    return {
      uld: oldest.uld,
      location: oldest.location,
      productionDate: oldest.productionDate,
      establishment: oldest.establishment,
      groupQuantity: group.quantity,
      groupUldCount: dedupeUlds(group.rows).length
    };
  }

  function dedupeUlds(rows) {
    var seen = {}, out = [];
    rows.forEach(function (r) {
      if (!r.uld || seen[r.uld]) return;
      seen[r.uld] = true;
      out.push(r.uld);
    });
    return out;
  }

  /** ULD -> 'BLAST' for any ULD sourced from an SMC location, so the output CSV can flag it. */
  function buildUldComments(picked) {
    var comments = {};
    picked.forEach(function (r) {
      if (r.uld && isSmcLocation(r.location)) comments[r.uld] = 'BLAST';
    });
    return comments;
  }

  function buildResult(mode, picked, requiredQuantity, touchedLocations, diagnostics, metric) {
    var totalAllocatedQuantity = sumByUld(picked, metric);
    return {
      mode: mode,                                   // 'optimized' | 'explicit' | 'none'
      metric: metric || 'quantity',
      uldNumbers: dedupeUlds(picked),
      uldComments: buildUldComments(picked),
      rows: picked,
      touchedLocations: touchedLocations || [],
      requiredQuantity: requiredQuantity,
      totalAllocatedQuantity: totalAllocatedQuantity,
      // Always the real carton count of what got allocated, regardless of
      // which metric drove the decision — an operator setting up the order
      // in dotWMS needs this even when the requirement was given in kg, and
      // it's the only way to see the actual overpick when rounding up to a
      // whole pallet pushed the total past what was strictly required.
      totalAllocatedCartons: sumByUld(picked, 'quantity'),
      shortfall: Math.max(0, requiredQuantity - totalAllocatedQuantity),
      diagnostics: diagnostics || {}
    };
  }

  /**
   * @param {Array} rows - normalised stock rows (StockChecks row shape),
   *   covering the WHOLE warehouse snapshot, not just the target item —
   *   mixed-SKU detection needs to see every SKU sitting in each location.
   * @param {Object} request
   *   .tenantCode, .itemCode, .warehouseId, .requiredQuantity (required)
   *   .explicit { batchNumber, uld, productionDate } (optional) — any one of
   *     these bypasses the location/travel optimisation entirely.
   *   .metric ('quantity' | 'weight', default 'quantity') — what
   *     requiredQuantity is denominated in, for catchweight orders.
   *   .oldestAllowableProductionDate (optional) — a hard cutoff. Stock
   *     produced before this date is not eligible at all, in any mode —
   *     this is a customer freshness requirement, not an efficiency knob.
   *   .establishment (optional) — a single code or array of acceptable
   *     codes. Stock from any other establishment is not eligible at all.
   * @param {Object} [config]
   */
  function recommendAllocation(rows, request, config) {
    config = mergeConfig(config);
    var excluded = {};
    config.excludeStatuses.forEach(function (s) { excluded[s] = true; });
    var blockedLocations = {};
    config.blockedLocations.forEach(function (l) { blockedLocations[l.toUpperCase()] = true; });
    function isRealLocation(loc) {
      return !!loc && !blockedLocations[String(loc).toUpperCase()];
    }
    var blockedDispositions = {};
    config.blockedDispositions.forEach(function (d) { blockedDispositions[d.toUpperCase()] = true; });
    function isSellableDisposition(r) {
      return !r.disposition || !blockedDispositions[String(r.disposition).toUpperCase()];
    }
    var blockedPalletTypes = {};
    config.blockedPalletTypes.forEach(function (t) { blockedPalletTypes[t.toUpperCase()] = true; });
    function isEligiblePalletType(r) {
      return !r.palletType || !blockedPalletTypes[String(r.palletType).toUpperCase()];
    }

    var warehouseId = request.warehouseId;
    var tenantCode = (request.tenantCode || '').toUpperCase();
    var itemCode = request.itemCode;
    var requiredQuantity = request.requiredQuantity || 0;
    var metric = request.metric === 'weight' ? 'weight' : 'quantity';
    var oldestAllowable = request.oldestAllowableProductionDate || null;
    var allowedEstablishments = request.establishment
      ? (Array.isArray(request.establishment) ? request.establishment : [request.establishment])
      : null;

    // Physically present (right warehouse, not despatched/cancelled) — used
    // for mixed-location detection, which has to see everything actually
    // sitting in a location, including stock already allocated elsewhere.
    function isPresent(r) {
      return (!warehouseId || r.warehouseId === warehouseId) &&
        !(r.status && excluded[r.status]);
    }

    // Present AND free to allocate to THIS order — already-allocated stock
    // (an order reference, or a hold like "DO NOT LOAD ...") is physically
    // there but not up for grabs.
    function isLive(r) {
      return isPresent(r) && !r.existingAllocation && metricValue(r, metric) > 0;
    }

    var allPresent = rows.filter(isPresent);
    var allWithQty = allPresent.filter(function (r) { return metricValue(r, metric) > 0; });
    var allLive = allWithQty.filter(function (r) { return !r.existingAllocation; });
    var skippedAlreadyAllocated = allPresent.filter(function (r) {
      return r.existingAllocation && r.itemCode === itemCode && (!tenantCode || r.tenantCode === tenantCode);
    }).length;

    // Every SKU present in each location, across the whole warehouse — this
    // is what "mixed location" means, not just whether the target SKU is
    // mixed with itself. Uses allPresent, not allLive: a location isn't
    // single-SKU just because the other SKU in it happens to be allocated
    // to someone else already.
    var locationSkus = {};
    allPresent.forEach(function (r) {
      if (!r.location) return;
      var set = locationSkus[r.location] || (locationSkus[r.location] = {});
      set[r.itemCode] = true;
    });
    function isMixedLocation(loc) {
      var set = locationSkus[loc];
      return !!set && Object.keys(set).length > 1;
    }

    function meetsHardRequirements(r) {
      if (oldestAllowable && r.productionDate && r.productionDate < oldestAllowable) return false;
      if (allowedEstablishments && allowedEstablishments.indexOf(r.establishment) === -1) return false;
      return true;
    }

    function isTargetItem(r) {
      return r.itemCode === itemCode && (!tenantCode || r.tenantCode === tenantCode);
    }

    function isPickableSpot(r) {
      return !!r.uld && isRealLocation(r.location) && isSellableDisposition(r) && isEligiblePalletType(r);
    }

    var candidates = allLive.filter(function (r) {
      return isTargetItem(r) && isPickableSpot(r) && !r.existingAllocation && meetsHardRequirements(r);
    });

    var skippedNoUldOrLocation = allLive.filter(function (r) {
      return isTargetItem(r) && (!r.uld || !isRealLocation(r.location)) && meetsHardRequirements(r);
    }).length;

    var skippedDamaged = allLive.filter(function (r) {
      return isTargetItem(r) && !!r.uld && isRealLocation(r.location) && !isSellableDisposition(r) && meetsHardRequirements(r);
    }).length;

    var skippedHardRequirements = allLive.filter(function (r) {
      return isTargetItem(r) && isPickableSpot(r) && !r.existingAllocation && !meetsHardRequirements(r);
    }).length;

    /**
     * Stock that would otherwise be a valid pick — right item, real ULD and
     * location, meets every hard requirement (date/establishment) — but is
     * disqualified specifically by damage, quarantine, a mixed pallet, or
     * an existing allocation. Surfaced explicitly so a person can see, say,
     * an older Quarantine pallet that would've been picked if it weren't
     * held, and go investigate before trusting the recommendation below it.
     */
    function flagReasons(r) {
      var reasons = [];
      if (r.location && String(r.location).toUpperCase() === 'DAMAGE') reasons.push('Location DAMAGE');
      if (r.disposition && blockedDispositions[String(r.disposition).toUpperCase()]) reasons.push(r.disposition + ' disposition');
      if (r.palletType && blockedPalletTypes[String(r.palletType).toUpperCase()]) reasons.push('Mixed pallet');
      if (r.existingAllocation) reasons.push('Already allocated (' + r.existingAllocation + ')');
      return reasons;
    }
    var flagged = allWithQty.filter(function (r) {
      return isTargetItem(r) && !!r.uld && meetsHardRequirements(r) && flagReasons(r).length > 0;
    }).map(function (r) {
      return {
        uld: r.uld, location: r.location, productionDate: r.productionDate,
        establishment: r.establishment, quantity: metricValue(r, metric),
        reasons: flagReasons(r)
      };
    }).sort(function (a, b) {
      if (a.productionDate && b.productionDate) return a.productionDate - b.productionDate;
      if (a.productionDate) return -1;
      if (b.productionDate) return 1;
      return 0;
    });

    /**
     * When an oldestAllowableProductionDate cutoff is in play, this is what
     * it actually excluded — stock that's otherwise pickable (real ULD and
     * location, not damaged/quarantined/mixed/already allocated, passes the
     * establishment check) but produced before the cutoff. Sorted closest
     * to the cutoff first, since those are the ones worth a second look —
     * a customer might accept a pallet that's only a day or two too old.
     */
    var excludedByDate = (oldestAllowable ? allLive.filter(function (r) {
      return isTargetItem(r) && isPickableSpot(r) && r.productionDate && r.productionDate < oldestAllowable &&
        (!allowedEstablishments || allowedEstablishments.indexOf(r.establishment) !== -1);
    }) : []).map(function (r) {
      return {
        uld: r.uld, location: r.location, productionDate: r.productionDate,
        establishment: r.establishment, quantity: metricValue(r, metric),
        daysBeforeCutoff: Math.round((oldestAllowable - r.productionDate) / 86400000)
      };
    }).sort(function (a, b) { return b.productionDate - a.productionDate; });

    var explicit = request.explicit;
    var hasExplicit = explicit && (explicit.batchNumber || explicit.uld || explicit.productionDate);

    if (hasExplicit) {
      var matches = candidates.filter(function (r) {
        if (explicit.uld && r.uld !== explicit.uld) return false;
        if (explicit.batchNumber && r.batchNumber !== explicit.batchNumber) return false;
        if (explicit.productionDate && !sameDay(r.productionDate, explicit.productionDate)) return false;
        return true;
      });
      // Oldest first, one group per ULD — no whole-location grabbing, this
      // is a specific requirement, not an efficiency optimisation.
      var byUld = {};
      matches.forEach(function (r) {
        var key = r.uld;
        if (!byUld[key]) byUld[key] = { label: key, rows: [], quantity: 0, anchorDate: r.productionDate };
        byUld[key].rows.push(r);
        byUld[key].quantity += metricValue(r, metric);
        if (r.productionDate && (!byUld[key].anchorDate || r.productionDate < byUld[key].anchorDate)) {
          byUld[key].anchorDate = r.productionDate;
        }
      });
      var explicitGroups = Object.keys(byUld).map(function (k) { return byUld[k]; });
      explicitGroups.sort(function (a, b) {
        if (a.anchorDate && b.anchorDate) return a.anchorDate - b.anchorDate;
        if (a.anchorDate) return -1;
        if (b.anchorDate) return 1;
        return 0;
      });
      var explicitAcc = accumulateUntilMet(explicitGroups, requiredQuantity);
      return buildResult('explicit', explicitAcc.picked, requiredQuantity, explicitAcc.touched, {
        matchingUlds: explicitGroups.length,
        skippedNoUldOrLocation: skippedNoUldOrLocation,
        skippedHardRequirements: skippedHardRequirements,
        skippedAlreadyAllocated: skippedAlreadyAllocated,
        skippedDamaged: skippedDamaged,
        flagged: flagged,
        excludedByDate: excludedByDate,
        nextEligible: describeNextEligible(explicitAcc.nextGroup)
      }, metric);
    }

    // Whole-location clearing only applies to "Located" pallets outside
    // SMC/robot locations — and only when that location is single-SKU.
    // Work-in-progress spots (Pending Putaway, Staging, SMC, robot
    // locations) are picked one ULD at a time regardless of what else is
    // sitting there, so mixed-SKU exclusion doesn't apply to them at all.
    var wholeLocationCandidates = candidates.filter(function (r) {
      return usesWholeLocationClearing(r) && !isMixedLocation(r.location);
    });
    var singleUldCandidates = candidates.filter(function (r) { return !usesWholeLocationClearing(r); });

    var mixedLocationsSkipped = {};
    candidates.forEach(function (r) {
      if (usesWholeLocationClearing(r) && isMixedLocation(r.location)) mixedLocationsSkipped[r.location] = true;
    });

    var byLocation = {};
    wholeLocationCandidates.forEach(function (r) {
      var key = r.location;
      if (!byLocation[key]) byLocation[key] = { label: key, rows: [], quantity: 0 };
      byLocation[key].rows.push(r);
    });
    var locationGroups = Object.keys(byLocation).map(function (loc) {
      var g = byLocation[loc];
      g.quantity = sumByUld(g.rows, metric);
      g.anchorDate = oldestOf(g.rows.map(function (r) { return r.productionDate; }));
      return g;
    });

    // Each work-in-progress ULD is its own atomic group — never bundled
    // with the rest of whatever location it happens to be sitting in.
    var singleGroups = singleUldCandidates.map(function (r) {
      return { label: r.location, rows: [r], quantity: metricValue(r, metric), anchorDate: r.productionDate };
    });

    var allGroups = locationGroups.concat(singleGroups);
    allGroups.sort(function (a, b) {
      if (a.anchorDate && b.anchorDate) return a.anchorDate - b.anchorDate;
      if (a.anchorDate) return -1;
      if (b.anchorDate) return 1;
      return 0;
    });

    var acc = accumulateUntilMet(allGroups, requiredQuantity);

    return buildResult('optimized', acc.picked, requiredQuantity, acc.touched, {
      eligibleLocations: locationGroups.length,
      eligibleSingleUlds: singleGroups.length,
      mixedLocationsSkipped: Object.keys(mixedLocationsSkipped),
      skippedNoUldOrLocation: skippedNoUldOrLocation,
      skippedHardRequirements: skippedHardRequirements,
      skippedAlreadyAllocated: skippedAlreadyAllocated,
      skippedDamaged: skippedDamaged,
      flagged: flagged,
      excludedByDate: excludedByDate,
      nextEligible: describeNextEligible(acc.nextGroup)
    }, metric);
  }

  /**
   * dotWMS bulk allocation upload format: a single "ULD Number" column,
   * plus an optional "Comment" column carrying "BLAST" for ULDs sourced
   * from SMC — only added when at least one row needs it.
   */
  function toUldCsv(result) {
    var comments = result.uldComments || {};
    var hasComments = Object.keys(comments).length > 0;
    var lines = [hasComments ? 'ULD Number,Comment' : 'ULD Number'];
    (result.uldNumbers || []).forEach(function (u) {
      lines.push(hasComments ? (u + ',' + (comments[u] || '')) : u);
    });
    return lines.join('\r\n') + '\r\n';
  }

  // ===========================================================================
  var API = {
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    recommendAllocation: recommendAllocation,
    toUldCsv: toUldCsv,
    mergeConfig: mergeConfig
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else global.AllocationRecommender = API;
})(this);
