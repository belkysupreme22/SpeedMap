/* SpeedMap — app.js */

// ── Firebase config ──────────────────────────────────
var FIREBASE_CONFIG = {
  apiKey:            "AIzaSyB9bddtbyZAHD5XcnBSycPV0vw8qR5Hp9E",
  authDomain:        "speedmap-2a75c.firebaseapp.com",
  projectId:         "speedmap-2a75c",
  storageBucket:     "speedmap-2a75c.firebasestorage.app",
  messagingSenderId: "645772223490",
  appId:             "1:645772223490:web:18eed4a4f5d396c87e731b"
};

// ── App state ────────────────────────────────────────
var state = {
  isp: '', nickname: 'Anonymous',
  networkType: 'unknown',
  location: null, city: '',
  ping: null, download: null, upload: null
};

// ── Firebase ─────────────────────────────────────────
var db = null;

function initFirebase() {
  try {
    if (typeof firebase === 'undefined') { console.warn('Firebase SDK not loaded'); return; }
    if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
    db = firebase.firestore();
    // Force standard HTTPS long-polling over TCP to prevent QUIC (UDP) protocol timeouts / adblocker channel drops
    db.settings({ experimentalForceLongPolling: true });
    console.log('[SpeedMap] Firebase OK');
  } catch (e) { console.warn('[SpeedMap] Firebase init warning:', e); }
}

function dbSave(doc) {
  if (!db) return Promise.resolve(false);
  try {
    return db.collection('speedResults').add(
      Object.assign({}, doc, { ts: firebase.firestore.FieldValue.serverTimestamp() })
    ).then(function() { return true; })
     .catch(function(e) { console.warn('dbSave warning (offline/blocked):', e.message); return false; });
  } catch(e) {
    return Promise.resolve(false);
  }
}

function dbLoad() {
  if (!db) return Promise.resolve([]);
  try {
    var fetchPromise = db.collection('speedResults').limit(600).get()
      .then(function(snap) {
        var list = snap.docs.map(function(d) { return Object.assign({ id: d.id }, d.data()); });
        return list.sort(function(a, b) {
          var ta = a.ts ? (a.ts.toMillis ? a.ts.toMillis() : a.ts) : 0;
          var tb = b.ts ? (b.ts.toMillis ? b.ts.toMillis() : b.ts) : 0;
          return tb - ta;
        });
      });

    // 2-second timeout to prevent 10s Firestore connection stalls
    var timeoutPromise = new Promise(function(resolve) {
      setTimeout(function() { resolve([]); }, 2000);
    });

    return Promise.race([fetchPromise, timeoutPromise]).catch(function() { return []; });
  } catch(e) {
    return Promise.resolve([]);
  }
}

// ── localStorage fallback ───────────────────────────────────────
var LS_KEY = 'speedmap_prod_v1';
function lsSave(doc) {
  var arr = lsLoad();
  arr.push(Object.assign({}, doc, { id: 'local-' + Date.now(), ts: Date.now() }));
  try { localStorage.setItem(LS_KEY, JSON.stringify(arr.slice(-200))); } catch(e) {}
}
function lsLoad() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch(e) { return []; }
}

function allResults() {
  return Promise.all([
    dbLoad().catch(function() { return []; }),
    Promise.resolve(lsLoad())
  ]).then(function(results) {
    var remote = results[0] || [], local = results[1] || [];
    var seen = {};
    return remote.concat(local).filter(function(r) {
      if (!r || seen[r.id]) return false;
      seen[r.id] = true; return true;
    });
  });
}

// ── Filter state ──────────────────────────────────────────
var activeTiers = {}; // { slow:true, mid:true, ... }

function speedTierName(mbps) {
  if (mbps >= 200) return 'ultra';
  if (mbps >= 50)  return 'fast';
  if (mbps >= 10)  return 'mid';
  return 'slow';
}

function toggleFilter(tier) {
  activeTiers[tier] = !activeTiers[tier];
  var anyActive = Object.keys(activeTiers).some(function(t) { return activeTiers[t]; });
  var legend = document.getElementById('map-legend');
  if (legend) legend.classList.toggle('filtering', anyActive);
  document.querySelectorAll('.leg-item').forEach(function(el) {
    el.classList.toggle('active', !!activeTiers[el.dataset.tier]);
  });
  allResults().then(renderMarkers);
}

