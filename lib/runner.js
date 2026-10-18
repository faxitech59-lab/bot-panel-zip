/**
 * BotPanel runner — manages bot processes on a single Railway service.
 *
 * Each bot = a git repo cloned into DATA_DIR/bots/<name>, installed once,
 * then run as a detached child process. Logs go to DATA_DIR/logs/<name>.log.
 * State (including desired running state) is persisted in
 * DATA_DIR/panel-state.json so bots survive panel restarts.
 *
 * DATA_DIR should be a Railway Volume mount (e.g. /data) so code, sessions
 * and databases survive redeploys.
 */
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || '/data';
const BOTS_DIR = path.join(DATA_DIR, 'bots');
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const STATE_FILE = path.join(DATA_DIR, 'panel-state.json');

for (const d of [DATA_DIR, BOTS_DIR, LOGS_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

// name -> child process (only while actually running)
const procs = new Map();

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!s.bots) s.bots = {};
    return s;
  } catch {
    return { bots: {} };
  }
}

function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function botDir(name) {
  return path.join(BOTS_DIR, name);
}

function logFile(name) {
  return path.join(LOGS_DIR, `${name}.log`);
}

function appendLog(name, chunk) {
  try {
    fs.appendFileSync(logFile(name), chunk);
    // Rotate: keep log under ~5MB
    const st = fs.statSync(logFile(name));
    if (st.size > 5 * 1024 * 1024) {
      const fd = fs.openSync(logFile(name), 'r+');
      const keep = 2 * 1024 * 1024;
      const buf = Buffer.alloc(keep);
      fs.readSync(fd, buf, 0, keep, st.size - keep);
      fs.ftruncateSync(fd, 0);
      fs.writeSync(fd, buf, 0, keep);
      fs.closeSync(fd);
    }
  } catch {}
}

function execGit(args, cwd) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 120000 }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code || 1 : 0, out: String(stdout || '') + String(stderr || '') });
    });
  });
}

/* ---------- ZIP upload support ---------- */

function listZipEntries(zipPath) {
  return new Promise((resolve) => {
    execFile('unzip', ['-Z1', zipPath], { timeout: 30000 }, (err, stdout) => {
      if (err) return resolve({ code: 1, entries: [] });
      resolve({
        code: 0,
        entries: String(stdout || '').split('\n').map((s) => s.trim()).filter(Boolean),
      });
    });
  });
}

/** Zip-slip protection: khatarnaak paths reject karo. */
function safeZipEntry(e) {
  if (!e) return false;
  if (e.startsWith('/') || e.startsWith('\\')) return false;
  if (/^[a-zA-Z]:/.test(e)) return false; // windows drive
  if (e.split('/').includes('..')) return false;
  return true;
}

async function extractZip(zipPath, destDir) {
  const { code, entries } = await listZipEntries(zipPath);
  if (code !== 0 || !entries.length) throw new Error('ZIP khaali ya kharab hai');
  const bad = entries.filter((e) => !safeZipEntry(e));
  if (bad.length) throw new Error('ZIP me ghalat file paths hain — upload cancel kiya gaya');
  fs.mkdirSync(destDir, { recursive: true });
  await new Promise((resolve, reject) => {
    execFile('unzip', ['-q', '-o', zipPath, '-d', destDir], { timeout: 180000 }, (err) => {
      if (err) reject(new Error('Unzip failed'));
      else resolve();
    });
  });
  // Agar ZIP me single top-level folder ho (folder zip karke bheja ho) to unwrap karo
  const top = fs.readdirSync(destDir);
  if (top.length === 1) {
    const single = path.join(destDir, top[0]);
    if (fs.statSync(single).isDirectory()) {
      const tmp = destDir + '__unwrap';
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
      fs.renameSync(single, tmp);
      for (const f of fs.readdirSync(tmp)) {
        fs.renameSync(path.join(tmp, f), path.join(destDir, f));
      }
      fs.rmdirSync(tmp);
    }
  }
  // node_modules saath aaya ho to hatao — fresh install hoga
  try { fs.rmSync(path.join(destDir, 'node_modules'), { recursive: true, force: true }); } catch {}
}

