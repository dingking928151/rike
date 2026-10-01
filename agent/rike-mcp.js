#!/usr/bin/env node
/* rike MCP 服务器 —— 日课 ↔ PC AI 智能体 本地桥
 *
 * 两个通道, 同一进程:
 *   stdio  MCP JSON-RPC(按行分隔) —— Claude Code / kimi 等智能体挂载
 *   HTTP   http://127.0.0.1:7676  —— 浏览器里的日课页面同步通道
 *          POST /sync {db, results:[{id,text}]} → {ops:[{id,tool,args}]}
 *
 * 零依赖, node 16+。只监听本机回环, 数据不出本机。
 * 用法: node rike-mcp.js [--port 7676] [--lan [--lan-port 7777] [--page <index.html 路径>]]
 *   --lan  再开一个局域网 hub(0.0.0.0): 手机浏览器打开 http://<本机IP>:<lan-port>
 *          即用同一份数据; 首次连接输入控制台打印的 6 位配对码
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const PORT = (() => {
  const i = process.argv.indexOf("--port");
  return i > 0 && +process.argv[i + 1] ? +process.argv[i + 1] : 7676;
})();
const SNAP = path.join(__dirname, "snapshot.json");
const LAN = process.argv.includes("--lan");
const LAN_PORT = (() => {
  const i = process.argv.indexOf("--lan-port");
  return i > 0 && +process.argv[i + 1] ? +process.argv[i + 1] : 7777;
})();
const PAGE = (() => {
  const i = process.argv.indexOf("--page");
  return path.resolve(i > 0 && process.argv[i + 1] ? process.argv[i + 1] : path.join(__dirname, "..", "index.html"));
})();

let db = null;        // 最新页面数据快照
let lastSeen = 0;     // 页面最后心跳时间
let ops = [];         // 待下发给页面的操作
const waiters = {};   // 工具调用 id -> {resolve, timer}(等页面回执)

const text = t => ({ content: [{ type: "text", text: String(t) }] });
const errText = t => ({ content: [{ type: "text", text: String(t) }], isError: true });

/* ---------- 纯函数摘要(语义与页面 occursOn/isDone 对齐) ---------- */
const dstr = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const pday = ds => new Date(ds + "T00:00").getDay();
function occursOn(t, ds){
  if (t.rep === "d") return ds >= t.date;
  if (t.rep === "w") return ds >= t.date && pday(ds) === pday(t.date);
  return t.date === ds;
}
const isDone = (t, ds) => t.rep ? !!(t.doneOn && t.doneOn[ds]) : !!t.done;
const fmtDur = s => { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.round(s % 3600 / 60); return h ? `${h}小时${m ? m + "分" : ""}` : `${m}分钟`; };
const fmtDurH = s => (s / 3600).toFixed(1);
function streak(dbk){
  const days = new Set((dbk.sessions || []).map(s => s.date));
  let n = 0; const d = new Date();
  if (!days.has(dstr(d))) d.setDate(d.getDate() - 1);
  while (days.has(dstr(d))){ n++; d.setDate(d.getDate() - 1); }
  return n;
}
function petOf(dbk){
  const p = dbk.pet || {};
  const tot = (dbk.sessions || []).reduce((a, x) => a + (x.sec || 0), 0);
  const growth = typeof p.growth === "number" ? p.growth : tot;   /* 旧数据无 growth → 累计专注 */
  const st = p.custom ? 2 : growth < 2 * 3600 ? 0 : growth < 20 * 3600 ? 1 : 2;
  let s = `宠物「${p.name || "小家伙"}」（${st === 0 ? "蛋" : st === 1 ? "幼年" : "成年"}）`
        + ` 存粮 ${p.food || 0} 颗 · 饱食 ${p.hunger || 0} · 心情 ${p.mood || 0}`;
  if (st === 0) s += ` · 成长 ${fmtDurH(growth)}h / 2h 孵化`;
  else if (st === 1) s += ` · 成长 ${fmtDurH(growth)}h / 20h 长大`;
  if ((p.starve || 0) > 0){
    const limRaw = +((dbk.settings || {}).petStarve);
    const lim = Number.isFinite(limRaw) ? Math.max(0, Math.min(30, Math.round(limRaw))) : 3;
    s += ` · 已挨饿 ${p.starve} 天` + (lim > 0 && !p.custom && st > 0 ? `（满 ${lim} 天退化）` : "");
  }
  return s;
}
function summarize(dbk){
  const today = dstr(new Date());
  const ts = (dbk.tasks || []).filter(t => occursOn(t, today));
  const lines = [`日期 ${today}`, `今日日程 ${ts.length} 项:`];
  ts.slice(0, 20).forEach(t => lines.push(
    `  ${isDone(t, today) ? "[x]" : "[ ]"} ${t.start || "随时"}${t.end ? "-" + t.end : ""} ${t.title}${t.pri === 0 ? " !高" : t.pri === 1 ? " !中" : ""}`));
  if (!ts.length) lines.push("  （无）");
  const sec = (dbk.sessions || []).filter(s => s.date === today).reduce((a, x) => a + (x.sec || 0), 0);
  lines.push(`今日专注 ${fmtDur(sec)} · 连续打卡 ${streak(dbk)} 天`);
  lines.push(petOf(dbk));
  return lines.join("\n");
}
function statsOf(dbk){
  const days = [];
  for (let i = 6; i >= 0; i--){ const d = new Date(); d.setDate(d.getDate() - i); days.push(dstr(d)); }
  const per = days.map(ds => (dbk.sessions || []).filter(s => s.date === ds).reduce((a, x) => a + (x.sec || 0), 0));
  const out = ["最近 7 天:"];
  days.forEach((ds, i) => out.push(`  周${"日一二三四五六"[pday(ds)]} ${ds.slice(5)}  ${per[i] ? fmtDur(per[i]) : "—"}`));
  const tot = per.reduce((a, b) => a + b, 0);
  out.push(`合计 ${fmtDurH(tot)}h · 日均 ${fmtDurH(tot / 7)}h · 连续打卡 ${streak(dbk)} 天`);
  const cats = (dbk.settings && dbk.settings.cats) || [];
  const perCat = cats.map((c, i) => ({ c, sec: (dbk.sessions || []).filter(s => days.includes(s.date) && s.cat === i).reduce((a, x) => a + (x.sec || 0), 0) }))
    .filter(x => x.sec > 0).sort((a, b) => b.sec - a.sec);
  if (perCat.length){
    out.push("科目分布: " + perCat.map(x => `${x.c} ${fmtDurH(x.sec)}h`).join(" · "));
  }
  const occ = days.flatMap(ds => (dbk.tasks || []).filter(t => occursOn(t, ds)));
  const done = occ.filter(t => isDone(t, ds0(t, days))).length;
  out.push(`7 天日程完成: ${done}/${occ.length}`);
  return out.join("\n");
}
function ds0(t, days){ /* isDone 需要日期: 重复任务取今天, 普通任务取其自身日期 */
  return t.rep ? dstr(new Date()) : t.date || days[6];
}