function clearFilters() {
  activeTiers = {};
  var legend = document.getElementById('map-legend');
  if (legend) legend.classList.remove('filtering');
  document.querySelectorAll('.leg-item').forEach(function(el) { el.classList.remove('active'); });
  allResults().then(renderMarkers);
}

// ── Screen navigation ────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(function(s) {
    s.classList.remove('active');
  });
  var target = document.getElementById(id);
  if (target) target.classList.add('active');
}

// ── Network detection ────────────────────────────────
var NET_LABELS = {
  'home-wifi': '🏠 Home WiFi', 'office-wifi': '🏢 Office WiFi',
  '4g': '4G LTE', '5g': '5G', '3g': '3G',
  'fiber': '⚡ Fiber', 'cable': '🔌 Cable',
  'satellite': '🛰 Satellite', 'unknown': 'Unknown'
};

function detectNetwork() {
  var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!conn) {
    return /mobile|android|iphone/i.test(navigator.userAgent) ? '4g' : 'home-wifi';
  }
  var type = conn.type, eff = conn.effectiveType, dl = conn.downlink || 0;
  if (type === 'wifi')     return 'home-wifi';
  if (type === 'ethernet') return dl > 200 ? 'fiber' : 'cable';
  if (type === 'cellular') return eff === '4g' ? '4g' : '3g';
  if (eff === '4g')  return '4g';
  if (eff === '3g')  return '3g';
  if (eff === '2g' || eff === 'slow-2g') return '3g';
  return 'home-wifi';
}

// ── Geolocation ──────────────────────────────────────
function getLocation() {
  return new Promise(function(resolve) {
    if (!navigator.geolocation) { ipGeoFallback(resolve); return; }
    navigator.geolocation.getCurrentPosition(
      function(pos) { resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }); },
      function()    { ipGeoFallback(resolve); },
      { timeout: 7000, enableHighAccuracy: false }
    );
  });
}

function ipGeoFallback(resolve) {
  fetch('https://ipapi.co/json/', { cache: 'no-store' })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      state.city = d.city || '';
      resolve({ lat: parseFloat(d.latitude), lng: parseFloat(d.longitude) });
    })
    .catch(function() { resolve(null); });
}

function reverseGeocode(lat, lng) {
  return fetch(
    'https://nominatim.openstreetmap.org/reverse?format=json&lat=' + lat + '&lon=' + lng,
    { headers: { 'Accept-Language': 'en' } }
  ).then(function(r) { return r.json(); })
   .then(function(d) {
     var a = d.address || {};
     return a.city || a.town || a.village || a.county || a.state || '';
   })
   .catch(function() { return ''; });
}

// ── Speed test ───────────────────────────────────────
function measurePing() {
  var pingUrl = 'https://speed.cloudflare.com/__down?bytes=1024';
  var times = [];
  var chain = Promise.resolve();
  for (var i = 0; i < 5; i++) {
    (function() {
      chain = chain.then(function() {
        var t = performance.now();
        return fetch(pingUrl + '&r=' + Math.random(), { cache: 'no-store' })
          .then(function() { times.push(performance.now() - t); })
          .catch(function() {});
      });
    })();
  }
  return chain.then(function() {
    if (!times.length) return null;
    return Math.round(times.reduce(function(a, b) { return a + b; }) / times.length);
  });
}

function measureDownload(onProgress) {
  var dlUrl = 'https://speed.cloudflare.com/__down?bytes=25000000&r=' + Math.random();
  return fetch(dlUrl, { cache: 'no-store' }).then(function(res) {
    var reader = res.body.getReader();
    var bytes = 0, t0 = performance.now();
    function pump() {
      return reader.read().then(function(result) {
        if (result.done) {
          var total = (performance.now() - t0) / 1000;
          return parseFloat(((bytes * 8) / (total * 1e6)).toFixed(2));
        }
        bytes += result.value.length;
        var elapsed = (performance.now() - t0) / 1000;
        if (elapsed > 0.15) onProgress((bytes * 8) / (elapsed * 1e6));
        return pump();
      });
    }
    return pump();
  }).catch(function(e) { console.warn('Download test error:', e); return null; });
}

