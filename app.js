/* SpeedMap — app.js */

// ── Firebase config ──────────────────────────────────
var env = window.ENV || {};
var FIREBASE_CONFIG = window.FIREBASE_CONFIG || {
  apiKey:            env.FIREBASE_API_KEY || "",
  authDomain:        env.FIREBASE_AUTH_DOMAIN || "speedmap-2a75c.firebaseapp.com",
  projectId:         env.FIREBASE_PROJECT_ID || "speedmap-2a75c",
  storageBucket:     env.FIREBASE_STORAGE_BUCKET || "speedmap-2a75c.firebasestorage.app",
  messagingSenderId: env.FIREBASE_MESSAGING_SENDER_ID || "645772223490",
  appId:             env.FIREBASE_APP_ID || ""
};

// ── Device detection ─────────────────────────────────
function detectDevice() {
  var ua = navigator.userAgent || '';
  if (/iphone/i.test(ua))  return 'iPhone';
  if (/ipad/i.test(ua))    return 'iPad';
  if (/android/i.test(ua)) return 'Android';
  if (/macintosh|mac os x/i.test(ua)) return 'Mac';
  if (/windows/i.test(ua)) return 'Windows PC';
  if (/linux/i.test(ua))   return 'Linux PC';

  var isMobile = /mobi|touch/i.test(ua) || (window.innerWidth <= 768) || (navigator.maxTouchPoints > 0);
  return isMobile ? 'Mobile Device' : 'Desktop Web';
}

// ── App state ────────────────────────────────────────
var state = {
  isp: '', nickname: 'Anonymous',
  device: '', networkType: 'unknown',
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
  var num = parseFloat(mbps) || 0;
  if (num >= 100) return 'ultra';
  if (num >= 25)  return 'fast';
  if (num >= 10)  return 'mid';
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
  'home-wifi': 'Home WiFi', 'office-wifi': 'Office WiFi',
  '4g': '4G LTE', '5g': '5G', '3g': '3G',
  'fiber': 'Fiber', 'cable': 'Cable',
  'satellite': 'Satellite', 'unknown': 'Unknown'
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

function detectIspAndCity() {
  return fetch('https://ipapi.co/json/', { cache: 'no-store' })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (d) {
        if (!state.isp) {
          var rawIsp = d.org || d.asn || d.isp || '';
          state.isp = rawIsp.replace(/^AS\d+\s*/i, '').trim();
        }
        if (!state.city && d.city) {
          state.city = d.city;
        }
      }
      return d;
    })
    .catch(function() { return null; });
}

function ipGeoFallback(resolve) {
  detectIspAndCity().then(function(d) {
    if (d && d.latitude && d.longitude) {
      resolve({ lat: parseFloat(d.latitude), lng: parseFloat(d.longitude) });
    } else {
      resolve(null);
    }
  });
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
  state.device   = detectDevice();
  state.isp      = '';
  state.nickname = 'Anonymous';
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
  // Step 1: Network & Device
  setStep('s-network', 'active', '—');
  setStatus('Detecting network & device…');
  state.networkType = detectNetwork();
  state.device = detectDevice();
  setStep('s-network', 'done', (NET_LABELS[state.networkType] || state.networkType) + ' · ' + state.device);

  // Step 2: Location & ISP Auto-Detection
  setStep('s-location', 'active', '—');
  setStatus('Getting location & network ISP…');

  Promise.all([
    getLocation(),
    detectIspAndCity()
  ]).then(function(results) {
    var loc = results[0];
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
      device:      state.device,
      isp:         state.isp,
      nickname:    'Anonymous',
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

      var rvPill   = document.getElementById('rv-pill');
      var rvNet    = document.getElementById('rv-net');
      var rvDevice = document.getElementById('rv-device');
      var rvCity   = document.getElementById('rv-city');
      var rvIsp    = document.getElementById('rv-isp');
      var rvNote   = document.getElementById('rv-note');

      if (rvPill)   rvPill.textContent   = NET_LABELS[state.networkType] || state.networkType;
      if (rvNet)    rvNet.textContent    = NET_LABELS[state.networkType] || '—';
      if (rvDevice) rvDevice.textContent = state.device || 'Unknown';
      if (rvCity)   rvCity.textContent   = state.city || 'Unknown';
      if (rvIsp)    rvIsp.textContent    = state.isp || 'Auto-Detected';
      if (rvNote)   rvNote.textContent   = ok
        ? 'Result saved & mapped globally'
        : 'Result saved locally';
      if (rv) rv.classList.add('show');

      showToast(ok ? 'Result saved to global map' : 'Saved locally', ok ? 'ok' : 'warn');
    });
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
      showToast('No tests recorded yet. Run a test to contribute!', 'warn');
    }
  });
}

