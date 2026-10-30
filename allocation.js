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

  /**
   * `picked` deliberately over-includes stock: touching a "Located" location
   * tags every pallet sitting there, not just the ones needed, so an
   * operator grabs whichever pallet is closest instead of hunting through
   * the location for a specific one. totalAllocatedCartons reflects that
   * full sweep — but the quantity typed into the dotWMS sales order line
   * must not be inflated by it. This walks the same picked stock oldest
   * pallet first, ignoring location boundaries, and stops the moment the
   * running total first meets the requirement — the minimal number of
   * whole pallets, rounded up, that actually covers the order.
   */
  function cartonsForOrderEntry(picked, requiredQuantity, metric) {
    var sorted = picked.slice().sort(function (a, b) {
      if (a.productionDate && b.productionDate) return a.productionDate - b.productionDate;
      if (a.productionDate) return -1;
      if (b.productionDate) return 1;
      return 0;
    });
    var seen = {}, runningMetric = 0, cartons = 0, i, r, key;
    for (i = 0; i < sorted.length && runningMetric < requiredQuantity; i++) {
      r = sorted[i];
      key = r.uld || ('#' + i);
      if (seen[key]) continue;
      seen[key] = true;
      runningMetric += metricValue(r, metric);
      cartons += metricValue(r, 'quantity');
    }
    return cartons;
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
      // The real carton count of every pallet TAGGED for allocation,
      // regardless of which metric drove the decision — includes the whole-
      // location overpick. This is what's in the CSV, not what goes in the
      // sales order quantity field (see cartonsForOrderEntry below).
      totalAllocatedCartons: sumByUld(picked, 'quantity'),
      // What to actually key into the dotWMS sales order line: the minimal
      // whole pallets needed, not the whole-location sweep above.
      cartonsForOrderEntry: cartonsForOrderEntry(picked, requiredQuantity, metric),
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
   *   .exclude (optional) — function(row) -> array of reasons. A customer's
   *     site rules (e.g. jbsPorkExclusions). A pallet with any reason is not
   *     picked and is listed with the other excluded pallets.
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
    function extraReasons(r) {
      return typeof request.exclude === 'function' ? (request.exclude(r) || []) : [];
    }

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
      return !!r.uld && isRealLocation(r.location) && isSellableDisposition(r) && isEligiblePalletType(r) &&
        !extraReasons(r).length;
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
      return reasons.concat(extraReasons(r));
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
    //
    // request.allowMixedLocations (HelloFresh, 2026-10-22): a pallet in a
    // mixed-SKU location is offered as a single-ULD pick instead of being
    // dropped. Matt: HelloFresh product is only put away in double-deep
    // locations, so the worst case is moving one pallet to reach another.
    var allowMixed = !!request.allowMixedLocations;
    var wholeLocationCandidates = candidates.filter(function (r) {
      return usesWholeLocationClearing(r) && !isMixedLocation(r.location);
    });
    var singleUldCandidates = candidates.filter(function (r) {
      return !usesWholeLocationClearing(r) || (allowMixed && isMixedLocation(r.location));
    });

    var mixedLocationsSkipped = {};
    // The actual pallets lost to that rule. A Located pallet of the right
    // SKU sitting in a slot another SKU also occupies is dropped from BOTH
    // candidate lists above — it can't be swept (mixed location) and it
    // isn't a single-ULD spot. That is real, compliant stock going unseen,
    // so name it rather than leaving the operator to wonder.
    var mixedLocationPallets = [];
    candidates.forEach(function (r) {
      if (!allowMixed && usesWholeLocationClearing(r) && isMixedLocation(r.location)) {
        mixedLocationsSkipped[r.location] = true;
        mixedLocationPallets.push({
          uld: r.uld,
          location: r.location,
          productionDate: r.productionDate,
          establishment: r.establishment,
          quantity: metricValue(r, metric),
          otherItems: Object.keys(locationSkus[r.location] || {}).filter(function (code) {
            return code !== r.itemCode;
          })
        });
      }
    });
    mixedLocationPallets.sort(function (a, b) {
      if (a.productionDate && b.productionDate) return a.productionDate - b.productionDate;
      if (a.productionDate) return -1;
      if (b.productionDate) return 1;
      return String(a.uld).localeCompare(String(b.uld));
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
      mixedLocationPallets: mixedLocationPallets,
      skippedNoUldOrLocation: skippedNoUldOrLocation,
      skippedHardRequirements: skippedHardRequirements,
      skippedAlreadyAllocated: skippedAlreadyAllocated,
      skippedDamaged: skippedDamaged,
      flagged: flagged,
      excludedByDate: excludedByDate,
      nextEligible: describeNextEligible(acc.nextGroup)
    }, metric);
  }

  // ===========================================================================
  // HELLOFRESH ORDERS (2026-10-22)
  //
  // HelloFresh want every pallet they receive rebuilt to exactly 40 cartons
  // (config.palletSize), one item code, one production DAY. We don't store
  // stock in 40s, so for a HelloFresh order stored pallets are broken down
  // and re-stacked. The rules, as given by Matt:
  //
  //   - Normal eligibility still applies (no damaged/quarantined/mixed
  //     pallets, no already-allocated stock, date/establishment cutoffs) —
  //     reused from recommendAllocation. EXCEPT mixed-SKU locations ARE used:
  //     HelloFresh product only goes into double-deep locations, so at worst
  //     one pallet is moved to reach another (Matt, 2026-10-22).
  //   - Oldest production day first. From each day build as many full 40s as
  //     the order still needs; a day that can't make another full 40 is left
  //     behind and FLAGGED as a leftover, not silently skipped.
  //   - At most ONE pallet per item may mix two days (load all of one day,
  //     top up from the next) — only to complete the order when clean 40s
  //     can't. It's an exception, marked as such.
  //   - A pallet under 40 only when stock runs out, or the ordered quantity
  //     isn't a multiple of 40.
  //   - Within a day, take whole stored pallets first; break as few as
  //     possible.
  //
  // Dates: the "Stock On Hand - ULD" export gives each pallet ONE date (its
  // oldest carton). If a Detailed (one row per carton) export is supplied,
  // its carton dates are used instead, so a pallet holding two days is split
  // correctly. Without it, a pallet is assumed to be all its oldest-carton
  // date — the result says which source was used.
  // ===========================================================================

  function dayKey(d) {
    if (!d) return '';
    var m = d.getMonth() + 1, day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
  }

  function normaliseHeader(h) {
    return String(h || '').replace(/^"|"$/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function stripExcelQuote(v) {
    return String(v === undefined || v === null ? '' : v).trim().replace(/^'/, '');
  }

  /**
   * Builds { uld -> { 'YYYY-MM-DD' -> cartons } } from a Detailed export
   * (one row per carton: ..., ULD, CARTON DATE, ...). Needs StockChecks for
   * CSV splitting and date parsing. Skips one-cell title rows like the ULD
   * export's "Stock On Hand - ULD,,,," preamble.
   */
  function buildCartonDateIndex(text, SC) {
    var iUld = -1, iDate = -1, header = false, index = {}, cartons = 0, ulds = 0;
    SC.forEachCsvRecord(text, null, function (values) {
      if (!header) {
        var h = values.map(normaliseHeader);
        var u = h.indexOf('uld'), d = -1;
        ['cartondate', 'productiondate', 'packdate', 'proddate', 'oldestcarton'].some(function (name) {
          d = h.indexOf(name);
          return d !== -1;
        });
        if (u !== -1 && d !== -1) { iUld = u; iDate = d; header = true; }
        return;
      }
      var uld = stripExcelQuote(values[iUld]);
      var date = SC.parseDate(stripExcelQuote(values[iDate]));
      if (!uld || !date) return;
      var key = dayKey(date);
      if (!index[uld]) { index[uld] = {}; ulds++; }
      index[uld][key] = (index[uld][key] || 0) + 1;
      cartons++;
    });
    return { found: header, byUld: index, cartons: cartons, ulds: ulds };
  }

  /** Choose stored pallets totalling exactly `need` cartons, breaking as few as possible. */
  function chooseSources(sources, need) {
    var pool = sources.filter(function (s) { return s.remaining > 0; })
      .sort(function (a, b) { return b.remaining - a.remaining || String(a.uld).localeCompare(String(b.uld)); });
    var takes = [], left = need, used = {};
    pool.forEach(function (s, i) {
      if (left > 0 && s.remaining <= left) { takes.push({ src: s, take: s.remaining }); left -= s.remaining; used[i] = true; }
    });
    if (left > 0) {
      // Break exactly one pallet: the smallest one big enough to finish the job.
      var best = -1;
      pool.forEach(function (s, i) {
        if (!used[i] && s.remaining >= left && (best === -1 || s.remaining < pool[best].remaining)) best = i;
      });
      if (best !== -1) { takes.push({ src: pool[best], take: left }); left = 0; }
    }
    return takes;
  }

  /**
   * JBS Pork site rules (Matt, 2026-10-30), on top of the standard rules:
   *  - nothing in Warehouse Zone D4RBLAST - the blast freezer, stock still
   *    freezing (DAMAGE / Damaged / Quarantine are already standard);
   *  - nothing scanned in during the last 80 hours, UNLESS every carton on
   *    the pallet is more than 2 weeks old (newest carton date) - older stock
   *    arriving from elsewhere is already frozen.
   * Rows need .zone, .receivedAt (when the pallet was scanned in) and
   * .newestCartonDate - live stock supplies all three. A recent pallet with
   * no carton date is excluded (can't prove it's old). A pallet with no scan
   * time can't be judged and is let through; the page warns about that.
   * Returns a function for request.exclude.
   */
  function jbsPorkExclusions(opts) {
    opts = opts || {};
    var now = opts.now || new Date();
    var hours = opts.recentHours || 80, oldDays = opts.oldCartonDays || 14;
    var zones = (opts.blockedZones || ['D4RBLAST']).map(function (z) { return z.toUpperCase(); });
    return function (r) {
      var reasons = [];
      if (r.zone && zones.indexOf(String(r.zone).toUpperCase()) !== -1) reasons.push('Blast zone (' + r.zone + ')');
      if (r.receivedAt) {
        var ageH = (now - r.receivedAt) / 3600000;
        if (ageH < hours) {
          var cartonDays = r.newestCartonDate ? (now - r.newestCartonDate) / 86400000 : null;
          if (cartonDays === null || cartonDays <= oldDays) {
            reasons.push('Scanned in ' + Math.max(0, Math.floor(ageH)) + 'h ago (under ' + hours + 'h)' +
              (cartonDays === null ? ', no carton date' :
                ', newest carton ' + r.newestCartonDate.toISOString().slice(0, 10) + ' is not over ' + oldDays + ' days old'));
          }
        }
      }
      return reasons;
    };
  }

  /**
   * @param rows, request, config — exactly as recommendAllocation. Extra
   *   request fields: .cartonDates (from buildCartonDateIndex, optional).
   *   Always counts cartons (request.metric is ignored).
   */
  function recommendHelloFresh(rows, request, config) {
    var palletSize = (config && config.palletSize) || 40;
    var required = Math.max(0, Math.floor(request.requiredQuantity || 0));

    // Everything eligible, using the normal rules: ask for "infinitely many"
    // cartons and the normal engine returns every eligible pallet.
    var baseReq = {};
    Object.keys(request).forEach(function (k) { baseReq[k] = request[k]; });
    baseReq.requiredQuantity = Infinity;
    baseReq.metric = 'quantity';
    baseReq.allowMixedLocations = true;   // HelloFresh: double-deep putaway, see above
    var base = recommendAllocation(rows, baseReq, config);

    var detail = request.cartonDates && request.cartonDates.byUld ? request.cartonDates.byUld : null;
    var detailMismatches = [];

    // One "source" per stored pallet per production day.
    var byDay = {}, seenUld = {};
    base.rows.forEach(function (r) {
      if (!r.uld || seenUld[r.uld]) return;
      seenUld[r.uld] = true;
      var cartons = metricValue(r, 'quantity');
      var split = detail && detail[r.uld];
      var parts = [];
      if (split) {
        var detailTotal = 0;
        Object.keys(split).forEach(function (k) { detailTotal += split[k]; });
        if (detailTotal !== cartons) detailMismatches.push({ uld: r.uld, location: r.location, uldReport: cartons, detailed: detailTotal });
        Object.keys(split).forEach(function (k) { parts.push({ day: k, cartons: split[k] }); });
      } else {
        parts.push({ day: dayKey(r.productionDate) || 'no date', cartons: cartons });
      }
      parts.forEach(function (p) {
        if (!byDay[p.day]) byDay[p.day] = { day: p.day, sources: [] };
        byDay[p.day].sources.push({
          uld: r.uld, location: r.location, day: p.day, cartons: p.cartons, remaining: p.cartons,
          uldCartons: cartons, multiDay: !!split && Object.keys(split).length > 1, smc: isSmcLocation(r.location)
        });
      });
    });
    var days = Object.keys(byDay).sort(function (a, b) {
      if (a === 'no date') return 1;
      if (b === 'no date') return -1;
      return a < b ? -1 : a > b ? 1 : 0;
    }).map(function (k) { return byDay[k]; });
    function available(d) { return d.sources.reduce(function (t, s) { return t + s.remaining; }, 0); }

    var pallets = [], need = required, exceptionUsed = false;

    function addPallet(parts, kind, reason) {
      var lines = [];
      parts.forEach(function (p) {
        chooseSources(p.day.sources, p.take).forEach(function (t) {
          t.src.remaining -= t.take;
          lines.push({
            uld: t.src.uld, location: t.src.location, day: t.src.day, take: t.take,
            uldCartons: t.src.uldCartons, wholePallet: t.take === t.src.uldCartons, multiDay: t.src.multiDay
          });
        });
      });
      var cartons = lines.reduce(function (s, l) { return s + l.take; }, 0);
      pallets.push({
        number: pallets.length + 1,
        days: dedupeStrings(lines.map(function (l) { return l.day; })),
        cartons: cartons, kind: kind, reason: reason || '', lines: lines
      });
      need -= cartons;
    }

    // 1. Full single-day pallets, oldest day first. Everything a day has to
    // supply is chosen in one go (so the fewest stored pallets are broken
    // across the whole day, not per 40), then cut into 40s in order.
    days.forEach(function (d) {
      var count = Math.min(Math.floor(available(d) / palletSize), Math.floor(need / palletSize));
      if (count < 1) return;
      var queue = chooseSources(d.sources, count * palletSize).map(function (t) { return { src: t.src, left: t.take }; });
      for (var p = 0; p < count; p++) {
        var lines = [], room = palletSize;
        while (room > 0 && queue.length) {
          var q = queue[0], take = Math.min(q.left, room);
          q.src.remaining -= take;
          lines.push({
            uld: q.src.uld, location: q.src.location, day: q.src.day, take: take,
            uldCartons: q.src.uldCartons, wholePallet: take === q.src.uldCartons, multiDay: q.src.multiDay
          });
          q.left -= take; room -= take;
          if (!q.left) queue.shift();
        }
        pallets.push({ number: pallets.length + 1, days: [d.day], cartons: palletSize, kind: 'full', reason: '', lines: lines });
        need -= palletSize;
      }
    });

    // 2. Whatever is still needed.
    if (need > 0) {
      var target = Math.min(need, palletSize);
      var single = null;
      for (var i = 0; i < days.length; i++) if (available(days[i]) >= target) { single = days[i]; break; }
      if (single) {
        addPallet([{ day: single, take: target }], 'short',
          'Order quantity is not a multiple of ' + palletSize + ' - last pallet is ' + target + ' cartons');
      } else {
        var withStock = days.filter(function (d) { return available(d) > 0; });
        if (withStock.length >= 2) {
          // The oldest pair of days that fills the pallet; if no pair can,
          // the pair that gets closest. Just taking the two oldest days can
          // leave the order short when an older day + a newer one would fill
          // it (13102 on 2645SY794386: 26 + 10 = 36, but 26 + 22 = 40).
          var a = null, b = null, best = -1;
          for (var x = 0; x < withStock.length && best < target; x++) {
            for (var y = x + 1; y < withStock.length; y++) {
              var got = Math.min(available(withStock[x]) + available(withStock[y]), target);
              if (got > best) { best = got; a = withStock[x]; b = withStock[y]; }
              if (got >= target) break;
            }
          }
          var takeA = Math.min(available(a), target);
          var takeB = Math.min(available(b), target - takeA);
          exceptionUsed = true;
          addPallet([{ day: a, take: takeA }, { day: b, take: takeB }], 'exception',
            'Two production days on one pallet - the one exception allowed per item' +
            (takeA + takeB < palletSize ? ' (and short: not enough stock left)' : ''));
        } else if (withStock.length === 1) {
          addPallet([{ day: withStock[0], take: Math.min(available(withStock[0]), target) }], 'short',
            'Short pallet - no more eligible stock');
        }
      }
    }

    // Leftovers: days OLDER than the newest day used that still hold stock -
    // older cartons the order passed over. What's left on the newest day
    // itself is just stock the order didn't need, not a leftover.
    var newestUsed = pallets.reduce(function (m, p) {
      return p.days.reduce(function (mm, d) { return d > mm ? d : mm; }, m);
    }, '');
    var leftovers = days.filter(function (d) { return d.day !== 'no date' && d.day < newestUsed && available(d) > 0; })
      .map(function (d) {
        return {
          day: d.day, cartons: available(d),
          ulds: d.sources.filter(function (s) { return s.remaining > 0; })
            .map(function (s) { return { uld: s.uld, location: s.location, cartons: s.remaining }; })
        };
      });
    var nextDay = null;
    days.some(function (d) {
      if (d.day > newestUsed && available(d) > 0) { nextDay = { day: d.day, cartons: available(d) }; return true; }
      return false;
    });

    var used = [], comments = {};
    pallets.forEach(function (p) {
      p.lines.forEach(function (l) {
        if (used.indexOf(l.uld) === -1) used.push(l.uld);
        if (isSmcLocation(l.location)) comments[l.uld] = 'BLAST';
      });
    });
    var allocated = pallets.reduce(function (s, p) { return s + p.cartons; }, 0);

    return {
      mode: 'hellofresh',
      metric: 'quantity',
      palletSize: palletSize,
      pallets: pallets,
      uldNumbers: used,
      uldComments: comments,
      requiredQuantity: required,
      totalAllocatedQuantity: allocated,
      totalAllocatedCartons: allocated,
      cartonsForOrderEntry: allocated,
      shortfall: Math.max(0, required - allocated),
      exceptionUsed: exceptionUsed,
      leftovers: leftovers,
      nextDay: nextDay,
      dateSource: detail ? 'detailed' : 'oldest-carton',
      detailMismatches: detailMismatches,
      touchedLocations: dedupeStrings(pallets.reduce(function (a, p) {
        return a.concat(p.lines.map(function (l) { return l.location; }));
      }, [])),
      diagnostics: base.diagnostics
    };
  }

  // ===========================================================================
  // HELLOFRESH ORDER LINES FOR .wms (2026-10-23)
  //
  // Instead of one .wms order line per item ("13084 x 640") with the date
  // rules left in free text, each line names exactly what to pick: Item,
  // Preferred Pick ULD, Best Before Date, Quantity. Matt: those are the only
  // line filters .wms honours reliably. EST, min/max production dates and a
  // per-line Allocation are NOT used - when they differ between lines for the
  // same item, .wms reverts to the first line's value. Any Allocation must be
  // the same on every line of the order.
  //
  // .wms holds the best-before date on these cartons (production date shows
  // N/A); the stock exports give the production day. HelloFresh product's
  // best-before is production + 2 years (checked against job 2645PH792930).
  // config.bestBeforeYears changes that if a code ever differs.
  // ===========================================================================

  function addYears(key, years) {
    if (!/^\d{4}-\d\d-\d\d$/.test(key || '')) return '';
    var y = Number(key.slice(0, 4)) + years, md = key.slice(5);
    if (md === '02-29') md = '02-28';
    return y + '-' + md;
  }

  /**
   * One order line per item + stored pallet + production day, in the order
   * the HelloFresh pallets are built. A stored pallet feeding two HF pallets
   * of the same day is one line with the summed quantity.
   */
  function helloFreshOrderLines(itemCode, result, config) {
    var years = (config && config.bestBeforeYears) || 2;
    var byKey = {}, out = [];
    (result && result.pallets || []).forEach(function (p) {
      p.lines.forEach(function (l) {
        var key = l.uld + '|' + l.day;
        if (!byKey[key]) {
          byKey[key] = {
            itemCode: itemCode, preferredUld: l.uld, location: l.location,
            productionDay: l.day, bestBefore: addYears(l.day, years),
            quantity: 0, pallets: [], wholePallet: l.wholePallet
          };
          out.push(byKey[key]);
        }
        var line = byKey[key];
        line.quantity += l.take;
        if (line.pallets.indexOf(p.number) === -1) line.pallets.push(p.number);
        line.wholePallet = line.quantity === l.uldCartons;
      });
    });
    return out;
  }

  function csvCell(v) {
    var s = v === undefined || v === null ? '' : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /** Order lines as CSV, for keying into Create Manual Shipment Order. */
  function orderLinesToCsv(lines) {
    var out = ['Item Code,Preferred Pick ULD,Best Before Date,Quantity,Location,Production Date,HF Pallet(s)'];
    lines.forEach(function (l) {
      out.push([l.itemCode, l.preferredUld, l.bestBefore, l.quantity, l.location, l.productionDay,
        l.pallets.join(' ')].map(csvCell).join(','));
    });
    return out.join('\r\n') + '\r\n';
  }

  // ===========================================================================
  // PRE-DISPATCH CHECK: a .wms "Shipping - Job Management - Logistic Units"
  // export (one row per outbound pallet - "<SSCC> Cartons: 40 Weight: ..." -
  // followed by one row per carton on it). Checks every pallet against the
  // HelloFresh rules. `rows` is an array of arrays (CSV or Excel, same shape).
  // ===========================================================================

  function dateCellKey(v) {
    if (v instanceof Date && !isNaN(v.getTime())) return dayKey(v);
    var s = String(v === undefined || v === null ? '' : v).trim();
    var m = s.match(/^(\d{4})-(\d\d)-(\d\d)/);
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return m[3] + '-' + (m[2].length < 2 ? '0' : '') + m[2] + '-' + (m[1].length < 2 ? '0' : '') + m[1];
    return '';
  }

  function checkHelloFreshShipment(rows, config) {
    var palletSize = (config && config.palletSize) || 40;
    var plan = config && config.plan;   // optional { item: { bestBefore: cartons } }
    var head = -1, cols = {};
    for (var i = 0; i < rows.length && head === -1; i++) {
      var h = (rows[i] || []).map(function (c) { return String(c === undefined || c === null ? '' : c).toLowerCase(); });
      if (h[0] && h[0].indexOf('unit number') !== -1) {
        head = i;
        h.forEach(function (name, k) {
          if (name.indexOf('best before') !== -1) cols.bb = k;
          else if (name.indexOf('production') !== -1) cols.prod = k;
          else if (name.indexOf('packaging') !== -1) cols.pack = k;
          else if (name.indexOf('item name') !== -1) cols.name = k;
        });
      }
    }
    if (head === -1) return { found: false, units: [], items: {}, problems: ['Could not find the "Unit Number / Item Code" header row - is this the Logistic Units export?'], ok: false };

    var units = [], cur = null, names = {};
    for (var r = head + 1; r < rows.length; r++) {
      var row = rows[r] || [];
      var first = String(row[0] === undefined || row[0] === null ? '' : row[0]).trim();
      if (!first) continue;
      var m = first.match(/^(\S+)\s+Cartons:\s*(\d+)/i);
      if (m) {
        cur = { unit: m[1], declared: Number(m[2]), cartons: 0, items: {}, days: {} };
        units.push(cur);
        continue;
      }
      if (!cur) continue;
      var item = first.replace(/^'/, '');
      var day = dateCellKey(row[cols.bb]) || dateCellKey(row[cols.prod]) || dateCellKey(row[cols.pack]) || 'no date';
      cur.cartons++;
      cur.items[item] = (cur.items[item] || 0) + 1;
      cur.days[day] = (cur.days[day] || 0) + 1;
      if (cols.name !== undefined && row[cols.name]) names[item] = String(row[cols.name]);
    }

    var items = {}, problems = [];
    units.forEach(function (u) {
      var codes = Object.keys(u.items), days = Object.keys(u.days).sort();
      u.itemCodes = codes; u.dayList = days;
      u.issues = [];
      if (codes.length > 1) u.issues.push('MIXED ITEMS (' + codes.join(', ') + ')');
      if (days.length > 2) u.issues.push('MORE THAN TWO DATES');
      if (u.cartons !== u.declared) u.issues.push('label says ' + u.declared + ', ' + u.cartons + ' cartons listed');
      u.kind = days.length > 1 ? 'exception' : (u.cartons < palletSize ? 'short' : (u.cartons > palletSize ? 'over' : 'full'));
      if (u.kind === 'over') u.issues.push('MORE THAN ' + palletSize + ' CARTONS');
      codes.forEach(function (c) {
        var it = items[c] || (items[c] = { itemCode: c, itemName: names[c] || '', units: 0, cartons: 0, days: {}, exceptions: 0, shorts: 0, issues: [] });
        it.units++; it.cartons += u.items[c];
        days.forEach(function (d) { it.days[d] = (it.days[d] || 0) + u.days[d]; });
        if (u.kind === 'exception') it.exceptions++;
        if (u.kind === 'short') it.shorts++;
      });
    });
    Object.keys(items).forEach(function (c) {
      var it = items[c];
      if (it.exceptions > 1) it.issues.push(it.exceptions + ' two-date pallets - only one allowed per item');
      if (it.shorts > 1) it.issues.push(it.shorts + ' short pallets - normally at most one per item');
      if (plan && plan[c]) {
        var planned = plan[c], all = {};
        Object.keys(planned).concat(Object.keys(it.days)).forEach(function (d) { all[d] = true; });
        Object.keys(all).sort().forEach(function (d) {
          var bb = d, want = planned[bb] || 0, got = it.days[bb] || 0;
          if (want !== got) it.issues.push('best before ' + bb + ': planned ' + want + ', shipped ' + got);
        });
      }
    });
    if (plan) {
      Object.keys(items).forEach(function (c) {
        if (!plan[c]) items[c].issues.push('shipped but not on the planned order lines');
      });
      Object.keys(plan).forEach(function (c) {
        if (!items[c]) problems.push(c + ': on the planned order lines but nothing shipped');
      });
    }
    units.forEach(function (u) { u.issues.forEach(function (x) { problems.push('Pallet ' + u.unit + ': ' + x); }); });
    Object.keys(items).forEach(function (c) { items[c].issues.forEach(function (x) { problems.push(c + ': ' + x); }); });
    return { found: true, palletSize: palletSize, units: units, items: items, problems: problems, ok: problems.length === 0 };
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
    recommendHelloFresh: recommendHelloFresh,
    jbsPorkExclusions: jbsPorkExclusions,
    buildCartonDateIndex: buildCartonDateIndex,
    helloFreshOrderLines: helloFreshOrderLines,
    orderLinesToCsv: orderLinesToCsv,
    checkHelloFreshShipment: checkHelloFreshShipment,
    toUldCsv: toUldCsv,
    mergeConfig: mergeConfig
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else global.AllocationRecommender = API;
})(this);
