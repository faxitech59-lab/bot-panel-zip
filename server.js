/**
 * BotPanel — apna khud ka bot hosting panel, Railway par.
 * Ek service me multiple bots: add/start/stop/restart/logs, sab dashboard se.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const runner = require('./lib/runner');

const app = express();
app.use(express.json({ limit: '1mb' }));

// ZIP uploads: /tmp me temp files (max 250MB per file)
const upload = multer({
  dest: '/tmp/panel-uploads',
  limits: { fileSize: 250 * 1024 * 1024 },
});

const PANEL_USER = process.env.PANEL_USER || 'admin';
const PANEL_PASS = process.env.PANEL_PASS || 'changeme';
if (!process.env.PANEL_PASS) {
  console.warn('[panel] WARNING: PANEL_PASS set nahi hai — default password "changeme" use ho raha hai. Foran badlo!');
}

// --- Auth (simple basic auth; panel ko private rakho) ---
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const h = req.headers.authorization || '';
  const [type, creds] = h.split(' ');
  if (type === 'Basic' && creds) {
    const idx = Buffer.from(creds, 'base64').toString().indexOf(':');
    if (idx > 0) {
      const u = Buffer.from(creds, 'base64').toString().slice(0, idx);
      const p = Buffer.from(creds, 'base64').toString().slice(idx + 1);
      if (u === PANEL_USER && p === PANEL_PASS) return next();
    }
  }
  res.set('WWW-Authenticate', 'Basic realm="bot-panel"');
  return res.status(401).send('Login required');
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.json({ ok: true, dataDir: runner.DATA_DIR }));

const ah = (fn) => (req, res) => {
  Promise.resolve(fn(req, res)).catch((e) => {
    res.status(400).json({ ok: false, error: e.message || String(e) });
  });
};

function parseEnv(text) {
  const env = {};
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0) env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return env;
}

// --- API ---
app.get('/api/bots', ah(async (req, res) => {
  res.json({ ok: true, bots: runner.listBots() });
}));

app.post('/api/bots', ah(async (req, res) => {
  const { name, repo, branch, env, installCmd, startCmd } = req.body || {};
  const bot = await runner.addBot({
    name: String(name || '').trim(),
    repo: String(repo || '').trim(),
    branch: String(branch || '').trim(),
    env: typeof env === 'string' ? parseEnv(env) : (env || {}),
    installCmd: String(installCmd || ''),
    startCmd: String(startCmd || ''),
  });
  res.json({ ok: true, bot });
}));

app.get('/api/bots/:name', ah(async (req, res) => {
  res.json({ ok: true, bot: runner.getBot(req.params.name) });
}));

app.post('/api/bots/:name/start', ah(async (req, res) => {
  res.json({ ok: true, bot: runner.startBot(req.params.name) });
}));

app.post('/api/bots/:name/stop', ah(async (req, res) => {
  res.json({ ok: true, bot: runner.stopBot(req.params.name) });
}));

app.post('/api/bots/:name/restart', ah(async (req, res) => {
  try { runner.stopBot(req.params.name); } catch {}
  await new Promise((r) => setTimeout(r, 2000));
  res.json({ ok: true, bot: runner.startBot(req.params.name) });
}));

app.post('/api/bots/:name/redeploy', ah(async (req, res) => {
  res.json({ ok: true, bot: await runner.redeployBot(req.params.name) });
}));

// ZIP se naya bot add karo (multipart form: zipfile + name/env/installCmd/startCmd)
app.post('/api/bots/upload', upload.single('zipfile'), ah(async (req, res) => {
  if (!req.file) throw new Error('ZIP file nahi mili — file select karo');
  if (!/\.zip$/i.test(req.file.originalname || '')) {
    try { fs.unlinkSync(req.file.path); } catch {}
    throw new Error('Sirf .zip file upload karo');
  }
  const { name, env, installCmd, startCmd } = req.body || {};
  const bot = await runner.addBotFromZip({
    name: String(name || '').trim(),
    zipPath: req.file.path,
    env: typeof env === 'string' ? parseEnv(env) : (env || {}),
    installCmd: String(installCmd || ''),
    startCmd: String(startCmd || ''),
  });
  res.json({ ok: true, bot });
}));

// ZIP se existing bot ka code update karo
app.post('/api/bots/:name/redeploy-upload', upload.single('zipfile'), ah(async (req, res) => {
  if (!req.file) throw new Error('ZIP file nahi mili — file select karo');
  if (!/\.zip$/i.test(req.file.originalname || '')) {
    try { fs.unlinkSync(req.file.path); } catch {}
    throw new Error('Sirf .zip file upload karo');
  }
  res.json({ ok: true, bot: await runner.redeployBotFromZip(req.params.name, req.file.path) });
}));

app.post('/api/bots/:name/env', ah(async (req, res) => {
  const { env } = req.body || {};
  res.json({ ok: true, bot: runner.updateBotEnv(req.params.name, typeof env === 'string' ? parseEnv(env) : (env || {})) });
}));

app.post('/api/bots/:name/settings', ah(async (req, res) => {
  const { env, startCmd, installCmd } = req.body || {};
  res.json({ ok: true, bot: runner.updateBotSettings(req.params.name, {
    env: typeof env === 'string' ? parseEnv(env) : env,
    startCmd, installCmd,
  }) });
}));

app.post('/api/bots/:name/autofix', ah(async (req, res) => {
  res.json({ ok: true, bot: await runner.autofixBot(req.params.name) });
}));

app.delete('/api/bots/:name', ah(async (req, res) => {
  res.json(runner.deleteBot(req.params.name));
}));

app.get('/api/bots/:name/logs', ah(async (req, res) => {
  const lines = Math.min(parseInt(req.query.lines || '200', 10) || 200, 1000);
  res.json({ ok: true, logs: runner.getLogs(req.params.name, lines) });
}));

// --- Boot ---
runner.boot();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[panel] chal raha hai on port ${PORT} — data dir: ${runner.DATA_DIR}`);
});

process.on('SIGTERM', () => {
  console.log('[panel] SIGTERM — band ho raha hai (bots ko akela chhoda jayega, boot par restart honge)');
  process.exit(0);
});