function speedColor(mbps) {
  var num = parseFloat(mbps) || 0;
  if (num >= 100) return '#38bdf8';
  if (num >= 25)  return '#22c55e';
  if (num >= 10)  return '#f97316';
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
      emptyBanner.innerHTML = '<span>No speed tests mapped yet.</span> <button onclick="startTest()">Be the first to contribute!</button>';
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

      var net      = NET_LABELS[r.networkType] || r.networkType || 'Connection';
      var hasIsp   = r.isp && r.isp.trim() && r.isp.trim().toLowerCase() !== 'unknown' && r.isp.trim().toLowerCase() !== 'unknown provider';
      var isp      = hasIsp ? r.isp.trim() : 'Unknown Provider';
      var city     = r.city || 'Global Location';
      var device   = r.device || 'Desktop Web';
      var ago      = timeAgo(r.ts || r.timestamp);

      var tierTagClass = 'pop-tier-' + tier;
      var tierTagLabel = tier.toUpperCase();

      m.bindPopup(
        '<div class="pop">' +
          '<div class="pop-top">' +
            '<span class="pop-provider" title="' + isp + '">' + isp + '</span>' +
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
              '<span class="pop-mv">' + (r.upload ? r.upload : '—') + '</span>' +
            '</div>' +
            '<div class="pop-m pop-m-ping">' +
              '<span class="pop-ml">Ping</span>' +
              '<span class="pop-mv">' + (r.ping ? r.ping + ' ms' : '—') + '</span>' +
            '</div>' +
          '</div>' +
          '<div class="pop-detail-row">' +
            '<span class="pop-detail-item">Device: <strong>' + device + '</strong></span>' +
            '<span class="pop-detail-item">City: <strong>' + city + '</strong></span>' +
          '</div>' +
          '<div class="pop-footer"><span>Verified Test</span><span>' + ago + '</span></div>' +
        '</div>',
        { maxWidth: 280, minWidth: 240 }
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
    var uDl = state.download || 0;
    var uTier = speedTierName(uDl);

    if (!anyTierActive || activeTiers[uTier]) {
      var icon = L.divIcon({
        html: '<div class="user-pin"><div class="user-pin-dot"></div></div>',
        className: '', iconSize: [20,20], iconAnchor: [10,10]
      });
      var uTagClass = 'pop-tier-' + uTier;
      var uTagLabel = uTier === 'ultra' ? 'Ultra' : uTier === 'fast' ? 'Fast' : uTier === 'mid' ? 'Mid' : 'Slow';

    var hasUIsp  = state.isp && state.isp.trim() && state.isp.trim().toLowerCase() !== 'unknown' && state.isp.trim().toLowerCase() !== 'unknown provider';
    var uIsp     = hasUIsp ? state.isp.trim() : 'Unknown Provider';
    var userPopup =
      '<div class="pop">' +
        '<div class="pop-top">' +
          '<span class="pop-provider" title="' + uIsp + '">' + uIsp + '</span>' +
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
            '<span class="pop-mv">' + (state.download ? state.download.toFixed(1) : '—') + '</span>' +
          '</div>' +
          '<div class="pop-m pop-m-ul">' +
            '<span class="pop-ml">↑ Upload</span>' +
            '<span class="pop-mv">' + (state.upload ? state.upload.toFixed(1) : '—') + '</span>' +
          '</div>' +
          '<div class="pop-m pop-m-ping">' +
            '<span class="pop-ml">Ping</span>' +
            '<span class="pop-mv">' + (state.ping ? state.ping + ' ms' : '—') + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="pop-detail-row">' +
          '<span class="pop-detail-item">Device: <strong>' + (state.device || 'Desktop') + '</strong></span>' +
          '<span class="pop-detail-item">City: <strong>' + (state.city || 'Your Location') + '</strong></span>' +
        '</div>' +
        '<div class="pop-footer"><span>Your Active Pin</span><span>just now</span></div>' +
      '</div>';
    L.marker([state.location.lat, state.location.lng], { icon })
     .bindPopup(userPopup, { maxWidth: 280, minWidth: 240 })
     .addTo(markerLayer);
    }
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

// ── Leaderboard Screen & Skeleton UI ────────────────
var currentLbTab = 'isps';
var lbCurrentPage = 1;
var ITEMS_PER_PAGE = 3;

function openLeaderboard() {
  lbCurrentPage = 1;
  showScreen('screen-leaderboard');
  renderLeaderboard(currentLbTab);
}

function renderSkeletons() {
  var html = '<div class="lb-list-rich">';
  for (var i = 0; i < 5; i++) {
    html += '<div class="skeleton-box lb-skeleton-row"></div>';
  }
  html += '</div>';
  return html;
}

function renderLeaderboard(tab, page) {
  if (tab !== currentLbTab) {
    currentLbTab = tab;
    lbCurrentPage = 1;
  } else if (page !== undefined) {
    lbCurrentPage = page;
  }

  document.querySelectorAll('.lb-tab').forEach(function(el) {
    el.classList.toggle('active', el.dataset.tab === currentLbTab);
  });

  var contentEl = document.getElementById('lb-content');
  if (contentEl) contentEl.innerHTML = renderSkeletons();

  allResults().then(function(results) {
    if (!contentEl) return;

    var list = results || [];

    // Populate summary header metrics
    var peakVal = 0, peakObj = null;
    var ispsSet = {};
    var totalPing = 0, pingCount = 0;

    list.forEach(function(r) {
      if (r.download > peakVal) { peakVal = r.download; peakObj = r; }
      if (r.isp && r.isp.trim() && r.isp.trim().toLowerCase() !== 'unknown' && r.isp.trim().toLowerCase() !== 'unknown provider') {
        ispsSet[r.isp.trim().toLowerCase()] = true;
      }
      if (r.ping > 0) { totalPing += r.ping; pingCount++; }
    });

    var peakEl = document.getElementById('lb-stat-peak');
    var peakSub = document.getElementById('lb-stat-peak-sub');
    var ispsEl = document.getElementById('lb-stat-isps');
    var pingEl = document.getElementById('lb-stat-ping');

    if (peakEl) animateNumber(peakEl, peakVal || 0, 800, 1);
    if (peakSub) {
      var locText = peakObj ? [peakObj.city, peakObj.isp || NET_LABELS[peakObj.networkType]].filter(Boolean).join(' · ') : 'Global Benchmark';
      peakSub.textContent = locText || 'Global Benchmark';
    }
    var totalIspsCount = Object.keys(ispsSet).length || (list.length ? 1 : 0);
    if (ispsEl) animateNumber(ispsEl, totalIspsCount, 800, 0);

    var avgPingVal = pingCount ? Math.round(totalPing / pingCount) : 0;
    if (pingEl) animateNumber(pingEl, avgPingVal, 800, 0);

    if (!list.length) {
      contentEl.innerHTML = '<p class="rv-note">No test data recorded yet. Run a speed test to contribute!</p>';
      return;
    }

    // ── TAB: Speed Tiers Distribution ──────────────────
    if (currentLbTab === 'tiers') {
      var tiers = { ultra: 0, fast: 0, mid: 0, slow: 0 };
      list.forEach(function(r) {
        var t = speedTierName(r.download || 0);
        tiers[t]++;
      });
      var total = list.length;

      contentEl.innerHTML =
        '<div class="tier-dist-grid">' +
          '<div class="tier-dist-card">' +
            '<div class="tdc-header"><span class="tdc-title" style="color:#38bdf8">Ultra (100+ Mbps)</span><span class="pop-tier-tag pop-tier-ultra">Ultra</span></div>' +
            '<div class="tdc-pct">' + Math.round((tiers.ultra/total)*100) + '%</div>' +
            '<div class="tdc-count">' + tiers.ultra + ' of ' + total + ' tests</div>' +
          '</div>' +
          '<div class="tier-dist-card">' +
            '<div class="tdc-header"><span class="tdc-title" style="color:#22c55e">Fast (25-100 Mbps)</span><span class="pop-tier-tag pop-tier-fast">Fast</span></div>' +
            '<div class="tdc-pct">' + Math.round((tiers.fast/total)*100) + '%</div>' +
            '<div class="tdc-count">' + tiers.fast + ' of ' + total + ' tests</div>' +
          '</div>' +
          '<div class="tier-dist-card">' +
            '<div class="tdc-header"><span class="tdc-title" style="color:#f97316">Mid (10-25 Mbps)</span><span class="pop-tier-tag pop-tier-mid">Mid</span></div>' +
            '<div class="tdc-pct">' + Math.round((tiers.mid/total)*100) + '%</div>' +
            '<div class="tdc-count">' + tiers.mid + ' of ' + total + ' tests</div>' +
          '</div>' +
          '<div class="tier-dist-card">' +
            '<div class="tdc-header"><span class="tdc-title" style="color:#ef4444">Slow (<10 Mbps)</span><span class="pop-tier-tag pop-tier-slow">Slow</span></div>' +
            '<div class="tdc-pct">' + Math.round((tiers.slow/total)*100) + '%</div>' +
            '<div class="tdc-count">' + tiers.slow + ' of ' + total + ' tests</div>' +
          '</div>' +
        '</div>';
      return;
    }

    // ── TAB: ISPs or Cities (with Unknown Filter & Pagination) ──
    var groups = {};
    list.forEach(function(r) {
      if (currentLbTab === 'isps') {
        if (!r.isp || !r.isp.trim() || r.isp.trim().toLowerCase() === 'unknown' || r.isp.trim().toLowerCase() === 'unknown provider') return;
      }
      if (currentLbTab === 'cities') {
        if (!r.city || !r.city.trim() || r.city.trim().toLowerCase() === 'unknown' || r.city.trim().toLowerCase() === 'unknown location') return;
      }
      var key = currentLbTab === 'isps' ? r.isp.trim() : r.city.trim();
      if (!groups[key]) groups[key] = { count: 0, totalDl: 0, totalUl: 0, totalPing: 0, pings: 0 };
      groups[key].count++;
      groups[key].totalDl += (r.download || 0);
      groups[key].totalUl += (r.upload || 0);
      if (r.ping > 0) { groups[key].totalPing += r.ping; groups[key].pings++; }
    });

    var sorted = Object.keys(groups).map(function(k) {
      var g = groups[k];
      return {
        name: k,
        count: g.count,
        avgDl: parseFloat((g.totalDl / g.count).toFixed(1)),
        avgUl: parseFloat((g.totalUl / g.count).toFixed(1)),
        avgPing: g.pings ? Math.round(g.totalPing / g.pings) : null
      };
    }).sort(function(a, b) { return b.avgDl - a.avgDl; });

    if (!sorted.length) {
      contentEl.innerHTML = '<p class="rv-note">No verified ' + (currentLbTab === 'isps' ? 'ISPs' : 'locations') + ' recorded yet.</p>';
      return;
    }

    var totalPages = Math.max(1, Math.ceil(sorted.length / ITEMS_PER_PAGE));
    if (lbCurrentPage > totalPages) lbCurrentPage = totalPages;
    if (lbCurrentPage < 1) lbCurrentPage = 1;

    var startIdx = (lbCurrentPage - 1) * ITEMS_PER_PAGE;
    var pageItems = sorted.slice(startIdx, startIdx + ITEMS_PER_PAGE);
    var topDl = sorted.length ? sorted[0].avgDl : 1;

    var html = '<div class="lb-list-rich">';
    pageItems.forEach(function(item, idx) {
      var absoluteRank = startIdx + idx;
      var rankClass = absoluteRank === 0 ? 'rank-1' : absoluteRank === 1 ? 'rank-2' : absoluteRank === 2 ? 'rank-3' : '';
      var pct = Math.max(10, Math.min(100, Math.round((item.avgDl / (topDl || 1)) * 100)));
      var tier = speedTierName(item.avgDl);
      var tierTagClass = 'pop-tier-' + tier;
      var tierTagLabel = tier.toUpperCase();

      html +=
        '<div class="lb-row-rich">' +
          '<div class="lb-row-top">' +
            '<span class="lb-rank-badge ' + rankClass + '">#' + (absoluteRank + 1) + '</span>' +
            '<span class="lb-row-title">' + item.name + '</span>' +
            '<span class="pop-tier-tag ' + tierTagClass + '">' + tierTagLabel + '</span>' +
          '</div>' +
          '<div class="lb-bar-wrap">' +
            '<div class="lb-bar-fill" style="width:' + pct + '%"></div>' +
          '</div>' +
          '<div class="lb-row-stats">' +
            '<span class="lb-rs-item">↓ DL <strong>' + item.avgDl + ' Mbps</strong></span>' +
            '<span class="lb-rs-item">↑ UL <strong>' + item.avgUl + ' Mbps</strong></span>' +
            '<span class="lb-rs-item">Ping <strong>' + (item.avgPing ? item.avgPing + ' ms' : '—') + '</strong></span>' +
            '<span class="lb-rs-item" style="color:var(--t3)">' + item.count + ' test' + (item.count > 1 ? 's' : '') + '</span>' +
          '</div>' +
        '</div>';
    });
    html += '</div>';

    // Pagination controls footer
    html +=
      '<div class="lb-pagination">' +
        '<button id="lb-page-prev" class="lb-page-btn" ' + (lbCurrentPage <= 1 ? 'disabled' : '') + '>← Previous</button>' +
        '<span class="lb-page-info">Page ' + lbCurrentPage + ' of ' + totalPages + '</span>' +
        '<button id="lb-page-next" class="lb-page-btn" ' + (lbCurrentPage >= totalPages ? 'disabled' : '') + '>Next →</button>' +
      '</div>';

    contentEl.innerHTML = html;

    // Attach pagination button listeners
    var prevBtn = document.getElementById('lb-page-prev');
    var nextBtn = document.getElementById('lb-page-next');
    if (prevBtn) prevBtn.addEventListener('click', function() { renderLeaderboard(currentLbTab, lbCurrentPage - 1); });
    if (nextBtn) nextBtn.addEventListener('click', function() { renderLeaderboard(currentLbTab, lbCurrentPage + 1); });
  });
}

// ── Share Speed Card Generator ───────────────────────
function openShareModal() {
  var canvas = document.getElementById('share-canvas');
  if (!canvas) return;

  // Set explicit high-resolution canvas bounds
  canvas.width = 640;
  canvas.height = 340;
  var ctx = canvas.getContext('2d');

  // Background gradient
  var bgGrad = ctx.createLinearGradient(0, 0, 640, 340);
  bgGrad.addColorStop(0, '#0a0c14');
  bgGrad.addColorStop(1, '#05060a');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, 640, 340);

  // Top Glowing Accent Bar
  ctx.fillStyle = '#f59e0b';
  ctx.fillRect(0, 0, 640, 3);

  // Outer Border Overlay
  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.lineWidth = 1;
  ctx.strokeRect(16, 16, 608, 308);

  // Header Brand Logo & Title
  ctx.fillStyle = '#f59e0b';
  ctx.font = '800 22px Lexend, sans-serif';
  ctx.fillText('SpeedMap', 40, 52);

  ctx.fillStyle = '#8a8278';
  ctx.font = '600 10px Lexend, sans-serif';
  ctx.fillText('GLOBAL INTERNET BENCHMARK', 40, 70);

  // Verified Badge (Top Right)
  ctx.fillStyle = 'rgba(34,197,94,0.1)';
  ctx.fillRect(470, 36, 130, 28);
  ctx.strokeStyle = 'rgba(34,197,94,0.3)';
  ctx.strokeRect(470, 36, 130, 28);

  ctx.fillStyle = '#22c55e';
  ctx.beginPath();
  ctx.arc(485, 50, 3.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#4ade80';
  ctx.font = '700 10px Lexend, sans-serif';
  ctx.fillText('VERIFIED TEST', 496, 54);

  // Main Speed Hero
  var dlVal = state.download !== null ? state.download.toFixed(1) : '0.0';
  ctx.fillStyle = '#ffffff';
  ctx.font = '800 62px Lexend, sans-serif';
  ctx.fillText(dlVal, 40, 146);

  var numWidth = ctx.measureText(dlVal).width;
  ctx.fillStyle = '#f59e0b';
  ctx.font = '700 20px Lexend, sans-serif';
  ctx.fillText('Mbps', 40 + numWidth + 12, 126);

  ctx.fillStyle = '#9ca3af';
  ctx.font = '500 12px Lexend, sans-serif';
  ctx.fillText('Download Speed', 40 + numWidth + 12, 146);

  // Speed Tier Badge
  var tier = speedTierName(parseFloat(dlVal));
  var tierLabel = tier.toUpperCase() + ' TIER';
  var tierColor = tier === 'ultra' ? '#38bdf8' : tier === 'fast' ? '#22c55e' : tier === 'mid' ? '#f97316' : '#ef4444';

  ctx.fillStyle = 'rgba(255,255,255,0.04)';
  ctx.fillRect(480, 115, 120, 28);
  ctx.strokeStyle = tierColor;
  ctx.strokeRect(480, 115, 120, 28);
  ctx.fillStyle = tierColor;
  ctx.font = '700 10px Lexend, sans-serif';
  ctx.fillText(tierLabel, 495, 133);

  // Bottom 3 Metric Cards
  var ulVal = state.upload !== null ? state.upload.toFixed(1) + ' Mbps' : '—';
  var pingVal = state.ping !== null ? state.ping + ' ms' : '—';
  var netVal = NET_LABELS[state.networkType] || state.networkType || '—';
  var devVal = state.device || 'Desktop';
  var ispVal = state.isp || state.city || 'Global User';

  // Card 1: Upload
  ctx.fillStyle = 'rgba(168,85,247,0.06)';
  ctx.fillRect(40, 178, 160, 74);
  ctx.strokeStyle = 'rgba(168,85,247,0.25)';
  ctx.strokeRect(40, 178, 160, 74);
  ctx.fillStyle = '#c084fc';
  ctx.font = '700 10px Lexend, sans-serif';
  ctx.fillText('UPLOAD SPEED', 54, 200);
  ctx.fillStyle = '#e9d5ff';
  ctx.font = '700 20px Lexend, sans-serif';
  ctx.fillText(ulVal, 54, 234);

  // Card 2: Ping
  ctx.fillStyle = 'rgba(245,158,11,0.06)';
  ctx.fillRect(215, 178, 160, 74);
  ctx.strokeStyle = 'rgba(245,158,11,0.25)';
  ctx.strokeRect(215, 178, 160, 74);
  ctx.fillStyle = '#fbbf24';
  ctx.font = '700 10px Lexend, sans-serif';
  ctx.fillText('PING LATENCY', 229, 200);
  ctx.fillStyle = '#fde68a';
  ctx.font = '700 20px Lexend, sans-serif';
  ctx.fillText(pingVal, 229, 234);

  // Card 3: Network & Location
  ctx.fillStyle = 'rgba(56,189,248,0.06)';
  ctx.fillRect(390, 178, 210, 74);
  ctx.strokeStyle = 'rgba(56,189,248,0.25)';
  ctx.strokeRect(390, 178, 210, 74);
  ctx.fillStyle = '#38bdf8';
  ctx.font = '700 10px Lexend, sans-serif';
  ctx.fillText('NETWORK & LOCATION', 404, 198);
  ctx.fillStyle = '#ffffff';
  ctx.font = '700 13px Lexend, sans-serif';
  ctx.fillText(netVal + ' · ' + devVal, 404, 218, 185);
  ctx.fillStyle = '#9ca3af';
  ctx.font = '500 11px Lexend, sans-serif';
  ctx.fillText(ispVal, 404, 236, 185);

  // Footer Line
  ctx.fillStyle = '#6b7280';
  ctx.font = '500 11px Lexend, sans-serif';
  ctx.fillText('speedmap-2a75c.web.app', 40, 298);

  var dStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  ctx.fillText('Tested on ' + dStr, 480, 298);

  // Convert to image preview
  var imgPreview = document.getElementById('share-img-preview');
  if (imgPreview) imgPreview.src = canvas.toDataURL('image/png');

  var modal = document.getElementById('modal-share');
  if (modal) modal.classList.add('active');
}

function closeShareModal() {
  var modal = document.getElementById('modal-share');
  if (modal) modal.classList.remove('active');
}

function downloadSpeedCard() {
  var canvas = document.getElementById('share-canvas');
  if (!canvas) return;
  var link = document.createElement('a');
  link.download = 'SpeedMap-Card.png';
  link.href = canvas.toDataURL('image/png');
  link.click();
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

  var btnNavLb   = document.getElementById('btn-nav-leaderboard');
  var btnBarLb   = document.getElementById('btn-bar-leaderboard');
  var btnShare   = document.getElementById('btn-share-card');
  var closeShare = document.getElementById('close-share');
  var btnDlCard  = document.getElementById('btn-download-card');

  var btnLbBackMap  = document.getElementById('btn-lb-back-map');
  var btnLbTest     = document.getElementById('btn-lb-test');

  if (btnLbBackMap)  btnLbBackMap.addEventListener('click', goToMap);
  if (btnLbTest)     btnLbTest.addEventListener('click', startTest);

  var btnCancel  = document.getElementById('btn-cancel-test');
  var btnRvMap   = document.getElementById('btn-rv-map');
  var btnRvRetest= document.getElementById('btn-rv-retest');
  var btnRvHome  = document.getElementById('btn-rv-home');
  var btnMapHome = document.getElementById('btn-map-home');

  if (btnCancel)   btnCancel.addEventListener('click', function() { showScreen('screen-welcome'); });
  if (btnRvMap)    btnRvMap.addEventListener('click', goToMap);
  if (btnRvRetest) btnRvRetest.addEventListener('click', startTest);
  if (btnRvHome)   btnRvHome.addEventListener('click', function() { showScreen('screen-welcome'); });
  if (btnRvMap)  btnRvMap.addEventListener('click', goToMap);
  if (btnMapHome)btnMapHome.addEventListener('click', function() { showScreen('screen-welcome'); });

  if (btnStart)   btnStart.addEventListener('click', startTest);
  if (btnNavTest) btnNavTest.addEventListener('click', startTest);
  if (btnViewMap) btnViewMap.addEventListener('click', goToMap);
  if (btnNavMap)  btnNavMap.addEventListener('click', goToMap);
  if (btnMarkers) btnMarkers.addEventListener('click', function() { toggleLayer('markers'); });
  if (btnHeat)    btnHeat.addEventListener('click', function() { toggleLayer('heat'); });
  if (btnRetest)  btnRetest.addEventListener('click', function() { showScreen('screen-welcome'); });

  if (btnNavLb)   btnNavLb.addEventListener('click', openLeaderboard);
  if (btnBarLb)   btnBarLb.addEventListener('click', openLeaderboard);

  if (btnShare)   btnShare.addEventListener('click', openShareModal);
  if (closeShare) closeShare.addEventListener('click', closeShareModal);
  if (btnDlCard)  btnDlCard.addEventListener('click', downloadSpeedCard);

  // Esc key listener to close modals
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      closeLeaderboard();
      closeShareModal();
    }
  });

  document.querySelectorAll('.lb-tab').forEach(function(tabEl) {
    tabEl.addEventListener('click', function() { renderLeaderboard(tabEl.dataset.tab); });
  });

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