/** Code maujood hai (clone ya unzip ke baad): start-cmd detect -> install -> stopped. */
async function finishSetup(name) {
  let st = loadState();
  let b = st.bots[name];
  if (!b) return;

  if (!b.startCmd) {
    b.startCmd = detectStartCmd(botDir(name), '');
    appendLog(name, `[panel] start command auto-detect: ${b.startCmd}\n`);
    saveState(st);
  }

  b.status = 'installing';
  saveState(st);
  const cmd = detectInstallCmd(botDir(name), b.installCmd);
  if (cmd) {
    appendLog(name, `[panel] installing: ${cmd}\n`);
    const ir = await runShell(cmd, botDir(name), b.env);
    appendLog(name, ir.out.slice(-3000) + `\n[panel] install exit code ${ir.code}\n`);
    st = loadState(); b = st.bots[name]; if (!b) return;
    if (ir.code !== 0) {
      b.status = 'error';
      b.lastError = 'install failed (code ' + ir.code + ') — logs dekho';
      saveState(st);
      return;
    }
  } else {
    appendLog(name, `[panel] install step skipped (koi lockfile/package.json nahi)\n`);
  }
  b.status = 'stopped';
  b.lastError = '';
  saveState(st);
  appendLog(name, `[panel] tayyar hai — Start dabao\n`);
}