/* ---------- 工具表 ---------- */
const TOOLS = [
  { name: "rike_status", description: "日课当前状态：今日日程清单、今日专注时长、连续打卡天数、宠物状态",
    inputSchema: { type: "object", properties: {} } },
  { name: "rike_stats", description: "日课最近 7 天统计：每日时长、科目分布、完成率",
    inputSchema: { type: "object", properties: {} } },
  { name: "rike_add_task", description: "往日课添加一条日程。text 走应用速记语法（如「19:00-20:30 GCN论文精读 #算法 !高 @每周」）。需要日课页面在浏览器里开着",
    inputSchema: { type: "object", properties: { text: { type: "string", description: "速记文本" } }, required: ["text"] } },
  { name: "rike_log_session", description: "补记一段专注时长（会喂宠物获得粮）。需要日课页面在浏览器里开着",
    inputSchema: { type: "object", properties: { minutes: { type: "number", description: "分钟数 1-600" }, subject: { type: "string", description: "做了什么(可选)" } }, required: ["minutes"] } },
  { name: "rike_pet", description: "查看宠物状态；feed=true 时喂一颗存粮（需要页面开着）",
    inputSchema: { type: "object", properties: { feed: { type: "boolean" } } } },
];

function callTool(name, args){
  return new Promise(resolve => {
    if (name === "rike_status" || name === "rike_stats"){
      if (!db) return resolve(text("还没有页面快照——在浏览器里打开日课页面，等两秒再试"));
      return resolve(text(name === "rike_status" ? summarize(db) : statsOf(db)));
    }
    if (name === "rike_pet" && !args.feed){
      if (!db) return resolve(text("还没有页面快照——在浏览器里打开日课页面，等两秒再试"));
      return resolve(text(petOf(db) + "\n（feed=true 可喂食）"));
    }
    /* 需要页面执行的动作: 入队, 等页面回执 */
    if (Date.now() - lastSeen > 15000)
      return resolve(errText("日课页面不在线（15 秒内没有心跳）——在浏览器里打开日课页面再试"));
    const map = { rike_add_task: "add_task", rike_log_session: "log_session", rike_pet: "feed_pet" };
    const id = "op" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    ops.push({ id, tool: map[name] || name, args });
    waiters[id] = { resolve, timer: setTimeout(() => {
      delete waiters[id];
      resolve(errText("页面 20 秒内没有回执——日课页面开着吗？"));
    }, 20000) };
  });
}

