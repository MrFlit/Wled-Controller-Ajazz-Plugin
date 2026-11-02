'use strict';

// WLED Control for AJAZZ StreamDock. No external npm packages required.
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const { URL } = require('url');

const PLUGIN_UUID = 'ru.mrflit.streamdock.wled';
const ACTION_UUID = `${PLUGIN_UUID}.power`;
const BRIGHTNESS_ACTION_UUID = `${PLUGIN_UUID}.brightness`;
const POLL_MS = 2500;
const BRIGHTNESS_MIN = 0;
const BRIGHTNESS_MAX = 250;
const BRIGHTNESS_STEP = 5;

// Minimal RFC6455 client for StreamDock's local WebSocket server.
// This avoids relying on globalThis.WebSocket (not consistently available in Node 20).
class LocalWebSocket {
  constructor(address) {
    this.readyState = 0; this.listeners = {}; this.buffer = Buffer.alloc(0);
    this.socket = null; this.handshakeDone = false;
    const u = new URL(address); const secure = u.protocol === 'wss:';
    const port = Number(u.port || (secure ? 443 : 80));
    const key = crypto.randomBytes(16).toString('base64');
    const transport = secure ? tls : net;
    this.socket = secure ? transport.connect(port, u.hostname) : transport.connect(port, u.hostname);
    this.socket.on('connect', () => {
      const req = `GET ${u.pathname || '/'}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`;
      this.socket.write(req);
    });
    this.socket.on('data', chunk => this._data(chunk, key));
    this.socket.on('error', error => this._emit('error', { message: error.message }));
    this.socket.on('close', () => { this.readyState = 3; this._emit('close', {}); });
  }
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
  _emit(name, event) { for (const fn of this.listeners[name] || []) { try { fn(event); } catch (_) {} } }
  _data(chunk, key) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (!this.handshakeDone) {
      const end = this.buffer.indexOf('\r\n\r\n'); if (end < 0) return;
      const head = this.buffer.subarray(0, end).toString('utf8');
      const expected = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      if (!/^HTTP\/1\.1 101\b/m.test(head) || !head.toLowerCase().includes(`sec-websocket-accept: ${expected.toLowerCase()}`)) {
        this._emit('error', { message: `WebSocket handshake rejected: ${head.split('\r\n')[0]}` }); this.socket.destroy(); return;
      }
      this.buffer = this.buffer.subarray(end + 4); this.handshakeDone = true; this.readyState = 1; this._emit('open', {});
    }
    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0], b1 = this.buffer[1]; let len = b1 & 127, offset = 2;
      if (len === 126) { if (this.buffer.length < 4) return; len = this.buffer.readUInt16BE(2); offset = 4; }
      else if (len === 127) { if (this.buffer.length < 10) return; const big = this.buffer.readBigUInt64BE(2); if (big > BigInt(Number.MAX_SAFE_INTEGER)) return this.close(); len = Number(big); offset = 10; }
      const masked = !!(b1 & 128); let mask;
      if (masked) { if (this.buffer.length < offset + 4) return; mask = this.buffer.subarray(offset, offset + 4); offset += 4; }
      if (this.buffer.length < offset + len) return;
      let payload = Buffer.from(this.buffer.subarray(offset, offset + len)); this.buffer = this.buffer.subarray(offset + len);
      if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      const opcode = b0 & 15;
      if (opcode === 1) this._emit('message', { data: payload.toString('utf8') });
      else if (opcode === 8) { this.close(); return; }
      else if (opcode === 9) this._frame(10, payload);
    }
  }
  _frame(opcode, payload) {
    if (!this.socket || this.readyState > 1) return;
    const data = Buffer.from(payload || []), mask = crypto.randomBytes(4); let header;
    if (data.length < 126) { header = Buffer.alloc(2); header[1] = 0x80 | data.length; }
    else if (data.length < 65536) { header = Buffer.alloc(4); header[1] = 0x80 | 126; header.writeUInt16BE(data.length, 2); }
    else { header = Buffer.alloc(10); header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(data.length), 2); }
    header[0] = 0x80 | opcode;
    const masked = Buffer.from(data); for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }
  send(value) { if (this.readyState !== 1) throw new Error('WebSocket is not open'); this._frame(1, Buffer.from(String(value))); }
  close() { if (this.readyState >= 2) return; this.readyState = 2; try { this._frame(8, Buffer.alloc(0)); } catch (_) {} setTimeout(() => this.socket?.end(), 100); }
}

