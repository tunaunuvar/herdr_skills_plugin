"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const readline = require("node:readline");
const { spawn, execFile } = require("node:child_process");
const HOME = os.homedir();
const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, ".codex");
const clean = s => String(s ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
const norm = (s, platform = process.platform) => platform === "win32"
  ? String(s || "").replace(/\\\\\?\\/g, "").replace(/\\+/g, "/").replace(/\/+$/g, "").toLowerCase()
  : String(s || "").replace(/\/+$/g, "");

const TOOL_COMMANDS = [
  ["graft", "Graft", "Code mapping, search and AI context tools"],
  ["codex", "Codex", "OpenAI coding agent"], ["claude", "Claude Code", "Anthropic coding agent"],
  ["omp", "Oh My Pi", "OMP coding agent"], ["pi", "Pi", "Pi coding agent"],
  ["herdr", "Herdr", "AI terminal and plugin manager"], ["git", "Git", "Version control"],
  ["gh", "GitHub CLI", "GitHub command line"], ["node", "Node.js", "JavaScript runtime"],
  ["npm", "npm", "Node.js package manager"], ["python", "Python", "Python runtime"],
  ["uv", "uv", "Python package and environment manager"], ["rg", "Ripgrep", "Fast file and text search"],
  ["opencode", "OpenCode", "OpenCode coding agent"], ["gemini", "Gemini CLI", "Google coding agent"],
  ["firebase", "Firebase CLI", "Firebase project and deployment tools"],
];

function findExecutable(command, env = process.env, platform = process.platform) {
  const extensions = platform === "win32" ? ["", ...(env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";")] : [""];
  for (const dir of (env.PATH || "").split(platform === "win32" ? ";" : ":").filter(Boolean)) {
    for (const ext of extensions) {
      const file = path.join(dir.replace(/^"|"$/g, ""), command + ext);
      try { if (fs.statSync(file).isFile()) { fs.accessSync(file, platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK); return file; } } catch { /* Next PATH entry. */ }
    }
  }
  return null;
}

function gitStatus(cwd) {
  return new Promise(resolve => execFile("git", ["-C", cwd, "status", "--short", "--branch", "--untracked-files=normal"],
    { timeout: 3000, windowsHide: true, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
      if (error) return resolve({ available: false, repository: !/not a git repository|cannot change to/i.test(stderr || ""), branch: "", changes: 0,
        summary: /not a git repository|cannot change to/i.test(stderr || "") ? "No Git repository for this session" : "Git status unavailable" });
      const [head = "", ...rows] = stdout.trimEnd().split(/\r?\n/);
      const branch = head.replace(/^##\s*/, "").replace(/\.\.\..*$/, "");
      const changes = rows.map(row => ({ code: row.slice(0, 2), file: row.slice(3).replace(/^"|"$/g, "") }));
      const counts = { staged: 0, modified: 0, untracked: 0, deleted: 0 };
      for (const { code } of changes) {
        if (code === "??") counts.untracked++;
        else {
          if (code[0] !== " " && code[0] !== "?") counts.staged++;
          if (code.includes("M")) counts.modified++;
          if (code.includes("D")) counts.deleted++;
        }
      }
      const aheadBehind = head.match(/\[(ahead \d+(?:, behind \d+)?|behind \d+)\]/)?.[1];
      const summary = [counts.staged && `${counts.staged} staged`, counts.modified && `${counts.modified} modified`,
        counts.deleted && `${counts.deleted} deleted`, counts.untracked && `${counts.untracked} untracked`, aheadBehind].filter(Boolean).join(" · ") || "Working tree clean";
      resolve({ available: true, repository: true, branch: branch || "(unknown branch)", changes: changes.length, counts, aheadBehind, summary, files: changes.slice(0, 5) });
    }));
}

function installedTools() {
  return TOOL_COMMANDS.flatMap(([command, name, description]) => {
    const actual = command === "python" && !findExecutable(command) ? "python3" : command;
    const file = findExecutable(actual);
    return file ? [{ command: actual, name, description, path: file, enabled: true, scope: "PATH", type: "tool" }] : [];
  });
}

function runHerdr(args) {
  return new Promise((resolve, reject) => execFile(process.env.HERDR_BIN_PATH || "herdr", args,
    { timeout: 8000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, out) => {
      if (error) return reject(new Error("Cannot access the Herdr session"));
      try { resolve(JSON.parse(out).result); } catch { reject(new Error("Cannot parse the Herdr response")); }
    }));
}

function codexSkills(cwds) {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", ["app-server"], { windowsHide: true, shell: process.platform === "win32", stdio: ["pipe", "pipe", "ignore"] });
    let done = false;
    const timer = setTimeout(() => finish(new Error("Codex skill discovery timed out")), 20000);
    function finish(error, data) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // Close stdio gracefully; killing the cmd shim can leave its child alive on Windows.
      child.stdin.end();
      const killer = setTimeout(() => child.kill(), 1000);
      killer.unref();
      child.once("close", () => clearTimeout(killer));
      if (error) reject(error); else resolve(data);
    }
    const send = (id, method, params) => child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    child.on("error", () => finish(new Error("Codex CLI not found")));
    child.stdin.on("error", () => finish(new Error("Codex connection closed")));
    child.on("close", () => { if (!done) finish(new Error("Cannot retrieve Codex skills")); });
    readline.createInterface({ input: child.stdout }).on("line", line => {
      let m; try { m = JSON.parse(line); } catch { return; }
      if (m.error) return finish(new Error(m.error.message || "Codex RPC error"));
      if (m.id === 1) {
        child.stdin.write('{"method":"initialized"}\n');
        send(2, "skills/list", { cwds, forceReload: true });
      }
      if (m.id === 2) finish(null, m.result.data);
    });
    send(1, "initialize", { clientInfo: { name: "herdr-skills", version: "0.4.0" }, capabilities: {} });
  });
}