/* ---------- HTTP 桥(页面 ↔ 服务器) ---------- */
const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  /* Chrome 专用网络访问(PNA): https/file 页面访问 127.0.0.1 的预检必须带这个头 */
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  if (req.method === "OPTIONS"){ res.writeHead(204); return res.end(); }
  if (req.method === "GET"){
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ server: "rike-agent", port: PORT, pageOnline: Date.now() - lastSeen < 15000 }));
  }
  let body = "";
  req.on("data", c => body += c);
  req.on("end", () => {
    try {
      const j = JSON.parse(body || "{}");
      (j.results || []).forEach(r => {
        const w = waiters[r.id];
        if (w){ clearTimeout(w.timer); delete waiters[r.id]; w.resolve(text(r.text)); }
      });
      if (j.db){
        if (!db || (j.db.savedAt || 0) >= (db.savedAt || 0)){   /* 旧心跳不把库拉回旧版 */
          db = j.db;
          try { fs.writeFileSync(SNAP, JSON.stringify({ at: lastSeen, db })); } catch (e) {}
        }
        lastSeen = Date.now();
      }
      const out = { ops: ops.slice(0, 8) };
      ops = ops.slice(8);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out));
    } catch (e){ res.writeHead(400); res.end("{}"); }
  });
});
server.listen(PORT, "127.0.0.1", () => console.error(`[rike-agent] 桥已就绪 http://127.0.0.1:${PORT} (MCP 走 stdio)`));
server.on("error", e => console.error(`[rike-agent] 端口 ${PORT} 监听失败: ${e.code}`));

/* 启动时恢复上次快照(只服务读类工具, 动作仍需页面在线) */
try { db = JSON.parse(fs.readFileSync(SNAP, "utf8")).db; } catch (e) {}

/* ---------- 局域网 hub(--lan): 手机/电脑同一份数据 ----------
 * 页面由 hub 同源伺服(无 CORS); 整库 LWW: savedAt 新者胜, 落库同时镜像给
 * MCP 侧(db + 快照), 手机上加的任务智能体立刻看得见。 */