let ws, actions = new Map(), knobs = new Map(), settings = new Map(), brightnessQueues = new Map(), pollTimer = null, polling = false, stopped = false;
function log(...args) { console.error('[WLED Control]', ...args); }
function send(event, context, payload = {}) {
  if (!ws || ws.readyState !== 1) return;
  const msg = { event }; if (context) msg.context = context;
  if (payload && Object.keys(payload).length) msg.payload = payload;
  try { ws.send(JSON.stringify(msg)); } catch (e) { log('Send failed:', e.message); }
}
function hostFor(context) {
  const savedHost = String((settings.get(context) || {}).host || '').trim().replace(/\/+$/, '');
  const host = savedHost || configuredHost || '';
  return host;
}
function httpJson(method, endpoint, body, timeout = 3500) {
  return new Promise((resolve, reject) => {
    let url; try { url = new URL(endpoint); } catch (e) { reject(e); return; }
    const transport = url.protocol === 'https:' ? https : http;
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = transport.request(url, { method, timeout, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} }, res => {
      let raw = ''; res.setEncoding('utf8'); res.on('data', c => raw += c);
      res.on('end', () => { if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`HTTP ${res.statusCode}`)); try { resolve(raw ? JSON.parse(raw) : {}); } catch (_) { reject(new Error('Некорректный JSON от WLED')); } });
    });
    req.on('timeout', () => req.destroy(new Error('Тайм-аут WLED'))); req.on('error', reject); if (data) req.write(data); req.end();
  });
}
function setKey(context, state, title) { send('setState', context, { state }); send('setTitle', context, { title, target: 0 }); }
async function readState(context) {
  const host = hostFor(context);
  if (!host) throw new Error('Адрес WLED не задан. Откройте настройки плагина.');
  const data = await httpJson('GET', `${host}/json`);
  if (typeof data?.state?.on !== 'boolean') throw new Error('WLED не вернул state.on');
  return data.state.on;
}
async function refreshAll() {
  if (polling || ![...actions.values()].some(a => a === ACTION_UUID) || stopped) return;
  polling = true;
  try {
    const context = [...actions.entries()].find(([, action]) => action === ACTION_UUID)?.[0];
    if (!context) return;
    const on = await readState(context);
    for (const [c, action] of actions.entries()) {
      if (action === ACTION_UUID) setKey(c, on ? 1 : 0, on ? 'WLED\\nВКЛ' : 'WLED\\nВЫКЛ');
    }
  }
  catch (e) {
    log('WLED status:', e.message);
    const firstContext = [...actions.entries()].find(([, a]) => a === ACTION_UUID)?.[0];
    const missingHost = !firstContext || !hostFor(firstContext);
    for (const [c, a] of actions.entries()) if (a === ACTION_UUID) setKey(c, 2, missingHost ? 'НАСТРОЙ IP' : 'НЕТ СВЯЗИ');
  }
  finally { polling = false; }
}
async function toggle(context) {
  try { const current = await readState(context); await httpJson('POST', `${hostFor(context)}/json/state`, { on: !current }); await refreshAll(); }
  catch (e) { log('Toggle failed:', e.stack || e.message); setKey(context, 2, 'ОШИБКА'); send('showAlert', context); }
}
async function showCurrentBrightness(context) {
  try {
    const host = hostFor(context);
    if (!host) throw new Error('Адрес WLED не задан.');
    const state = await httpJson('GET', `${host}/json/state`);
    const brightness = Number(state?.bri);
    if (!Number.isFinite(brightness)) throw new Error('WLED не вернул bri.');
    send('setTitle', context, { title: `ЯРКОСТЬ\\n${Math.min(BRIGHTNESS_MAX, brightness)}`, target: 0 });
  } catch (error) {
    log('Could not read initial brightness:', error.message);
    send('setTitle', context, { title: 'ЯРКОСТЬ', target: 0 });
  }
}
async function changeBrightness(context, ticks) {
  const deltaTicks = Number(ticks);
  if (!Number.isFinite(deltaTicks) || deltaTicks === 0) return;
  const previous = brightnessQueues.get(context) || Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const host = hostFor(context);
    if (!host) throw new Error('Адрес WLED не задан. Откройте настройки плагина.');
    const current = await httpJson('GET', `${host}/json/state`);
    const currentBrightness = Number(current?.bri);
    if (!Number.isFinite(currentBrightness)) throw new Error('WLED не вернул уровень яркости (bri).');
    const brightness = Math.max(BRIGHTNESS_MIN, Math.min(BRIGHTNESS_MAX,
      Math.round(currentBrightness + deltaTicks * BRIGHTNESS_STEP)));
    await httpJson('POST', `${host}/json/state`, { bri: brightness });
    send('setTitle', context, { title: `ЯРКОСТЬ\n${brightness}`, target: 0 });
    send('setState', context, { state: 0 });
    log(`Brightness changed: ${currentBrightness} -> ${brightness} (ticks ${deltaTicks})`);
  }).catch(error => {
    log('Brightness change failed:', error.stack || error.message);
    send('setTitle', context, { title: 'НЕТ СВЯЗИ', target: 0 });
    send('showAlert', context);
  });
  brightnessQueues.set(context, next);
  await next;
}
function startPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = setInterval(refreshAll, POLL_MS); refreshAll(); }