function measureUpload(onProgress) {
  var SIZE = 10 * 1024 * 1024;
  var body = new Uint8Array(SIZE);
  var t0 = performance.now(), tick = 0;
  var iv = setInterval(function() {
    tick++;
    onProgress(Math.min(tick * 3.5, 80));
  }, 220);
  return fetch('https://speed.cloudflare.com/__up', {
    method: 'POST', body: body.buffer, cache: 'no-store'
  }).then(function() {
    clearInterval(iv);
    var elapsed = (performance.now() - t0) / 1000;
    var mbps = parseFloat(((SIZE * 8) / (elapsed * 1e6)).toFixed(2));
    onProgress(mbps);
    return mbps;
  }).catch(function(e) {
    clearInterval(iv);
    console.warn('Upload test error:', e);
    return null;
  });
}

// ── Step UI ──────────────────────────────────────────
var GAUGE_LEN = 232.5;

function setStep(id, status, val) {
  var el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('active', 'done', 'error');
  if (status) el.classList.add(status);
  if (val !== undefined) {
    var sv = el.querySelector('.step-val');
    if (sv) sv.textContent = val;
  }
}

function setGauge(value, unit, max) {
  var pct = Math.min(value / max, 1);
  var arc = document.getElementById('gauge-arc');
  if (arc) arc.style.strokeDashoffset = GAUGE_LEN - pct * GAUGE_LEN;
  var gv = document.getElementById('gauge-val');
  if (gv) gv.textContent = value < 10 ? value.toFixed(1) : Math.round(value);
  var gu = document.getElementById('gauge-unit');
  if (gu) gu.textContent = unit;
}

function setStatus(text) {
  var el = document.getElementById('test-status');
  if (el) el.textContent = text;
}

function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

// ── Run test ─────────────────────────────────────────
function startTest() {
  var ispEl  = document.getElementById('isp-input');
  var nickEl = document.getElementById('nick-input');
  state.isp      = ispEl ? (ispEl.value || '').trim() : '';
  state.nickname = nickEl ? (nickEl.value || '').trim() || 'Anonymous' : 'Anonymous';
  state.ping = state.download = state.upload = null;
  state.city = ''; state.location = null; state.networkType = 'unknown';

  // Reset test card UI
  var gw = document.getElementById('gauge-wrap');
  var sl = document.getElementById('steps-list');
  var ts = document.getElementById('test-status');
  var rv = document.getElementById('result-view');
  if (gw) gw.style.display = '';
  if (sl) sl.style.display = '';
  if (ts) ts.style.display = '';
  if (rv) rv.classList.remove('show');

  ['s-network','s-location','s-ping','s-dl','s-ul'].forEach(function(id) {
    setStep(id, '', '—');
  });
  setGauge(0, 'Mbps', 500);
  setStatus('Starting…');

  showScreen('screen-test');
  runTest();
}