function runShell(cmd, cwd, env) {
  return new Promise((resolve) => {
    const child = spawn(cmd, {
      shell: true,
      cwd,
      env: { ...process.env, ...env },
      timeout: 600000,
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (err) => resolve({ code: -1, out: String(err && err.message || err) }));
    child.on('close', (code) => resolve({ code, out }));
  });
}

function readPkg(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** Install command auto-detect: lockfile se package manager,
 *  TypeScript project ho to build step bhi auto jor do. */
function detectInstallCmd(dir, override) {
  if (override && override.trim()) return override.trim();
  const pkg = readPkg(dir);
  let base = '';
  let pm = 'npm';
  if (fs.existsSync(path.join(dir, 'yarn.lock'))) { base = 'yarn install'; pm = 'yarn'; }
  else if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) { base = 'pnpm install'; pm = 'pnpm'; }
  else if (fs.existsSync(path.join(dir, 'package-lock.json'))) { base = 'npm install'; pm = 'npm'; }
  else if (pkg) { base = 'npm install'; pm = 'npm'; }
  else if (fs.existsSync(path.join(dir, 'requirements.txt'))) return 'pip install --break-system-packages -r requirements.txt';
  if (!base) return '';

  // TypeScript project jisme build script ho → install ke baad build bhi
  const isTS = pkg && (
    (pkg.devDependencies && pkg.devDependencies.typescript) ||
    (pkg.dependencies && pkg.dependencies.typescript) ||
    fs.existsSync(path.join(dir, 'tsconfig.json'))
  );
  const hasBuild = pkg && pkg.scripts && pkg.scripts.build;
  if (isTS && hasBuild) {
    const buildCmd = pm === 'npm' ? 'npm run build' : pm + ' build';
    return `${base} && ${buildCmd}`;
  }
  return base;
}

/** Start command auto-detect: package.json ka start script,
 *  warna aam entry files (index.js, app.py, ...). */
function detectStartCmd(dir, override) {
  if (override && override.trim()) return override.trim();
  const pkg = readPkg(dir);
  if (pkg && pkg.scripts && pkg.scripts.start) return 'npm start';
  const cands = [
    ['index.js', 'app.js', 'main.js', 'server.js', 'bot.js', 'run.js'],
    ['index.py', 'app.py', 'main.py', 'bot.py', 'run.py'],
  ];
  for (const f of cands[0]) {
    if (fs.existsSync(path.join(dir, f))) return `node ${f}`;
  }
  for (const f of cands[1]) {
    if (fs.existsSync(path.join(dir, f))) return `python3 ${f}`;
  }
  return 'npm start';
}

function validName(name) {
  return typeof name === 'string' && /^[a-z0-9][a-z0-9-_]*$/i.test(name) && name.length <= 40;
}

function validRepo(repo) {
  return typeof repo === 'string' && /^https:\/\/[a-z0-9._~:/?#@!$&'()*+,;=-]+$/i.test(repo);
}

function validBranch(branch) {
  return typeof branch === 'string' && /^[a-zA-Z0-9._\-/]+$/.test(branch) && branch.length <= 80;
}

function publicBot(b) {
  return {
    name: b.name,
    source: b.source || (b.repo ? 'git' : 'zip'),
    repo: b.repo,
    branch: b.branch || 'default',
    startCmd: b.startCmd,
    installCmd: b.installCmd,
    envKeys: Object.keys(b.env || {}),
    port: b.assignedPort || null,
    status: b.status,
    desired: b.desired,
    running: procs.has(b.name),
    restarts: b.restarts || 0,
    lastError: b.lastError || '',
    createdAt: b.createdAt,
    startedAt: b.startedAt || null,
  };
}

/** Add a bot: clone + install in background, then leave it stopped. */
async function addBot({ name, repo, branch, env, installCmd, startCmd }) {
  if (!validName(name)) throw new Error('Bot name me sirf letters, numbers, - aur _ (max 40)');
  if (!validRepo(repo)) throw new Error('Repo URL https:// se shuru hona chahiye');
  branch = (branch || '').trim(); // khali = repo ki default branch
  if (branch && !validBranch(branch)) throw new Error('Branch name ghalat hai');

  const s = loadState();
  if (s.bots[name]) throw new Error('Is naam ka bot pehle se maujood hai');
  if (fs.existsSync(botDir(name))) throw new Error('Folder pehle se maujood hai');

  s.bots[name] = {
    name,
    source: 'git',
    repo,
    branch,
    env: env || {},
    installCmd: (installCmd || '').trim(),
    startCmd: (startCmd || '').trim(), // khali = clone ke baad auto-detect
    desired: 'stopped',
    status: 'cloning',
    restarts: 0,
    lastError: '',
    createdAt: Date.now(),
  };
  saveState(s);
  appendLog(name, `[panel] bot add ho raha hai: ${repo} (branch ${branch})\n`);

  // Background pipeline: clone -> install. Status polling se follow karo.
  (async () => {
    try {
      let st = loadState();
      let b = st.bots[name];
      if (!b) return;

      const mkClone = (br) => br
        ? ['clone', '--depth', '1', '--branch', br, b.repo, botDir(name)]
        : ['clone', '--depth', '1', b.repo, botDir(name)]; // default branch

      let r = await execGit(mkClone(b.branch), DATA_DIR);
      st = loadState(); b = st.bots[name]; if (!b) return;

      // Agar di hui branch na mile to khud default branch try karo
      if (r.code !== 0 && b.branch && /remote branch .* not found/i.test(r.out)) {
        appendLog(name, `[panel] branch '${b.branch}' nahi mili — default branch try kar raha hoon\n`);
        b.branch = '';
        saveState(st);
        try { fs.rmSync(botDir(name), { recursive: true, force: true }); } catch {}
        r = await execGit(mkClone(''), DATA_DIR);
        st = loadState(); b = st.bots[name]; if (!b) return;
      }

      if (r.code !== 0) {
        b.status = 'error';
        b.lastError = 'git clone failed:\n' + r.out.slice(-1500);
        saveState(st);
        appendLog(name, `[panel] clone failed\n${r.out.slice(-2000)}\n`);
        return;
      }
      appendLog(name, `[panel] clone complete\n`);
      await finishSetup(name);
    } catch (e) {
      const st = loadState();
      if (st.bots[name]) {
        st.bots[name].status = 'error';
        st.bots[name].lastError = String(e.message || e);
        saveState(st);
      }
      appendLog(name, `[panel] error: ${e.message || e}\n`);
    }
  })();

  return publicBot(s.bots[name]);
}

/** Add a bot from an uploaded ZIP: extract + install in background, then leave it stopped. */
async function addBotFromZip({ name, zipPath, env, installCmd, startCmd }) {
  if (!validName(name)) throw new Error('Bot name me sirf letters, numbers, - aur _ (max 40)');

  const s = loadState();
  if (s.bots[name]) throw new Error('Is naam ka bot pehle se maujood hai');
  if (fs.existsSync(botDir(name))) throw new Error('Folder pehle se maujood hai');

  s.bots[name] = {
    name,
    source: 'zip',
    repo: '',
    branch: '',
    env: env || {},
    installCmd: (installCmd || '').trim(),
    startCmd: (startCmd || '').trim(), // khali = extract ke baad auto-detect
    desired: 'stopped',
    status: 'extracting',
    restarts: 0,
    lastError: '',
    createdAt: Date.now(),
  };
  saveState(s);
  appendLog(name, `[panel] ZIP upload se bot add ho raha hai\n`);

  // Background pipeline: extract -> install. Status polling se follow karo.
  (async () => {
    try {
      await extractZip(zipPath, botDir(name));
      appendLog(name, `[panel] ZIP extract complete\n`);
      await finishSetup(name);
    } catch (e) {
      const st = loadState();
      if (st.bots[name]) {
        st.bots[name].status = 'error';
        st.bots[name].lastError = String(e.message || e);
        saveState(st);
      }
      appendLog(name, `[panel] error: ${e.message || e}\n`);
    } finally {
      try { fs.unlinkSync(zipPath); } catch {}
    }
  })();

  return publicBot(s.bots[name]);
}

/** ZIP redeploy: purana code hatao, nayi ZIP extract karo, reinstall + restart. */
async function redeployBotFromZip(name, zipPath) {
  const s = loadState();
  const b = s.bots[name];
  if (!b) throw new Error('Bot nahi mila');
  const wasRunning = b.desired === 'running';
  if (procs.has(name)) stopBot(name);
  // exit hone ka thoda wait
  await new Promise((r) => setTimeout(r, 2500));

  appendLog(name, '[panel] ZIP redeploy: purana code hata kar naya extract ho raha hai\n');
  try { fs.rmSync(botDir(name), { recursive: true, force: true }); } catch {}
  try {
    await extractZip(zipPath, botDir(name));
    appendLog(name, '[panel] ZIP extract complete\n');
    const cmd = detectInstallCmd(botDir(name), b.installCmd);
    if (cmd) {
      appendLog(name, `[panel] redeploy install: ${cmd}\n`);
      const ir = await runShell(cmd, botDir(name), b.env);
      appendLog(name, ir.out.slice(-2000) + `\n[panel] install exit ${ir.code}\n`);
    }
    const st = loadState();
    st.bots[name].status = 'stopped';
    st.bots[name].source = 'zip';
    saveState(st);
    if (wasRunning) return startBot(name);
    return publicBot(st.bots[name]);
  } finally {
    try { fs.unlinkSync(zipPath); } catch {}
  }
}

/** Start (or restart) a bot process. */
function startBot(name) {
  const s = loadState();
  const b = s.bots[name];
  if (!b) throw new Error('Bot nahi mila');
  if (procs.has(name)) throw new Error('Bot pehle se chal raha hai');
  const dir = botDir(name);
  if (!fs.existsSync(dir)) {
    b.status = 'error';
    b.lastError = 'Code folder nahi mila — bot dobara add karo';
    saveState(s);
    throw new Error(b.lastError);
  }

  // Safety: start command kabhi khali na ho
  if (!b.startCmd) b.startCmd = detectStartCmd(dir, '');

  // Port handling: Railway ka PORT sirf panel ke liye hai.
  // Har bot ko apna alag port do taake EADDRINUSE takrao na ho.
  if (!b.assignedPort) {
    const used = new Set(Object.values(s.bots).map((x) => x.assignedPort).filter(Boolean));
    let p = 4100;
    while (used.has(p)) p++;
    b.assignedPort = p;
  }
  const inherited = { ...process.env };
  delete inherited.PORT; // Railway ka PORT bots tak na jaye
  // VPS=true: Levanter jaisi bot families ko platform batana zaroori hai (warna 'Failed detect the Platform'). Panel khud VPS jaisa env hai; bot ki apni setting ho to usi ki jeet.
  const botEnv = { ...inherited, VPS: 'true', PORT: String(b.assignedPort), ...b.env };

  const child = spawn(b.startCmd, {
    shell: true,
    cwd: dir,
    env: botEnv,
    detached: true, // apna process group, taake stop par poora tree mare
  });

  child.stdout.on('data', (d) => appendLog(name, d));
  child.stderr.on('data', (d) => appendLog(name, d));
  child.on('error', (err) => appendLog(name, `[panel] spawn error: ${err.message}\n`));
  child.on('exit', (code, signal) => {
    procs.delete(name);
    appendLog(name, `[panel] process exited (code=${code}, signal=${signal})\n`);
    const st = loadState();
    const bb = st.bots[name];
    if (!bb) return;
    if (bb.desired === 'running') {
      // Crash → auto-restart with backoff
      bb.restarts = (bb.restarts || 0) + 1;
      bb.status = 'restarting';
      saveState(st);
      const delay = Math.min(5000 * Math.pow(2, Math.min(bb.restarts - 1, 4)), 60000);
      appendLog(name, `[panel] ${Math.round(delay / 1000)}s me restart (attempt ${bb.restarts})\n`);
      const t = setTimeout(() => {
        try { startBot(name); }
        catch (e) { appendLog(name, `[panel] restart failed: ${e.message}\n`); }
      }, delay);
      t.unref();
    } else {
      bb.status = 'stopped';
      saveState(st);
    }
  });

  child.unref();
  procs.set(name, child);

  b.desired = 'running';
  b.status = 'running';
  b.startedAt = Date.now();
  b.lastError = '';
  saveState(s);
  appendLog(name, `[panel] started: ${b.startCmd} (pid ${child.pid}, PORT=${botEnv.PORT})\n`);
  return publicBot(b);
}

/** Stop a bot (no auto-restart). */
function stopBot(name) {
  const s = loadState();
  const b = s.bots[name];
  if (!b) throw new Error('Bot nahi mila');
  b.desired = 'stopped';
  const child = procs.get(name);
  if (child) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5000).unref();
    appendLog(name, '[panel] stop signal bheja gaya\n');
  }
  b.status = 'stopped';
  saveState(s);
  return publicBot(b);
}