if (LAN) {
  const ROOT = path.dirname(PAGE);
  const STATIC = {
    "/": [PAGE, "text/html; charset=utf-8"],
    "/index.html": [PAGE, "text/html; charset=utf-8"],
    "/sw.js": [path.join(ROOT, "sw.js"), "text/javascript"],
    "/manifest.webmanifest": [path.join(ROOT, "manifest.webmanifest"), "application/manifest+json"],
    "/icon-192.png": [path.join(ROOT, "icon-192.png"), "image/png"],
    "/icon-512.png": [path.join(ROOT, "icon-512.png"), "image/png"],
    "/icon-maskable-512.png": [path.join(ROOT, "icon-maskable-512.png"), "image/png"],
    "/apple-touch-icon.png": [path.join(ROOT, "apple-touch-icon.png"), "image/png"],
  };
  let hubDb = db, hubSavedAt = (db && db.savedAt) || 0;   // 以恢复的快照起底
  const pairCode = String(Math.floor(100000 + Math.random() * 900000));
  const hubTokens = new Set();

  function hubAdopt(newDb, at){
    hubDb = newDb; hubSavedAt = at;
    db = newDb; lastSeen = Date.now();                     // 镜像给 MCP 侧
    try { fs.writeFileSync(SNAP, JSON.stringify({ at: lastSeen, db })); } catch (e) {}
  }
  function readBody(req, cap, cb){
    let body = "", over = false;
    req.on("data", c => { body += c; if (body.length > cap){ over = true; req.destroy(); } });
    req.on("end", () => { if (over) return cb(null); try { cb(JSON.parse(body || "{}")); } catch (e) { cb(null); } });
  }

  const hub = http.createServer((req, res) => {
    const u = req.url.split("?")[0];
    if (req.method === "GET"){
      const st = STATIC[u];
      if (st && fs.existsSync(st[0])){
        res.writeHead(200, { "Content-Type": st[1], "Cache-Control": "no-cache" });
        return res.end(fs.readFileSync(st[0]));
      }
      if (u === "/hub/info"){ res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ server: "rike-hub", v: 1 })); }
      res.writeHead(404); return res.end();
    }
    if (req.method !== "POST"){ res.writeHead(405); return res.end(); }
    readBody(req, 4 << 20, j => {
      if (!j){ res.writeHead(400); return res.end(); }
      if (u === "/hub/hello"){
        if (String(j.code || "").trim() !== pairCode){ res.writeHead(403); return res.end("{}"); }
        const token = crypto.randomBytes(16).toString("hex");
        hubTokens.add(token);
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ token }));
      }
      if (u === "/hub/sync"){
        if (!hubTokens.has(j.token)){ res.writeHead(403); return res.end("{}"); }
        if ((j.savedAt || 0) > hubSavedAt && j.db && Array.isArray(j.db.tasks) && Array.isArray(j.db.sessions))
          hubAdopt(j.db, j.savedAt);
        const out = hubSavedAt > (j.savedAt || 0) && hubDb ? { db: hubDb } : { ok: 1 };
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify(out));
      }
      res.writeHead(404); return res.end();
    });
  });
  hub.listen(LAN_PORT, "0.0.0.0", () => {
    const all = Object.values(os.networkInterfaces()).flat()
      .filter(x => x && x.family === "IPv4" && !x.internal).map(x => x.address);
    const ips = all.filter(ip => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip));   // 只要真实局域网段
    const list = ips.length ? ips : all;
    console.error(`[rike-agent] 局域网 hub 已开启 (整库 LWW · 手机/电脑同一份数据)`);
    list.forEach((ip, i) => console.error(`[rike-agent]   ${i ? "  或" : "手机浏览器打开"}: http://${ip}:${LAN_PORT}`));
    console.error(`[rike-agent]   配对码: ${pairCode} (手机首次连接时输入, 重启进程会换)`);
    console.error(`[rike-agent]   手机打不开? → Windows 防火墙允许 Node.js 在「专用网络」通过`);
  });
  hub.on("error", e => console.error(`[rike-agent] hub 端口 ${LAN_PORT} 监听失败: ${e.code}`));
}

/* ---------- stdio: MCP ---------- */
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", c => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\n")) >= 0){
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch (e) { continue; }
    if (m.id === undefined) continue; /* notification 不回包 */
    if (m.method === "initialize")
      reply(m.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "rike-agent", version: "1.0.0" } });
    else if (m.method === "ping") reply(m.id, {});
    else if (m.method === "tools/list") reply(m.id, { tools: TOOLS });
    else if (m.method === "tools/call")
      callTool(m.params.name, m.params.arguments || {})
        .then(r => reply(m.id, r))
        .catch(e => reply(m.id, { content: [{ type: "text", text: e.message }], isError: true }));
    else reply(m.id, {});
  }
});
function reply(id, result){ process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"); }
process.stdin.on("end", () => process.exit(0));