function runTest() {
  // Step 1: Network
  setStep('s-network', 'active', '—');
  setStatus('Detecting network…');
  state.networkType = detectNetwork();
  setStep('s-network', 'done', NET_LABELS[state.networkType] || state.networkType);

  // Step 2: Location
  setStep('s-location', 'active', '—');
  setStatus('Getting location…');

  getLocation().then(function(loc) {
    state.location = loc;
    if (!loc) {
      setStep('s-location', 'error', 'Unavailable');
      return Promise.resolve();
    }
    var displayStr = state.city || (loc.lat.toFixed(2) + ', ' + loc.lng.toFixed(2));
    if (!state.city) {
      return reverseGeocode(loc.lat, loc.lng).then(function(city) {
        state.city = city;
        setStep('s-location', 'done', city || displayStr);
      });
    }
    setStep('s-location', 'done', displayStr);
    return Promise.resolve();
  }).then(function() {

    // Step 3: Ping
    setStep('s-ping', 'active', '—');
    setStatus('Measuring ping…');
    setGauge(0, 'ms', 300);

    return measurePing();
  }).then(function(ping) {
    state.ping = ping;
    if (ping !== null) {
      setGauge(Math.min(ping, 300), 'ms', 300);
      setStep('s-ping', 'done', ping + ' ms');
    } else {
      setStep('s-ping', 'error', 'n/a');
    }

    // Step 4: Download
    setStep('s-dl', 'active', '—');
    setStatus('Downloading 25 MB…');
    setGauge(0, 'Mbps', 500);

    return measureDownload(function(mbps) {
      setGauge(mbps, 'Mbps', 500);
      setStep('s-dl', 'active', mbps.toFixed(1) + ' Mbps');
    });
  }).then(function(dl) {
    state.download = dl;
    if (dl !== null) {
      setGauge(dl, 'Mbps', 500);
      setStep('s-dl', 'done', dl + ' Mbps');
    } else {
      setStep('s-dl', 'error', 'n/a');
    }

    // Step 5: Upload
    setStep('s-ul', 'active', '—');
    setStatus('Uploading 10 MB…');
    setGauge(0, 'Mbps', 200);

    return measureUpload(function(mbps) {
      setGauge(mbps, 'Mbps', 200);
      setStep('s-ul', 'active', mbps.toFixed(1) + ' Mbps');
    });
  }).then(function(ul) {
    state.upload = ul;
    if (ul !== null) {
      setGauge(ul, 'Mbps', 200);
      setStep('s-ul', 'done', ul + ' Mbps');
    } else {
      setStep('s-ul', 'error', 'n/a');
    }

    setStatus('Saving result…');

    var record = {
      lat:         state.location ? state.location.lat : 0,
      lng:         state.location ? state.location.lng : 0,
      download:    state.download || 0,
      upload:      state.upload   || 0,
      ping:        state.ping     || 0,
      networkType: state.networkType,
      isp:         state.isp,
      nickname:    state.nickname,
      city:        state.city
    };

    return dbSave(record).then(function(ok) {
      lsSave(record);

      // Reveal result view
      var gw = document.getElementById('gauge-wrap');
      var sl = document.getElementById('steps-list');
      var ts = document.getElementById('test-status');
      var rv = document.getElementById('result-view');
      if (gw) gw.style.display = 'none';
      if (sl) sl.style.display = 'none';
      if (ts) ts.style.display = 'none';

      var nfNum  = document.getElementById('rv-num');
      var nfUl   = document.getElementById('rv-ul');
      var nfPing = document.getElementById('rv-ping');
      if (nfNum)  animateNumber(nfNum, parseFloat(record.download) || 0, 1000, 1);
      if (nfUl)   animateNumber(nfUl, parseFloat(record.upload)   || 0, 1000, 1);
      if (nfPing) animateNumber(nfPing, parseInt(record.ping)      || 0, 1000, 0);

      var rvPill = document.getElementById('rv-pill');
      var rvNet  = document.getElementById('rv-net');
      var rvCity = document.getElementById('rv-city');
      var rvNote = document.getElementById('rv-note');
      if (rvPill) rvPill.textContent = NET_LABELS[state.networkType] || state.networkType;
      if (rvNet)  rvNet.textContent  = NET_LABELS[state.networkType] || '—';
      if (rvCity) rvCity.textContent = state.city || 'Unknown';
      if (rvNote) rvNote.textContent = ok
        ? '🌍 Saved to global map — opening now…'
        : '💾 Saved locally — opening map…';
      if (rv) rv.classList.add('show');

      showToast(ok ? '🌍 Result saved to global map' : '💾 Saved locally', ok ? 'ok' : 'warn');

      return wait(2200);
    });
  }).then(function() {
    goToMap();
  }).catch(function(err) {
    console.error('[SpeedMap] Test error:', err);
    setStatus('Error: ' + err.message);
  });
}

// ── Map ──────────────────────────────────────────────
var leafMap     = null;
var markerLayer = null;
var heatLayer   = null;
var layerMode   = 'markers';

