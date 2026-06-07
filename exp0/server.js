// exp0 v1 — minimal OrbStack Codex agent manager.
//
// - REST endpoints are thin wrappers over `oa` / `orbctl` (single source of truth).
// - Each agent gets a persistent Codex pty owned by THIS server: kept alive across
//   websocket disconnects, output buffered and replayed on reconnect, so xterm
//   keeps a local scrollback -> smooth VS Code-like scrolling (see v0).

import http from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execFile } from "node:child_process";
import express from "express";
import { WebSocketServer } from "ws";
import pty from "node-pty";

const PORT = process.env.PORT || 7070;
const REPO_DIR = process.env.REPO_DIR || "~/projects/shilo-ai-mono";
const BUFFER_CAP = 8 * 1024 * 1024; // ~8 MB replayable output per session

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OA = path.resolve(__dirname, "..", "oa");

const MACHINE_RE = /^shilo-agent-\d+$/;
const machineFor = (n) => `shilo-agent-${n}`;

// ---- shell helpers ----------------------------------------------------------
function run(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code ?? 1 : 0, stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

// ---- persistent Codex sessions ---------------------------------------------
const sessions = new Map(); // machine -> { term, buffer, clients, carry, working, title }

// Codex signals "working" by prefixing the terminal title (OSC 0/1/2) with a
// braille spinner glyph (U+2800–U+28FF). No spinner -> idle / done.
const OSC_TITLE = /\x1b\][012];([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

function detectStatus(s, data) {
  s.carry += data;
  const matches = [...s.carry.matchAll(OSC_TITLE)];
  if (matches.length) {
    const last = matches[matches.length - 1];
    const title = last[1];
    const first = [...title.trimStart()][0];
    const cp = first ? first.codePointAt(0) : 0;
    const working = cp >= 0x2800 && cp <= 0x28ff;
    s.carry = s.carry.slice(last.index + last[0].length);
    s.title = title;
    if (working !== s.working) {
      s.working = working; // only broadcast on the work/idle transition, not per spinner frame
      broadcastStatus(s);
    }
  }
  if (s.carry.length > 512) s.carry = s.carry.slice(-512); // bound for split seqs
}

function broadcastStatus(s) {
  const msg = JSON.stringify({ type: "status", working: s.working, title: s.title });
  for (const ws of s.clients) if (ws.readyState === ws.OPEN) ws.send(msg);
}

function getSession(machine) {
  let s = sessions.get(machine);
  if (s) return s;

  const inner = `. ~/.asdf/asdf.sh && cd ${REPO_DIR} && exec codex --yolo`;
  const term = pty.spawn("orb", ["-m", machine, "bash", "-lc", inner], {
    name: "xterm-256color",
    cols: 120,
    rows: 30,
    env: { ...process.env, TERM: "xterm-256color" },
  });

  s = { term, buffer: "", clients: new Set(), carry: "", working: false, title: "" };

  term.onData((data) => {
    s.buffer += data;
    if (s.buffer.length > BUFFER_CAP) s.buffer = s.buffer.slice(-BUFFER_CAP);
    detectStatus(s, data);
    // terminal output as binary; control/status frames are sent as text JSON
    const bin = Buffer.from(data, "utf8");
    for (const ws of s.clients) if (ws.readyState === ws.OPEN) ws.send(bin);
  });

  term.onExit(({ exitCode }) => {
    console.log(`[pty:${machine}] exit ${exitCode}`);
    for (const ws of s.clients) if (ws.readyState === ws.OPEN) ws.close();
    sessions.delete(machine);
  });

  sessions.set(machine, s);
  console.log(`[pty:${machine}] spawned codex`);
  return s;
}

function killSession(machine) {
  const s = sessions.get(machine);
  if (!s) return false;
  s.term.kill();
  sessions.delete(machine);
  return true;
}

// ---- REST -------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// list agents (number, VM state, whether a codex session is alive)
app.get("/api/agents", async (_req, res) => {
  const { code, stdout, stderr } = await run("orbctl", ["list", "-f", "json"]);
  if (code !== 0) return res.status(500).json({ error: stderr || "orbctl failed" });
  let list;
  try {
    list = JSON.parse(stdout);
  } catch {
    return res.status(500).json({ error: "bad orbctl json" });
  }
  const agents = list
    .map((x) => {
      const m = /^shilo-agent-(\d+)$/.exec(x.name);
      if (!m) return null;
      const s = sessions.get(x.name);
      return { n: Number(m[1]), name: x.name, state: x.state, codex: !!s, working: s ? s.working : false };
    })
    .filter(Boolean)
    .sort((a, b) => a.n - b.n);
  res.json(agents);
});

// create a new agent (clone base -> next free number, start it)
app.post("/api/agents", async (_req, res) => {
  const { code, stdout, stderr } = await run(OA, ["new"]);
  if (code !== 0) return res.status(500).json({ error: stderr || stdout });
  res.json({ ok: true, output: stdout });
});

// agent number routes
const num = (req, res) => {
  const n = req.params.n;
  if (!/^\d+$/.test(n)) {
    res.status(400).json({ error: "agent must be a number" });
    return null;
  }
  return n;
};

app.post("/api/agents/:n/start", async (req, res) => {
  const n = num(req, res);
  if (n === null) return;
  const { code, stdout, stderr } = await run(OA, ["start", n]);
  if (code !== 0) return res.status(500).json({ error: stderr || stdout });
  res.json({ ok: true });
});

app.post("/api/agents/:n/stop", async (req, res) => {
  const n = num(req, res);
  if (n === null) return;
  killSession(machineFor(n)); // drop codex pty before stopping the VM
  const { code, stdout, stderr } = await run(OA, ["stop", n]);
  if (code !== 0) return res.status(500).json({ error: stderr || stdout });
  res.json({ ok: true });
});

// delete the VM (bypass oa's interactive confirm)
app.delete("/api/agents/:n", async (req, res) => {
  const n = num(req, res);
  if (n === null) return;
  const machine = machineFor(n);
  killSession(machine);
  await run("orbctl", ["stop", machine]);
  const { code, stdout, stderr } = await run("orbctl", ["delete", machine]);
  if (code !== 0) return res.status(500).json({ error: stderr || stdout });
  res.json({ ok: true });
});

// stop just the codex session (VM keeps running)
app.post("/api/agents/:n/codex/stop", (req, res) => {
  const n = num(req, res);
  if (n === null) return;
  const killed = killSession(machineFor(n));
  res.json({ ok: true, killed });
});

// ---- websocket terminal -----------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/term" });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const machine = url.searchParams.get("machine") || "";
  if (!MACHINE_RE.test(machine)) {
    ws.close(1008, "invalid machine");
    return;
  }

  const s = getSession(machine);
  s.clients.add(ws);
  console.log(`[ws] ${machine} connected (${s.clients.size} client(s))`);

  if (s.buffer && ws.readyState === ws.OPEN) ws.send(Buffer.from(s.buffer, "utf8"));
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type: "status", working: s.working, title: s.title }));
  }

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === "input") s.term.write(msg.data);
    else if (msg.type === "resize") s.term.resize(msg.cols, msg.rows);
  });

  ws.on("close", () => {
    s.clients.delete(ws);
    console.log(`[ws] ${machine} disconnected (pty alive, ${s.clients.size} left)`);
  });
});

server.listen(PORT, () => {
  console.log(`exp0 v1 on http://localhost:${PORT}`);
});
