const BASE = { lat: 48.8566, lng: 2.3522 };
const SAFE_DISTANCE = 1.5;
const SPEED_MAX = 4;
const TICK_MS = 100;
const DEG_LAT_M = 110574;
const DEG_LNG_M = 111320;

const zones = [
  { name: 'Zone A', bounds: [[48.8580, 2.3480], [48.8610, 2.3540]], status: 'À traiter' },
  { name: 'Zone B', bounds: [[48.8530, 2.3560], [48.8555, 2.3630]], status: 'À traiter' },
  { name: 'Zone C', bounds: [[48.8600, 2.3600], [48.8625, 2.3670]], status: 'Terminée' }
];

const state = {
  airborne: false, running: false, rth: false, done: false, avoiding: false,
  mode: 'Au sol',
  lat: BASE.lat, lng: BASE.lng, alt: 0, speed: 0, heading: 0,
  battery: 100, tof: 8, obstacleTimer: 0, colorDetected: false,
  latency: 0, linkOk: true,
  current: 0, waypoints: []
};

const $ = id => document.getElementById(id);

const map = L.map('map').setView([BASE.lat, BASE.lng], 15);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap'
}).addTo(map);

const droneMarker = L.circleMarker([BASE.lat, BASE.lng], {
  radius: 8, color: '#0d47a1', fillColor: '#42a5f5', fillOpacity: 1
}).addTo(map);
L.marker([BASE.lat, BASE.lng]).addTo(map).bindTooltip('Base');
const wpLayer = L.layerGroup().addTo(map);
const routeLine = L.polyline([], { color: '#1565c0', dashArray: '6 6' }).addTo(map);

zones.forEach(z => {
  z.layer = L.rectangle(z.bounds, { weight: 2 }).addTo(map).bindTooltip('');
  paintZone(z);
});

function paintZone(z) {
  const done = z.status === 'Terminée';
  z.layer.setStyle({
    color: done ? '#757575' : '#2e7d32',
    fillColor: done ? '#9e9e9e' : '#66bb6a',
    fillOpacity: 0.25
  });
  z.layer.setTooltipContent(`${z.name} – ${z.status}`);
}

function log(msg) {
  const el = $('log');
  const time = new Date().toLocaleTimeString('fr-FR');
  el.insertAdjacentHTML('afterbegin', `<div>${time} ${msg}</div>`);
  if (el.children.length > 100) el.lastChild.remove();
}

function btn(label, onClick) {
  const b = document.createElement('button');
  b.textContent = label;
  b.onclick = onClick;
  return b;
}

function renderZones() {
  const ul = $('zoneList');
  ul.innerHTML = '';
  zones.forEach(z => {
    const li = document.createElement('li');
    li.appendChild(btn(`${z.name} : ${z.status}`, () => {
      z.status = z.status === 'Terminée' ? 'À traiter' : 'Terminée';
      paintZone(z);
      renderZones();
      log(`${z.name} → ${z.status}`);
    }));
    ul.appendChild(li);
  });
}

function renderWaypoints() {
  wpLayer.clearLayers();
  const ol = $('wpList');
  ol.innerHTML = '';
  state.waypoints.forEach((wp, i) => {
    L.marker([wp.lat, wp.lng]).addTo(wpLayer)
      .bindTooltip(`WP ${i + 1}`, { permanent: true, direction: 'top' });

    const li = document.createElement('li');
    if (i < state.current) li.className = 'done';
    else if (i === state.current && state.running) li.className = 'active';

    const label = document.createElement('span');
    label.textContent = `WP ${i + 1} ${wp.lat.toFixed(4)}, ${wp.lng.toFixed(4)}`;
    li.appendChild(label);
    li.appendChild(btn('↑', () => moveWp(i, -1)));
    li.appendChild(btn('↓', () => moveWp(i, 1)));
    li.appendChild(btn('✕', () => removeWp(i)));
    ol.appendChild(li);
  });
}

function moveWp(i, delta) {
  const j = i + delta;
  if (state.running) return log('Modification impossible pendant la mission');
  if (j < 0 || j >= state.waypoints.length) return;
  [state.waypoints[i], state.waypoints[j]] = [state.waypoints[j], state.waypoints[i]];
  renderWaypoints();
}

function removeWp(i) {
  if (state.running) return log('Modification impossible pendant la mission');
  state.waypoints.splice(i, 1);
  renderWaypoints();
  log(`Point ${i + 1} supprimé`);
}

map.on('click', e => {
  if (!$('addMode').checked) return;
  state.waypoints.push({ lat: e.latlng.lat, lng: e.latlng.lng });
  renderWaypoints();
  log(`Point ${state.waypoints.length} ajouté`);
});

$('clearWp').onclick = () => {
  if (state.running) return log('Modification impossible pendant la mission');
  state.waypoints = [];
  state.current = 0;
  renderWaypoints();
  log('Liste des points vidée');
};

$('start').onclick = () => {
  if (state.running) return;
  if (!state.waypoints.length) return log('Aucun point de passage défini');
  if (state.current >= state.waypoints.length) state.current = 0;
  state.running = true;
  state.airborne = true;
  state.rth = false;
  state.done = false;
  log('Mission démarrée');
  renderWaypoints();
};

$('pause').onclick = () => {
  if (!state.running) return;
  state.running = false;
  log('Mission en pause (drone stationnaire)');
};