function goToMap() {
  showScreen('screen-map');

  if (!leafMap) {
    if (typeof L === 'undefined') {
      console.warn('Leaflet not loaded');
      return;
    }
    leafMap = L.map('map', { center: [20, 10], zoom: 2, zoomControl: false });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '© <a href="https://carto.com/">CARTO</a> © <a href="https://openstreetmap.org/copyright">OSM</a>',
      subdomains: 'abcd', maxZoom: 19
    }).addTo(leafMap);
    L.control.zoom({ position: 'bottomright' }).addTo(leafMap);
    markerLayer = L.layerGroup().addTo(leafMap);
  }

  // Show result pills in bar if we have results
  if (state.download !== null) {
    var br = document.getElementById('bar-results');
    if (br) {
      br.innerHTML =
        '<div class="brs"><span class="brs-l">Download</span><span class="brs-v">' + (state.download||'—') + '</span><span class="brs-u">Mbps</span></div>' +
        '<div class="brs"><span class="brs-l">Upload</span><span class="brs-v">' + (state.upload||'—') + '</span><span class="brs-u">Mbps</span></div>' +
        '<div class="brs"><span class="brs-l">Ping</span><span class="brs-v">' + (state.ping||'—') + '</span><span class="brs-u">ms</span></div>' +
        '<div class="brs"><span class="brs-l">Network</span><span class="brs-v brs-v-sm">' + (NET_LABELS[state.networkType]||'—') + '</span></div>';
    }
  }

  allResults().then(function(results) {
    renderMarkers(results);
    updateStats(results);
    if (!results || results.length === 0) {
      showToast('⚡ No tests recorded yet! Run a test to be the first on the map.', 'warn');
    }
  });
}

function speedColor(mbps) {
  if (mbps >= 200) return '#38bdf8';
  if (mbps >= 50)  return '#22c55e';
  if (mbps >= 10)  return '#f97316';
  return '#ef4444';
}

function timeAgo(ts) {
  if (!ts) return '';
  var ms = ts.toDate ? ts.toDate().getTime() : +ts;
  var s  = (Date.now() - ms) / 1000;
  if (s < 60)    return 'just now';
  if (s < 3600)  return Math.round(s/60) + 'm ago';
  if (s < 86400) return Math.round(s/3600) + 'h ago';
  return Math.round(s/86400) + 'd ago';
}