/** git pull + reinstall + restart. */
async function redeployBot(name) {
  const s = loadState();
  const b = s.bots[name];
  if (!b) throw new Error('Bot nahi mila');
  const wasRunning = b.desired === 'running';
  if (procs.has(name)) stopBot(name);
  // exit hone ka thoda wait
  await new Promise((r) => setTimeout(r, 2500));

  appendLog(name, '[panel] redeploy: git pull\n');
  const pr = await execGit(['-C', botDir(name), 'pull', '--ff-only'], DATA_DIR);
  appendLog(name, pr.out.slice(-1500) + '\n');
  const cmd = detectInstallCmd(botDir(name), b.installCmd);
  if (cmd && pr.code === 0) {
    appendLog(name, `[panel] redeploy install: ${cmd}\n`);
    const ir = await runShell(cmd, botDir(name), b.env);
    appendLog(name, ir.out.slice(-2000) + `\n[panel] install exit ${ir.code}\n`);
  }
  const st = loadState();
  st.bots[name].status = 'stopped';
  saveState(st);
  if (wasRunning) return startBot(name);
  return publicBot(st.bots[name]);
}

/** Auto-fix: custom commands reset karo, dobara auto-detect + redeploy + start.
 *  Testers ke liye one-click repair — settings me haath dalne ki zaroorat nahi. */