$('rth').onclick = () => {
  if (!state.airborne) return log('Drone au sol');
  state.rth = true;
  state.running = true;
  log('Retour base demandé');
};

$('abort').onclick = () => {
  state.running = false;
  state.rth = false;
  state.airborne = false;
  state.avoiding = false;
  state.speed = 0;
  log("ARRÊT D'URGENCE : atterrissage");
  renderWaypoints();
};

function toMeters(lat1, lng1, lat2, lng2) {
  const dy = (lat2 - lat1) * DEG_LAT_M;
  const dx = (lng2 - lng1) * DEG_LNG_M * Math.cos(lat1 * Math.PI / 180);
  return { dx, dy, dist: Math.hypot(dx, dy) };
}

function moveTowards(m, dt) {
  const step = Math.min(SPEED_MAX * dt, m.dist);
  state.lat += (m.dy / m.dist) * step / DEG_LAT_M;
  state.lng += (m.dx / m.dist) * step / (DEG_LNG_M * Math.cos(state.lat * Math.PI / 180));
  state.speed = SPEED_MAX;
  state.heading = (Math.atan2(m.dx, m.dy) * 180 / Math.PI + 360) % 360;
  state.mode = state.rth ? 'Retour base' : 'Navigation';
}

function arrive() {
  if (state.rth) {
    state.rth = false;
    state.running = false;
    state.airborne = false;
    log('Base atteinte, atterrissage');
    return;
  }
  state.current++;
  log(`Point ${state.current} atteint`);
  renderWaypoints();
}

function tick() {
  // Source de données simulée : à remplacer par une réception WebSocket / MQTT du drone
  const dt = TICK_MS / 1000;

  state.latency = Math.round(20 + Math.random() * 60);
  state.linkOk = state.latency < 100;

  if (state.obstacleTimer > 0) {
    state.obstacleTimer -= dt;
  } else if (state.airborne && Math.random() < 0.004) {
    state.obstacleTimer = 3;
    log('Obstacle détecté');
  }
  state.tof = state.obstacleTimer > 0 ? 0.9 + Math.random() * 0.4 : 6 + Math.random() * 0.5;

  const inTarget = zones.some(z =>
    z.status === 'À traiter' && L.latLngBounds(z.bounds).contains([state.lat, state.lng]));
  state.colorDetected = state.airborne && inTarget && Math.random() < 0.5;

  const targetAlt = state.airborne ? 10 : 0;
  const dAlt = targetAlt - state.alt;
  state.alt += Math.sign(dAlt) * Math.min(Math.abs(dAlt), 1.5 * dt);

  state.battery = Math.max(0, state.battery - (state.running ? 0.03 : 0.005) * dt);
  if (state.battery < 15 && state.running && !state.rth) {
    state.rth = true;
    log('Batterie faible : retour base automatique');
  }

  if (state.running) {
    if (state.alt > 1 && state.tof < SAFE_DISTANCE) state.avoiding = true;

    if (state.avoiding) {
      state.speed = 0;
      state.mode = 'Évitement';
      if (state.tof >= SAFE_DISTANCE) {
        state.avoiding = false;
        log('Obstacle franchi, reprise de trajectoire');
      }
    } else {
      const wp = state.rth ? BASE : state.waypoints[state.current];
      if (!wp) {
        state.running = false;
        state.done = true;
        state.speed = 0;
        log('Mission terminée');
        renderWaypoints();
      } else {
        const m = toMeters(state.lat, state.lng, wp.lat, wp.lng);
        if (m.dist < 0.5) arrive();
        else moveTowards(m, dt);
      }
    }
  } else {
    state.speed = 0;
    state.mode = !state.airborne ? 'Au sol' : (state.done ? 'Mission terminée' : 'Stationnaire');
  }
}

function render() {
  droneMarker.setLatLng([state.lat, state.lng]);
  const remaining = state.rth ? [BASE] : state.waypoints.slice(state.current);
  routeLine.setLatLngs([[state.lat, state.lng], ...remaining.map(p => [p.lat, p.lng])]);

  $('mode').textContent = state.mode;
  $('pos').textContent = `${state.lat.toFixed(5)}, ${state.lng.toFixed(5)}`;
  $('alt').textContent = `${state.alt.toFixed(1)} m`;
  $('speed').textContent = `${state.speed.toFixed(1)} m/s`;
  $('heading').textContent = `${Math.round(state.heading)}°`;
  $('batt').style.width = `${state.battery}%`;
  $('batt').style.background = state.battery < 15 ? '#e53935' : state.battery < 30 ? '#fb8c00' : '#43a047';
  $('battVal').textContent = `${state.battery.toFixed(1)} %`;
  $('tof').textContent = `${state.tof.toFixed(2)} m`;
  $('color').textContent = state.colorDetected ? 'Cible détectée' : 'Aucune';
  $('latency').textContent = `${state.latency} ms`;

  const link = $('link');
  link.textContent = `Liaison : ${state.linkOk ? 'OK' : 'dégradée'}`;
  link.classList.toggle('off', !state.linkOk);
  $('clock').textContent = new Date().toLocaleTimeString('fr-FR');
}

renderZones();
renderWaypoints();
log('Système initialisé. Source de télémétrie : simulation.');
setInterval(() => { tick(); render(); }, TICK_MS);