function renderMarkers(results) {
  if (!leafMap || !markerLayer) return;
  markerLayer.clearLayers();
  if (heatLayer) { leafMap.removeLayer(heatLayer); heatLayer = null; }

  var emptyBanner = document.getElementById('map-empty-banner');
  if (!results || results.length === 0) {
    if (!emptyBanner) {
      emptyBanner = document.createElement('div');
      emptyBanner.id = 'map-empty-banner';
      emptyBanner.className = 'map-empty-banner';
      emptyBanner.innerHTML = '<span>⚡ No speed tests mapped yet.</span> <button onclick="startTest()">Be the first to contribute!</button>';
      document.getElementById('screen-map').appendChild(emptyBanner);
    }
    emptyBanner.style.display = 'flex';
    return;
  } else if (emptyBanner) {
    emptyBanner.style.display = 'none';
  }

  var anyTierActive = Object.keys(activeTiers).some(function(t) { return activeTiers[t]; });
  var heat = [];

  results.forEach(function(r) {
    var dl   = r.download || 0;
    var tier = speedTierName(dl);

    if (!r.lat && !r.lng) return;

    if (anyTierActive && !activeTiers[tier]) return;

    var col  = speedColor(dl);

    if (layerMode === 'markers') {
      var size = Math.max(6, Math.min(13, 6 + dl / 70));
      var m = L.circleMarker([r.lat, r.lng], {
        radius: size, fillColor: col,
        color: 'rgba(0,0,0,0.35)', weight: 1.5,
        fillOpacity: 0.88, opacity: 1
      });

      var nick = r.nickname || 'Anonymous';
      var net  = NET_LABELS[r.networkType] || r.networkType || '?';
      var isp  = r.isp  ? '<span>' + r.isp + '</span>'      : '';
      var city = r.city ? '<span>📍 ' + r.city + '</span>'  : '';
      var ago  = timeAgo(r.ts || r.timestamp);
      var foot = [isp, city].filter(Boolean).join(' · ');

      var tierTagClass = 'pop-tier-' + tier;
      var tierTagLabel = tier === 'ultra' ? '⚡ Ultra' : tier === 'fast' ? '🟢 Fast' : tier === 'mid' ? '🟠 Mid' : '🔴 Slow';

      m.bindPopup(
        '<div class="pop">' +
          '<div class="pop-top">' +
            '<span class="pop-nick">' + nick + '</span>' +
            '<span class="pop-net">' + net + '</span>' +
          '</div>' +
          '<div class="pop-base">' +
            '<div>' +
              '<div class="pop-base-label">Base Speed</div>' +
              '<div class="pop-base-val">' + dl + ' <span style="font-size:.68rem;font-weight:500;color:var(--t2)">Mbps</span></div>' +
            '</div>' +
            '<span class="pop-tier-tag ' + tierTagClass + '">' + tierTagLabel + '</span>' +
          '</div>' +
          '<div class="pop-metrics">' +
            '<div class="pop-m pop-m-dl">' +
              '<span class="pop-ml">↓ Download</span>' +
              '<span class="pop-mv">' + dl + '</span>' +
            '</div>' +
            '<div class="pop-m pop-m-ul">' +
              '<span class="pop-ml">↑ Upload</span>' +
              '<span class="pop-mv">' + (r.upload || '—') + '</span>' +
            '</div>' +
            '<div class="pop-m pop-m-ping">' +
              '<span class="pop-ml">⚡ Ping</span>' +
              '<span class="pop-mv">' + (r.ping ? r.ping + ' ms' : '—') + '</span>' +
            '</div>' +
          '</div>' +
          '<div class="pop-footer"><span>' + foot + '</span><span>' + ago + '</span></div>' +
        '</div>',
        { maxWidth: 260, minWidth: 220 }
      );
      markerLayer.addLayer(m);
    }

    heat.push([r.lat, r.lng, Math.min(dl / 200, 1)]);
  });

  if (layerMode === 'heat' && heat.length && typeof L.heatLayer === 'function') {
    heatLayer = L.heatLayer(heat, {
      radius: 32, blur: 22, maxZoom: 12,
      gradient: { 0.15: '#ef4444', 0.4: '#f97316', 0.7: '#22c55e', 1.0: '#38bdf8' }
    }).addTo(leafMap);
  }

  if (state.location && layerMode === 'markers') {
    var icon = L.divIcon({
      html: '<div class="user-pin"><div class="user-pin-dot"></div></div>',
      className: '', iconSize: [20,20], iconAnchor: [10,10]
    });
    var uDl = state.download || 0;
    var uTier = speedTierName(uDl);
    var uTagClass = 'pop-tier-' + uTier;
    var uTagLabel = uTier === 'ultra' ? '⚡ Ultra' : uTier === 'fast' ? '🟢 Fast' : uTier === 'mid' ? '🟠 Mid' : '🔴 Slow';

    var userPopup =
      '<div class="pop">' +
        '<div class="pop-top">' +
          '<span class="pop-nick">' + (state.nickname || 'You') + '</span>' +
          '<span class="pop-net">' + (NET_LABELS[state.networkType] || state.networkType) + '</span>' +
        '</div>' +
        '<div class="pop-base">' +
          '<div>' +
            '<div class="pop-base-label">Base Speed</div>' +
            '<div class="pop-base-val">' + uDl + ' <span style="font-size:.68rem;font-weight:500;color:var(--t2)">Mbps</span></div>' +
          '</div>' +
          '<span class="pop-tier-tag ' + uTagClass + '">' + uTagLabel + '</span>' +
        '</div>' +
        '<div class="pop-metrics">' +
          '<div class="pop-m pop-m-dl">' +
            '<span class="pop-ml">↓ Download</span>' +
            '<span class="pop-mv">' + (state.download || '—') + '</span>' +
          '</div>' +
          '<div class="pop-m pop-m-ul">' +
            '<span class="pop-ml">↑ Upload</span>' +
            '<span class="pop-mv">' + (state.upload || '—') + '</span>' +
          '</div>' +
          '<div class="pop-m pop-m-ping">' +
            '<span class="pop-ml">⚡ Ping</span>' +
            '<span class="pop-mv">' + (state.ping ? state.ping + ' ms' : '—') + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="pop-footer"><span>📍 ' + (state.city || 'Your location') + '</span><span>just now</span></div>' +
      '</div>';
    L.marker([state.location.lat, state.location.lng], { icon })
     .bindPopup(userPopup, { maxWidth: 260, minWidth: 220 })
     .addTo(markerLayer);
  }
}