async function autofixBot(name) {
  let s = loadState();
  const b = s.bots[name];
  if (!b) throw new Error('Bot nahi mila');
  b.installCmd = '';
  b.startCmd = '';
  b.restarts = 0;
  b.lastError = '';
  saveState(s);
  appendLog(name, '[panel] auto-fix: commands reset — dobara auto-detect ho raha hai\n');
  const src = b.source || (b.repo ? 'git' : 'zip');
  if (src === 'zip') {
    // ZIP bots ke paas git history nahi — sirf dobara install + start
    if (procs.has(name)) stopBot(name);
    await new Promise((r) => setTimeout(r, 2500));
    await finishSetup(name);
  } else {
    await redeployBot(name);
  }
  // Redeploy ke baad bot chal raha ho, ya nahi to start karo
  s = loadState();
  if (!procs.has(name)) {
    try {
      startBot(name);
      appendLog(name, '[panel] auto-fix complete — bot start ho gaya\n');
    } catch (e) {
      appendLog(name, `[panel] auto-fix start failed: ${e.message}\n`);
    }
  } else {
    appendLog(name, '[panel] auto-fix complete\n');
  }
  return getBot(name);
}

/** Stop + delete code, logs and state. */
function deleteBot(name) {
  const s = loadState();
  if (!s.bots[name]) throw new Error('Bot nahi mila');
  try { stopBot(name); } catch {}
  try { fs.rmSync(botDir(name), { recursive: true, force: true }); } catch {}
  try { fs.unlinkSync(logFile(name)); } catch {}
  delete s.bots[name];
  saveState(s);
  return { ok: true };
}