// Standalone settings HTTP server. It uses 17895 if available and increments
// the port if another application/plugin already occupies it.
const fs = require('fs');
const path = require('path');
const settingsFile = path.join(__dirname, 'wled-settings.json');
let settingsServer = null;
let settingsPort = null;
let configuredHost = '';
try {
  const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  if (typeof saved.host === 'string' && /^https?:\/\//i.test(saved.host)) {
    configuredHost = saved.host.replace(/\/+$/, '');
  }
} catch (_) {}

function startSettingsServer() {
  if (settingsServer) return;
  settingsServer = http.createServer((req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && requestUrl.pathname === '/') {
      const safeHost = String(configuredHost || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
      const page = settingsPage.replace('__WLED_HOST__', safeHost);
      res.writeHead(200, {'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-store'});
      res.end(page);
      return;
    }
    if (req.method === 'GET' && requestUrl.pathname === '/health') {
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:true, port:settingsPort, host:configuredHost}));
      return;
    }
    if (req.method === 'POST' && requestUrl.pathname === '/save') {
      let raw = '';
      req.on('data', chunk => { raw += chunk; if (raw.length > 8192) req.destroy(); });
      req.on('end', () => {
        try {
          const data = JSON.parse(raw || '{}');
          const candidate = String(data.host || '').trim().replace(/\/+$/, '');
          if (!candidate) throw new Error('Введите IP-адрес или URL устройства WLED.');
          const parsed = new URL(candidate);
          if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) throw new Error('Укажите корректный адрес http:// или https://');
          configuredHost = candidate;
          fs.writeFileSync(settingsFile, JSON.stringify({host: configuredHost}, null, 2), 'utf8');
          for (const context of actions.keys()) settings.set(context, {...(settings.get(context) || {}), host: configuredHost});
          res.writeHead(200, {'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:true, host:configuredHost}));
          refreshAll();
        } catch (error) {
          res.writeHead(400, {'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:false, error:error.message}));
        }
      });
      return;
    }
    if (req.method === 'POST' && requestUrl.pathname === '/test') {
      let raw = '';
      req.on('data', chunk => { raw += chunk; if (raw.length > 8192) req.destroy(); });
      req.on('end', async () => {
        try {
          const data = JSON.parse(raw || '{}');
          const candidate = String(data.host || '').trim().replace(/\/+$/, '');
          if (!candidate) throw new Error('Сначала укажите адрес WLED.');
          const parsed = new URL(candidate);
          if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Используйте адрес с http:// или https://');
          const state = await httpJson('GET', candidate + '/json/state');
          res.writeHead(200, {'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:true, on:!!state.on}));
        } catch (error) {
          res.writeHead(502, {'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:false, error:error.message}));
        }
      });
      return;
    }
    res.writeHead(404); res.end('Not found');
  });

  const tryPort = port => {
    const onError = error => {
      settingsServer.removeListener('listening', onListening);
      if (error.code === 'EADDRINUSE' && port < 65535) return tryPort(port + 1);
      log('Settings server failed:', error.stack || error.message);
    };
    const onListening = () => {
      settingsServer.removeListener('error', onError);
      settingsPort = port;
      log('Settings panel listening at http://127.0.0.1:' + port + '/');
      for (const context of actions.keys()) send('sendToPropertyInspector', context, {type:'settingsPanel', url:'http://127.0.0.1:' + port + '/'});
    };
    settingsServer.once('error', onError);
    settingsServer.once('listening', onListening);
    settingsServer.listen(port, '127.0.0.1');
  };
  tryPort(17895);
}

const settingsPage = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WLED Control — настройки</title>
<style>
*{box-sizing:border-box}body{margin:0;padding:28px;background:#17181b;color:#eee;font:14px Arial,sans-serif}
main{max-width:560px;margin:28px auto;background:#22242a;border:1px solid #363941;border-radius:16px;padding:26px}
h1{font-size:22px;margin:0 0 8px}.sub{color:#aeb4bd;margin-bottom:26px;font-size:13px}
label{display:block;margin-bottom:9px}input{width:100%;padding:13px;border-radius:8px;border:1px solid #4a4e58;background:#17191e;color:white;font-size:15px}
.row{display:flex;gap:10px;flex-wrap:wrap}button{margin-top:16px;padding:12px 18px;border:0;border-radius:8px;background:#2678e8;color:white;font-weight:bold;cursor:pointer}
button.secondary{background:#3a3d44}#status{margin-top:15px;min-height:20px;color:#aeb4bd;font-size:13px}.hint{margin-top:20px;color:#999;font-size:12px;line-height:1.5}
</style></head><body><main>
<h1>💡 WLED Control</h1><div class="sub">Настройки подключения к ESP32 с WLED</div>
<label for="host">Адрес контроллера WLED</label><input id="host" value="__WLED_HOST__" placeholder="http://IP-адрес-ESP32">
<div class="row"><button id="save">Сохранить</button><button class="secondary" id="test">Проверить связь</button></div>
<div id="status">Укажите адрес контроллера WLED.</div>
<div class="hint">Порт веб-панели выбирается автоматически начиная с 17895. Он независим от WebSocket-порта StreamDock.</div>
</main><script>
const host=document.getElementById('host'),status=document.getElementById('status');
async function post(path,body){const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const d=await r.json();if(!r.ok||!d.ok)throw new Error(d.error||'Ошибка запроса');return d;}
document.getElementById('save').onclick=async()=>{try{status.style.color='#aeb4bd';status.textContent='Сохраняем…';const d=await post('/save',{host:host.value});host.value=d.host;status.style.color='#70d99a';status.textContent='Адрес сохранён.';}catch(e){status.style.color='#ff8585';status.textContent=e.message;}};
document.getElementById('test').onclick=async()=>{try{status.style.color='#aeb4bd';status.textContent='Проверяем WLED…';const d=await post('/test',{host:host.value});status.style.color='#70d99a';status.textContent='Связь установлена. Подсветка '+(d.on?'включена':'выключена')+'.';}catch(e){status.style.color='#ff8585';status.textContent='Ошибка подключения: '+e.message;}};
</script></body></html>`;

function handleMessage(raw) {
  let m; try { m = JSON.parse(typeof raw === 'string' ? raw : raw.toString()); } catch (e) { log('Bad message:', e.message); return; }
  switch (m.event) {
    case 'willAppear':
      if (m.action === ACTION_UUID || m.action === BRIGHTNESS_ACTION_UUID) {
        actions.set(m.context, m.action);
        if (m.action === BRIGHTNESS_ACTION_UUID) { knobs.set(m.context, m.action); showCurrentBrightness(m.context); }
        settings.set(m.context, m.payload?.settings || {});
        if (m.action === ACTION_UUID) { setKey(m.context, 2, 'ПОДКЛЮЧЕНИЕ'); startPolling(); }
        send('sendToPropertyInspector', m.context, { type: 'hello', settings: settings.get(m.context), defaultHost: configuredHost, settingsUrl: settingsPort ? 'http://127.0.0.1:' + settingsPort + '/' : null });
      }
      break;
    case 'willDisappear':
      actions.delete(m.context); knobs.delete(m.context); settings.delete(m.context); brightnessQueues.delete(m.context);
      if (![...actions.values()].some(a => a === ACTION_UUID) && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      break;
    case 'keyDown': if (m.action === ACTION_UUID && actions.get(m.context) === ACTION_UUID) toggle(m.context); break;
    case 'dialRotate':
      if (m.action === BRIGHTNESS_ACTION_UUID && knobs.has(m.context)) {
        const ticks = Number(m.payload?.ticks ?? 0);
        changeBrightness(m.context, ticks);
      }
      break;
    case 'didReceiveSettings': settings.set(m.context, m.payload?.settings || {}); refreshAll(); break;
    case 'sendToPlugin': {
      const p = m.payload || {};
      if (p.type === 'saveSettings' && m.context) { settings.set(m.context, p.settings || {}); send('sendToPropertyInspector', m.context, { type: 'settingsSaved', settings: settings.get(m.context) }); refreshAll(); }
      if (p.type === 'testConnection' && m.context) httpJson('GET', `${String(p.host || hostFor(m.context)).replace(/\/+$/, '')}/json`).then(() => send('sendToPropertyInspector', m.context, { type: 'testResult', ok: true, message: 'Связь с WLED установлена.' })).catch(e => send('sendToPropertyInspector', m.context, { type: 'testResult', ok: false, message: e.message }));
      break;
    }
    case 'exitApp': stopped = true; if (pollTimer) clearInterval(pollTimer); process.exit(0); break;
  }
}
function parseArgs(argv) { const out = {}; for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('-') && i + 1 < argv.length) out[argv[i].replace(/^-+/, '')] = argv[++i]; return out; }
function connect() {
  const args = parseArgs(process.argv.slice(2)); const port = args.port;
  if (!port) { log('Missing -port; argv:', process.argv.slice(2)); process.exit(1); return; }
  const uuid = args.pluginUUID || PLUGIN_UUID, registerEvent = args.registerEvent || 'registerPlugin';
  log('Starting. Node:', process.version, 'port:', port, 'uuid:', uuid, 'args:', process.argv.slice(2));
  ws = new LocalWebSocket(`ws://127.0.0.1:${port}`);
  ws.addEventListener('open', () => { ws.send(JSON.stringify({ event: registerEvent, uuid })); log('Registration sent.'); });
  ws.addEventListener('message', e => handleMessage(e.data));
  ws.addEventListener('close', () => { log('StreamDock WebSocket closed.'); if (pollTimer) clearInterval(pollTimer); if (!stopped) process.exit(0); });
  ws.addEventListener('error', e => log('WebSocket error:', e.message || 'unknown'));
}
process.on('uncaughtException', e => log('Uncaught:', e.stack || e.message));
process.on('unhandledRejection', e => log('Unhandled rejection:', e?.stack || e));
startSettingsServer();
connect();