function toggleLayer(mode) {
  layerMode = mode;
  document.getElementById('btn-markers').classList.toggle('active', mode === 'markers');
  document.getElementById('btn-heat').classList.toggle('active', mode === 'heat');
  allResults().then(renderMarkers);
}

// ── Number animation helper ─────────────────────────
function animateNumber(el, targetVal, duration, decimals) {
  if (!el) return;
  var startVal = parseFloat(el.textContent) || 0;
  var startTime = null;
  duration = duration || 800;
  decimals = decimals !== undefined ? decimals : 0;

  function step(timestamp) {
    if (!startTime) startTime = timestamp;
    var progress = Math.min((timestamp - startTime) / duration, 1);
    // Ease out cubic
    var easeProgress = 1 - Math.pow(1 - progress, 3);
    var currentVal = startVal + (targetVal - startVal) * easeProgress;
    el.textContent = currentVal.toFixed(decimals);
    if (progress < 1) {
      requestAnimationFrame(step);
    } else {
      el.textContent = targetVal.toFixed(decimals);
    }
  }
  requestAnimationFrame(step);
}

// ── Welcome stats ────────────────────────────────────
function updateStats(results) {
  var list = results || [];
  var dls = list.filter(function(r) { return r && r.download > 0; }).map(function(r) { return r.download; });
  var count = list.length;
  var avg   = dls.length ? parseFloat((dls.reduce(function(a,b){return a+b;}, 0) / dls.length).toFixed(1)) : 0;

  var nfCount = document.getElementById('nf-count');
  var nfAvg   = document.getElementById('nf-avg');

  if (nfCount) animateNumber(nfCount, count, 800, 0);
  if (nfAvg)   animateNumber(nfAvg, avg, 800, 1);
}

// ── Toast ─────────────────────────────────────────────
var toastTimer = null;
function showToast(msg, type) {
  var el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'toast ' + (type||'') + ' show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function() { el.classList.remove('show'); }, 4000);
}

// ── Wire up all buttons ───────────────────────────────
document.addEventListener('DOMContentLoaded', function() {
  initFirebase();

  // Instant render from local storage first
  updateStats(lsLoad());

  var btnStart   = document.getElementById('btn-start');
  var btnViewMap = document.getElementById('btn-viewmap');
  var btnNavTest = document.getElementById('btn-nav-test');
  var btnNavMap  = document.getElementById('btn-nav-map');
  var btnMarkers = document.getElementById('btn-markers');
  var btnHeat    = document.getElementById('btn-heat');
  var btnRetest  = document.getElementById('btn-retest');

  if (btnStart)   btnStart.addEventListener('click', startTest);
  if (btnNavTest) btnNavTest.addEventListener('click', startTest);
  if (btnViewMap) btnViewMap.addEventListener('click', goToMap);
  if (btnNavMap)  btnNavMap.addEventListener('click', goToMap);
  if (btnMarkers) btnMarkers.addEventListener('click', function() { toggleLayer('markers'); });
  if (btnHeat)    btnHeat.addEventListener('click', function() { toggleLayer('heat'); });
  if (btnRetest)  btnRetest.addEventListener('click', function() { showScreen('screen-welcome'); });

  // Navigation back to Landing Page on logo/brand click
  document.querySelectorAll('.wordmark, .bar-brand').forEach(function(el) {
    el.addEventListener('click', function() { showScreen('screen-welcome'); });
  });

  document.querySelectorAll('.leg-item').forEach(function(el) {
    el.addEventListener('click', function() { toggleFilter(el.dataset.tier); });
  });
  var legClear = document.getElementById('leg-clear');
  if (legClear) legClear.addEventListener('click', clearFilters);

  // Fetch full remote results and update stats
  allResults().then(updateStats).catch(function(e){ console.warn('Stats load warning:', e); });
});
