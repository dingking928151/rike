#!/usr/bin/env node
/* rike-llm —— 把任意 OpenAI 兼容的本地模型变成「日课」智能体
 *
 * 原理: 内部拉起 rike-mcp.js(拿到 5 个日课工具), 把工具表转成 OpenAI tools,
 *       终端里聊天 → 模型要调工具就转给 MCP → 结果喂回去 → 循环到出话。
 *
 * 零依赖, node 18+(要原生 fetch)。适合 Ollama / LM Studio / vLLM 等本地服务,
 * 模型本身需要支持 function calling(如 qwen3)。
 *
 * 用法: node agent/rike-llm.js --base http://127.0.0.1:11434/v1 --model qwen3:8b
 * 选项: --base   OpenAI 兼容地址(默认 Ollama)
 *       --model  模型名(必填)
 *       --mcp    rike-mcp.js 路径(默认同目录)
 */
"use strict";
const { spawn } = require("child_process");
const readline = require("readline");
const path = require("path");

const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const BASE = argOf("--base", "http://127.0.0.1:11434/v1").replace(/\/+$/, "");
const MODEL = argOf("--model", "");
const MCP = argOf("--mcp", path.join(__dirname, "rike-mcp.js"));
if (!MODEL){
  console.error("用法: node agent/rike-llm.js --base http://127.0.0.1:11434/v1 --model <模型名>");
  process.exit(1);
}

/* ---------- MCP 子进程(rike-mcp.js) ---------- */
const child = spawn(process.execPath, [MCP], { stdio: ["pipe", "pipe", "pipe"] });
child.stderr.on("data", c => process.stderr.write("[mcp] " + c));
let mcpId = 0; const mcpWait = {};
let cbuf = "";
child.stdout.on("data", c => {
  cbuf += c; let i;
  while ((i = cbuf.indexOf("\n")) >= 0){
    const l = cbuf.slice(0, i).trim(); cbuf = cbuf.slice(i + 1);
    if (!l) continue;
    let m; try { m = JSON.parse(l); } catch (e) { continue; }
    if (m.id !== undefined && mcpWait[m.id]){ mcpWait[m.id](m.result); delete mcpWait[m.id]; }
  }
});
function mcp(method, params){
  return new Promise((resolve, reject) => {
    const id = ++mcpId;
    mcpWait[id] = resolve;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: params || {} }) + "\n");
    setTimeout(() => { if (mcpWait[id]){ delete mcpWait[id]; reject(new Error("MCP 超时: " + method)); } }, 30000);
  });
}

/* ---------- OpenAI 兼容补全 ---------- */
async function chat(messages, tools){
  const r = await fetch(BASE + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages, tools, stream: false }),
  });
  if (!r.ok) throw new Error(String(r.status) + " " + String(await r.text().catch(() => "")).slice(0, 160));
  return (await r.json()).choices[0].message;
}

const SYSTEM = "你是学习规划工具「日课」的随身助手。可以调用工具查看用户的日程、专注统计和宠物状态，或代为添加日程、补记专注时长、投喂宠物。回答用中文、简洁友好；涉及用户数据时先调工具查证，不要编造。";

(async () => {
  await mcp("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "rike-llm", version: "1.0.0" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const listed = await mcp("tools/list", {});
  const tools = listed.tools.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }));

  console.log(`[rike-llm] 已就绪: ${MODEL} @ ${BASE} · 挂了 ${tools.length} 个日课工具`);
  console.log("[rike-llm] 直接说话开始 · /tools 看工具 · /clear 清上下文 · Ctrl+C 退出");

  const history = [{ role: "system", content: SYSTEM }];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "你> " });
  rl.prompt();
  rl.on("line", async line => {
    const s = line.trim();
    if (!s){ rl.prompt(); return; }
    if (s === "/exit"){ child.kill(); process.exit(0); }
    if (s === "/clear"){ history.length = 1; console.log("[rike-llm] 上下文已清"); rl.prompt(); return; }
    if (s === "/tools"){ tools.forEach(t => console.log("  " + t.function.name + " — " + t.function.description)); rl.prompt(); return; }
    history.push({ role: "user", content: s });
    try{
      for (let round = 0; round < 6; round++){          /* 最多 6 轮工具循环, 防失控 */
        const msg = await chat(history, tools);
        if (msg.tool_calls && msg.tool_calls.length){
          history.push({ role: "assistant", content: msg.content || "", tool_calls: msg.tool_calls });
          for (const tc of msg.tool_calls){
            const fn = tc.function;
            let args = {}; try { args = JSON.parse(fn.arguments || "{}"); } catch (e) {}
            console.log(`  [调用] ${fn.name}(${JSON.stringify(args)})`);
            const r = await mcp("tools/call", { name: fn.name, arguments: args });
            const text = (r.content || []).map(c => c.text).join("\n") || "(无输出)";
            history.push({ role: "tool", tool_call_id: tc.id, content: text });
          }
          continue;
        }
        console.log("日课> " + (msg.content || ""));
        history.push({ role: "assistant", content: msg.content || "" });
        break;
      }
    }catch(e){ console.log("[rike-llm] 出错: " + e.message); }
    rl.prompt();
  });
  rl.on("close", () => { child.kill(); process.exit(0); });
})();