function filesUnder(root, suffix, depth = 8, seen = new Set(), warnings = []) {
  const files = [];
  try {
    const real = fs.realpathSync(root);
    if (seen.has(real)) return files;
    seen.add(real);
    for (const item of fs.readdirSync(root, { withFileTypes: true })) {
      const f = path.join(root, item.name);
      if (item.isFile() && item.name.endsWith(suffix)) files.push(f);
      else if (depth > 0 && !["node_modules", ".git", "references", "assets", "scripts"].includes(item.name)
        && (item.isDirectory() || item.isSymbolicLink())) files.push(...filesUnder(f, suffix, depth - 1, seen, warnings));
    }
  } catch (error) { if (error.code !== "ENOENT") warnings.push(`Cannot read: ${root}`); }
  return files;
}

function diskSkills(kind, cwd, warnings = []) {
  const roots = [path.join(HOME, ".agents", "skills")];
  if (kind === "claude") roots.push(path.join(HOME, ".claude", "skills"));
  if (kind === "omp") roots.push(path.join(HOME, ".omp", "agent", "skills"));
  if (kind === "pi") roots.push(path.join(HOME, ".pi", "agent", "skills"));
  if (kind === "codex") roots.push(path.join(CODEX_HOME, "skills"), path.join(CODEX_HOME, "plugins", "cache"));
  // Project skill folders from the current directory up to its repository root.
  for (let d = cwd; d; d = path.dirname(d) === d ? null : path.dirname(d)) {
    roots.push(path.join(d, ".agents", "skills"), path.join(d, `.${kind === "omp" ? "omp" : kind}`, "skills"));
    if (fs.existsSync(path.join(d, ".git"))) break;
  }
  const paths = [...new Set(roots.flatMap(r => filesUnder(r, "SKILL.md", 6, new Set(), warnings)))];
  return paths.map(file => {
    let s = ""; try { s = fs.readFileSync(file, "utf8"); } catch { warnings.push(`Cannot read: ${file}`); }
    const header = s.replace(/^\uFEFF/, "").match(/^---\r?\n([\s\S]*?)\r?\n---/m)?.[1] || "";
    const description = header.match(/^description:\s*(.+)/m)?.[1] || "";
    return { name: header.match(/^name:\s*["']?([^\r\n"']+)/m)?.[1]?.trim() || path.basename(path.dirname(file)),
      description: /^[>|]-?$/.test(description) ? (header.match(/^description:[^\n]*\n((?:[ \t]+[^\n]*\n?)+)/m)?.[1] || "").trim().replace(/\s+/g, " ") : description.replace(/^["']|["']$/g, ""),
      path: file, enabled: null, scope: "disk" };
  });
}

function toolText(record) {
  const p = record.payload || record;
  if (["function_call", "custom_tool_call"].includes(p.type)) {
    if (/apply_patch|imagegen|write_file/.test(p.name || "")) return "";
    let args = p.arguments || p.input || "";
    try { args = JSON.parse(args); } catch { /* Custom tools may contain raw code. */ }
    return typeof args === "string" ? args : JSON.stringify(args).replace(/\\\\/g, "\\");
  }
  // Pi/OMP and Claude store tool calls in assistant message content blocks.
  const message = record.message;
  if (message?.role !== "assistant") return "";
  return (Array.isArray(message.content) ? message.content : []).filter(b => ["toolCall", "tool_use"].includes(b.type))
    .map(b => JSON.stringify(b.arguments || b.input || {})).join(" ").replace(/\\\\/g, "\\");
}

function readsFromRecord(record, skills) {
  const command = toolText(record);
  // ponytail: conservative full-path read detection; add native skill events for agents that expose them.
  if (!/\b(Get-Content|cat|read|read_file|readFileSync|read_text|type)\b/i.test(command)) return [];
  const value = norm(command);
  return skills.filter(s => s.path && value.includes(norm(s.path))).map(s => s.path);
}

function toolsFromRecord(record, tools) {
  const text = toolText(record);
  return tools.filter(t => new RegExp(`(?:^|[\\s;|&"'\x60])${t.command}(?:\\.(?:cmd|exe|ps1))?(?=\\s|$)`, "i").test(text)).map(t => t.path);
}

async function sessionUsage(file, skills, tools = []) {
  const used = new Map();
  if (!file) return { used, note: "No session transcript; usage unknown" };
  try {
    const input = fs.createReadStream(file, { encoding: "utf8" });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      let record; try { record = JSON.parse(line); } catch { continue; }
      for (const p of readsFromRecord(record, skills)) used.set(norm(p), record.timestamp || "");
      for (const p of toolsFromRecord(record, tools)) used.set(norm(p), record.timestamp || "");
    }
    return { used, note: "READ means a skill read call was observed in this session; it does not mean currently active" };
  } catch { return { used, note: "Cannot read the session transcript; usage unknown" }; }
}

function findSession(agent, indexes) {
  const id = agent.agent_session?.kind === "id" && agent.agent_session.value;
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) return null;
  return (indexes[agent.agent] || []).find(f => path.basename(f).includes(id)) || null;
}

async function snapshot() {
  const warnings = [];
  const tools = installedTools();
  let agents = [];
  try { agents = (await runHerdr(["agent", "list"])).agents || []; }
  catch (error) { warnings.push(error.message); }
  const cwd = process.env.HERDR_ACTIVE_PANE_CWD || process.env.HERDR_PANE_CWD || HOME;
  const supported = ["codex", "claude", "omp", "pi"];
  const contexts = agents.filter(a => supported.includes(a.agent));
  for (const kind of supported) {
    if (!contexts.some(a => a.agent === kind) && (findExecutable(kind) || fs.existsSync(kind === "codex" ? CODEX_HOME : path.join(HOME, `.${kind}`))))
      contexts.push({ agent: kind, cwd, pane_id: null, agent_status: "local", terminal_title_stripped: "Local installation" });
  }
  if (!contexts.length) contexts.push({ agent: "local", cwd, pane_id: null, agent_status: "local", terminal_title_stripped: "Local installation" });
  for (const a of agents.filter(a => !supported.includes(a.agent))) warnings.push(`${a.agent}: no skill adapter (${a.pane_id})`);
  let codex = [];
  const cwds = [...new Set(contexts.filter(a => a.agent === "codex").map(a => a.cwd || cwd))];
  if (cwds.length && findExecutable("codex")) try { codex = await codexSkills(cwds); } catch (error) { warnings.push(error.message + "; showing local files"); }
  const indexes = {};
  for (const kind of new Set(contexts.map(a => a.agent))) {
    const root = kind === "codex" ? path.join(CODEX_HOME, "sessions") : kind === "claude" ? path.join(HOME, ".claude", "projects")
      : path.join(HOME, `.${kind}`, "agent", "sessions");
    indexes[kind] = filesUnder(root, ".jsonl", 8, new Set(), warnings);
  }
  const gitByCwd = new Map();
  const groups = await Promise.all(contexts.map(async a => {
    const entry = a.agent === "codex" && codex.find(e => norm(e.cwd) === norm(a.cwd || cwd));
    const disk = diskSkills(a.agent, a.cwd || cwd, warnings);
    const skills = entry ? [...entry.skills, ...disk.filter(s => !entry.skills.some(e => norm(e.path) === norm(s.path)))] : disk;
    if (entry?.errors?.length) warnings.push(...entry.errors.map(e => e.message || "Codex skill error"));
    const usage = await sessionUsage(findSession(a, indexes), skills, tools);
    const repoPath = a.cwd || cwd;
    if (!gitByCwd.has(repoPath)) gitByCwd.set(repoPath, gitStatus(repoPath));
    const git = await gitByCwd.get(repoPath);
    const mark = s => ({ ...s, readAt: usage.used.get(norm(s.path)), read: usage.used.has(norm(s.path)) });
    return { ...a, git, skills: skills.map(mark), tools: tools.map(mark), note: usage.note };
  }));
  return { groups, warnings: [...new Set(warnings)], updatedAt: new Date().toLocaleTimeString("en-GB") };
}

const filters = ["All", "Usage observed", "No record", "Enabled / installed", "Disabled", "Files only"];
const labels = {
  en: {
    title: "SKILLS & TOOLS", skills: "SKILLS", skill: "SKILL", tools: "TOOLS", switch: "switch", refreshing: "Refreshing…", loading: "Loading…", session: "Session",
    installed: "INSTALLED", disabled: "DISABLED", enabled: "ENABLED", onDisk: "ON DISK", callObserved: "CALL OBSERVED", read: "READ", noRecord: "NO RECORD",
    toolCount: "TOOLS", skillCount: "SKILL", installedCount: "INSTALLED", enabledCount: "ENABLED", usageCount: "USAGE RECORDS", disabledCount: "DISABLED",
    filter: "Filter", search: "Search", results: "results", name: "NAME", state: "STATE", thisSession: "THIS SESSION", compactColumns: "NAME / STATE / USAGE",
    noMatches: "No entries match this filter.", skillFallback: "See the skill file for its description", toolFallback: "Command-line tool", diskFallback: "Local file / plugin cache", skillLabel: "AI skill",
    toolNote: "INSTALLED: found on Herdr PATH. CALL OBSERVED: invocation in this session.", skillNote: "ENABLED: enabled in AI discovery. ON DISK: enablement unknown. READ: a read call.",
    noRecordNote: "NO RECORD does not prove non-use.  Open: F8 / Ctrl+B → Shift+S", searchPrompt: "/ Type to search · Enter done · Esc clear",
    controls: "[Tab] Skills/Tools  [←→] Session  [f] Filter  [/] Search  [d] Paths  [l] Language: EN",
    scroll: "[↑↓ / PgUp/PgDn] Scroll   [r] Refresh   [q/Esc] Close", smallControls: "Tab: switch · l: language · q: close",
  },
  es: {
    title: "HABILIDADES Y HERRAMIENTAS", skills: "HABILIDADES", skill: "HABILIDAD", tools: "HERRAMIENTAS", switch: "cambiar", refreshing: "Actualizando…", loading: "Cargando…", session: "Sesión",
    installed: "INSTALADO", disabled: "DESACTIVADO", enabled: "ACTIVADO", onDisk: "EN DISCO", callObserved: "LLAMADA OBSERVADA", read: "LEÍDO", noRecord: "SIN REGISTRO",
    toolCount: "HERRAMIENTAS", skillCount: "HABILIDAD", installedCount: "INSTALADAS", enabledCount: "ACTIVADAS", usageCount: "USOS REGISTRADOS", disabledCount: "DESACTIVADAS",
    filter: "Filtro", search: "Buscar", results: "resultados", name: "NOMBRE", state: "ESTADO", thisSession: "ESTA SESIÓN", compactColumns: "NOMBRE / ESTADO / USO",
    noMatches: "No hay entradas para este filtro.", skillFallback: "Consulta el archivo de la habilidad", toolFallback: "Herramienta de línea de comandos", diskFallback: "Archivo local / caché del plugin", skillLabel: "Habilidad de IA",
    toolNote: "INSTALADO: disponible en PATH de Herdr. LLAMADA OBSERVADA: uso en esta sesión.", skillNote: "ACTIVADO: detectado por la API de habilidades. EN DISCO: estado desconocido. LEÍDO: lectura observada.",
    noRecordNote: "SIN REGISTRO no significa que no se usó.  Abrir: F8 / Ctrl+B → Shift+S", searchPrompt: "/ Escribe para buscar · Intro aceptar · Esc borrar",
    controls: "[Tab] Habilidades/Herr.  [←→] Sesión  [f] Filtro  [/] Buscar  [d] Rutas  [l] Idioma: Español",
    scroll: "[↑↓ / PgUp/PgDn] Desplazar   [r] Actualizar   [q/Esc] Cerrar", smallControls: "Tab: pestaña · l: idioma · q: cerrar",
  },
};
function filtered(skills, filter, query) {
  return skills.filter(s => (!filter || (filter === 1 ? s.read : filter === 2 ? !s.read : filter === 3 ? s.enabled === true : filter === 4 ? s.enabled === false : s.enabled == null))
    && `${s.name} ${s.description} ${s.path}`.toLowerCase().includes(query.toLowerCase()));
}

// Same terminal-width handling as the usage popup; no UI dependency needed.
function cellWidth(char) {
  if (/\p{Mark}/u.test(char) || char === "\u200d") return 0;
  const code = char.codePointAt(0);
  return code >= 0x1100 && (code <= 0x115f || (code >= 0x2e80 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xff01 && code <= 0xff60) || (code >= 0x1f300 && code <= 0x1faff) || code >= 0x20000) ? 2 : 1;
}
function fit(value, width) {
  const chars = [...clean(value)], total = chars.reduce((n, c) => n + cellWidth(c), 0);
  const limit = total > width ? Math.max(0, width - 1) : width;
  let out = "", used = 0;
  for (const c of chars) { const size = cellWidth(c); if (used + size > limit) break; out += c; used += size; }
  if (total > width && width > 0) { out += "…"; used++; }
  return out + " ".repeat(Math.max(0, width - used));
}

function renderPanel(data, state, columns = 110, rows = 32, colored = false) {
  const width = Math.max(12, columns - 2), inner = width - 4;
  const color = (s, code) => colored ? `\x1b[${code}m${s}\x1b[0m` : s;
  const line = (s, code = "37") => color("│ ", "90") + color(fit(s, inner), code) + color(" │", "90");
  const border = (left, right) => color(left + "─".repeat(width - 2) + right, "90");
  const t = labels[state.language] || labels.en;
  const group = data.groups[state.selected];
  const tools = state.tab === 1, all = (tools ? group?.tools : group?.skills) || [];
  const list = filtered(all, state.filter, state.query).sort((a, b) => tools
    ? Number(b.read) - Number(a.read) || a.name.localeCompare(b.name)
    : Number(b.read) - Number(a.read) || Number(b.enabled === true) - Number(a.enabled === true) || a.name.localeCompare(b.name));
  const counts = { read: all.filter(s => s.read).length, on: all.filter(s => s.enabled === true).length, off: all.filter(s => s.enabled === false).length };
  const gitSummary = group?.git?.summary || "Checking session repository…";
  const gitText = state.language === "es" ? gitSummary
    .replace("No Git repository for this session", "Sin repositorio Git en esta sesión")
    .replace("Git status unavailable", "Estado de Git no disponible")
    .replace("Checking session repository…", "Comprobando repositorio de la sesión…")
    .replace("Working tree clean", "Directorio de trabajo limpio")
    .replace(/\bstaged\b/g, "preparados").replace(/\bmodified\b/g, "modificados")
    .replace(/\bdeleted\b/g, "eliminados").replace(/\buntracked\b/g, "sin seguimiento")
    .replace(/\bahead\b/g, "adelante").replace(/\bbehind\b/g, "detrás") : gitSummary;
  const body = [];
  const statusWidth = state.language === "es" ? 11 : 9, nameWidth = Math.max(1, inner - statusWidth - 19);
  for (const s of list) {
    const status = s.type === "tool" ? t.installed : s.enabled === false ? t.disabled : s.enabled === true ? t.enabled : t.onDisk;
    const usage = s.read ? (tools ? t.callObserved : t.read) : t.noRecord;
    if (inner >= 48) {
      body.push(color("│ ", "90") + color(fit(s.name, nameWidth), "1;97") + " "
        + color(fit(status, statusWidth), s.enabled === true ? "32" : "33") + " "
        + color(fit(usage, 17), s.read ? "36" : "90") + color(" │", "90"));
    } else body.push(line(`${s.name} · ${status} · ${usage}`, s.read ? "1;36" : "1;37"));
    const desc = [">", "|", ">-", "|-"].includes(s.description?.trim()) ? t.skillFallback : s.description;
    body.push(line("  " + (desc || (s.type === "tool" ? t.toolFallback : `${s.scope === "disk" ? t.diskFallback : t.skillLabel}`)), "90"));
    if (state.details) body.push(line("  " + s.path, "90"));
    body.push(line(""));
  }
  if (!body.length) body.push(line(t.noMatches, "33"));
  let head = [border("╭", "╮"), line(`HERDR  /  ${t.title}       ${state.busy ? t.refreshing : data.updatedAt || ""}`, "1;36"),
    line(`${tools ? `  ${t.skills}` : `▸ ${t.skills}`} (${group?.skills.length || 0})    ${tools ? `▸ ${t.tools}` : `  ${t.tools}`} (${group?.tools?.length || 0})    [Tab] ${t.switch}`, "1;37"),
    border("├", "┤"),
    line(`${group?.agent.toUpperCase() || "AI"}  ${group?.pane_id || "local"}  ·  ${t.session} ${data.groups.length ? state.selected + 1 : 0}/${data.groups.length}  ·  ${group?.terminal_title_stripped || t.loading}`, "1;37"),
    line(group?.cwd || "", "90"),
    line(group?.git?.available ? `Git  ${group.git.branch}  ·  ${gitText}` : `Git  ${gitText}`, group?.git?.changes ? "33" : "90"),
    line(`${all.length} ${tools ? t.toolCount : t.skillCount}    ${counts.on} ${tools ? t.installedCount : t.enabledCount}    ${counts.read} ${t.usageCount}    ${tools ? "" : counts.off + " " + t.disabledCount}`, "36"),
    line(`${t.filter}: ${(state.language === "es" ? ["Todo", "Uso observado", "Sin registro", "Activado / instalado", "Desactivado", "Solo archivos"] : filters)[state.filter]}    ${t.search}: ${state.query || "—"}    ${list.length} ${t.results}`, "37"), border("├", "┤"),
    line(inner >= 48 ? fit(t.name, nameWidth) + " " + fit(t.state, statusWidth) + " " + fit(t.thisSession, 17) : t.compactColumns, "90")];
  let foot = [border("├", "┤"),
    line(data.warnings.join(" · ") || (tools ? t.toolNote : t.skillNote), data.warnings.length ? "33" : "90"),
    line(t.noRecordNote, "90"),
    line(state.searching ? t.searchPrompt : t.controls, "36"),
    line(t.scroll, "36"), border("╰", "╯")];
  if (rows < 24) { head = [head[0], head[1], head[2], head[4], head[6], head[8], head[9]]; foot = [foot[0], foot[3], foot[4], foot[5]]; }
  if (rows < 13) { head = head.slice(0, 3); foot = [line(t.smallControls, "36"), border("╰", "╯")]; }
  const page = Math.max(1, rows - head.length - foot.length), end = Math.max(0, body.length - page);
  const offset = Math.max(0, Math.min(state.offset, end));
  const view = body.slice(offset, offset + page);
  while (view.length < page) view.push(line(""));
  return { lines: [...head, ...view, ...foot], offset, end, page };
}

function start() {
  let data = { groups: [], warnings: [] }, selected = 0, offset = 0, filter = 0, query = "", searching = false, busy = false;
  let details = false, initial = true, tab = 0, language = "en";
  const tty = process.stdout.isTTY;
  function draw() {
    selected = Math.min(selected, Math.max(0, data.groups.length - 1));
    const panel = renderPanel(data, { selected, offset, filter, query, searching, busy, details, tab, language }, process.stdout.columns || 110, process.stdout.rows || 36, tty);
    offset = panel.offset;
    process.stdout.write((tty ? "\x1b[H" : "") + panel.lines.join("\n") + (tty ? "\x1b[J" : "\n"));
  }
  async function refresh() {
    if (busy) return;
    busy = true; draw();
    const pane = data.groups[selected]?.pane_id;
    try {
      data = await snapshot();
      const target = pane || (initial ? process.env.HERDR_ACTIVE_PANE_ID : null);
      const i = data.groups.findIndex(g => target ? g.pane_id === target : initial && g.focused);
      if (i >= 0) selected = i;
      initial = false;
    }
    catch (error) { data.warnings = [error.message]; }
    busy = false; draw();
  }
  if (!tty) return snapshot().then(s => { data = s; if (process.argv.includes("--json")) console.log(JSON.stringify(s, null, 2)); else draw(); });
  process.stdout.write("\x1b[?1049h\x1b[?25l");
  const interval = setInterval(refresh, 30000);
  process.stdout.on("resize", draw);
  process.once("exit", () => { clearInterval(interval); if (process.stdin.isTTY) process.stdin.setRawMode(false); process.stdout.write("\x1b[0m\x1b[?25h\x1b[?1049l"); });
  process.once("SIGTERM", () => process.exit(0));
  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true); process.stdin.resume();
    process.stdin.on("keypress", (str, key = {}) => {
      if (key.ctrl && key.name === "c") return process.exit(0);
      if (searching) {
        if (key.name === "escape") { query = ""; searching = false; }
        else if (key.name === "return") searching = false;
        else if (key.name === "backspace") query = [...query].slice(0, -1).join("");
        else if (!key.ctrl && !key.meta && str && !/[\x00-\x1f\x7f]/.test(str)) query += str;
        offset = 0; return draw();
      }
      if (["q", "escape"].includes(key.name)) return process.exit(0);
      if (key.name === "r") return refresh();
      if (key.name === "l") language = language === "en" ? "es" : "en";
      if (str === "/") searching = true;
      if (key.name === "tab") { tab = 1 - tab; offset = 0; filter = 0; query = ""; }
      if (key.name === "d") details = !details;
      if (key.name === "f") { filter = (filter + 1) % filters.length; offset = 0; }
      if (["left", "right"].includes(key.name) && data.groups.length) { selected = (selected + (key.name === "left" ? -1 : 1) + data.groups.length) % data.groups.length; offset = 0; }
      const steps = { up: -1, down: 1, pageup: -10, pagedown: 10 };
      if (key.name in steps) offset += steps[key.name];
      if (key.name === "home") offset = 0;
      if (key.name === "end") offset = Number.MAX_SAFE_INTEGER;
      draw();
    });
  }
  refresh();
}

module.exports = { norm, filesUnder, diskSkills, readsFromRecord, sessionUsage, findSession, filtered, codexSkills, snapshot, clean, findExecutable, installedTools, toolsFromRecord, gitStatus, renderPanel, cellWidth };
if (require.main === module) start();