function listBots() {
  const s = loadState();
  return Object.values(s.bots).map(publicBot);
}

function getBot(name) {
  const s = loadState();
  const b = s.bots[name];
  if (!b) throw new Error('Bot nahi mila');
  return publicBot(b);
}

function getLogs(name, lines = 200) {
  const s = loadState();
  if (!s.bots[name]) throw new Error('Bot nahi mila');
  try {
    const data = fs.readFileSync(logFile(name), 'utf8');
    return data.split('\n').slice(-lines).join('\n');
  } catch {
    return '(koi logs nahi)';
  }
}

function updateBotEnv(name, env) {
  const s = loadState();
  const b = s.bots[name];
  if (!b) throw new Error('Bot nahi mila');
  b.env = env || {};
  saveState(s);
  return publicBot(b);
}

/** Bot ki settings edit: env, start command, install command. */
function updateBotSettings(name, { env, startCmd, installCmd }) {
  const s = loadState();
  const b = s.bots[name];
  if (!b) throw new Error('Bot nahi mila');
  if (env !== undefined) b.env = env || {};
  if (startCmd !== undefined && String(startCmd).trim()) b.startCmd = String(startCmd).trim();
  if (installCmd !== undefined) b.installCmd = String(installCmd).trim();
  saveState(s);
  return publicBot(b);
}

/** Panel boot par: jo bots 'running' chahiye thay unhe dobara start karo. */
function boot() {
  const s = loadState();
  let i = 0;
  for (const b of Object.values(s.bots)) {
    if (['cloning', 'extracting', 'installing', 'restarting'].includes(b.status)) {
      b.status = 'error';
      b.lastError = 'Panel restart hua tha — dobara start karo';
    }
    if (b.desired === 'running') {
      b.status = 'starting';
      const delay = 3000 * (++i);
      setTimeout(() => {
        try { startBot(b.name); }
        catch (e) { appendLog(b.name, `[panel] boot start failed: ${e.message}\n`); }
      }, delay).unref();
    }
  }
  saveState(s);
}

module.exports = {
  addBot, addBotFromZip, startBot, stopBot, redeployBot, redeployBotFromZip, autofixBot, deleteBot,
  listBots, getBot, getLogs, updateBotEnv, updateBotSettings, boot, DATA_DIR,
};
