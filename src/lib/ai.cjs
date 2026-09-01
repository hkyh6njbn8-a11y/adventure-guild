// ai.cjs — 冒险公会：AI 模型调用封装（内置 AI 项目管理核心库）
// 职责：调用外部 LLM API（OpenAI 兼容格式，默认火山方舟），供「总指挥 AI」和「工人 AI」使用。
// 设计：不引入额外依赖，用 Node 原生 https/http 发起请求；Key 从配置读取，不硬编码。
// 用法：const ai = require('./lib/ai.cjs');
//       const text = await ai.chat([{role:'user', content:'...'}], {model});
//       const json = await ai.chatJson([{role:'user', content:'...'}]);

const https = require('https');
const http = require('http');
const cfg = require('./config.cjs');

// 从配置取 AI 设置（用户可在 config.json 的 ai 段覆盖）
function aiConfig() {
  return cfg.ai || {};
}

function isHttps(url) {
  return /^https:\/\//i.test(url);
}

// 单次对话补全，返回回复文本
// messages: [{role, content}...]；opts: { model?, maxTokens?, temperature?, timeoutMs? }
function chat(messages, opts = {}) {
  return chatMessage(messages, opts).then(m => String(m.content || '').trim());
}

// 单次对话补全，返回完整 message（含 tool_calls，支持函数调用）
// 返回: { role:'assistant', content, toolCalls: [{id, name, arguments}] | null }
function chatMessage(messages, opts = {}) {
  const a = aiConfig();
  const baseUrl = (a.baseUrl || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/+$/, '');
  const apiKey = a.apiKey || '';
  if (!apiKey) return Promise.reject(new Error('未配置 AI API Key（请在设置页或 config.json 的 ai.apiKey 填写）'));
  const model = opts.model || a.directorModel || a.model || 'doubao-seed-1-6-250615';
  const maxTokens = opts.maxTokens || 1200;
  const temperature = opts.temperature !== undefined ? opts.temperature : 0.4;
  const timeoutMs = opts.timeoutMs || 90000;

  // 解析 baseUrl，拼出 /chat/completions 路径（保持用户配置的路径原样，仅补 /chat/completions）
  let url;
  try { url = new URL(baseUrl); } catch (e) { return Promise.reject(new Error('baseUrl 配置无效: ' + baseUrl)); }
  let path = url.pathname.replace(/\/+$/, '');
  if (!/chat\/completions$/.test(path)) path = path + '/chat/completions';

  const payload = {
    model,
    messages,
    max_tokens: maxTokens,
    temperature,
    stream: false
  };
  if (opts.tools && opts.tools.length) payload.tools = opts.tools;
  if (opts.toolChoice) payload.tool_choice = opts.toolChoice;

  const body = JSON.stringify(payload);

  const transport = isHttps(baseUrl) ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request({
      host: url.hostname,
      port: url.port || (isHttps(baseUrl) ? 443 : 80),
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const j = JSON.parse(data);
            const msg = j.choices && j.choices[0] && j.choices[0].message;
            if (!msg) return reject(new Error('LLM 返回为空'));
            // 解析工具调用
            let toolCalls = null;
            if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
              toolCalls = msg.tool_calls.map(tc => ({
                id: tc.id || ('call-' + Math.random().toString(36).slice(2, 8)),
                name: tc.function && tc.function.name || '',
                arguments: tc.function && tc.function.arguments || '{}'
              }));
            }
            resolve({ role: 'assistant', content: String(msg.content || '').trim(), toolCalls });
          } catch (e) {
            reject(new Error('LLM 响应解析失败: ' + e.message + ' | ' + data.slice(0, 300)));
          }
        } else {
          let msg = data.slice(0, 400);
          try { const j = JSON.parse(data); msg = (j.error && (j.error.message || j.error.code)) || msg; } catch (e) {}
          reject(new Error('LLM API 错误 (' + res.statusCode + '): ' + msg));
        }
      });
    });
    req.on('error', e => reject(new Error('LLM 请求失败: ' + e.message)));
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('LLM 请求超时 (' + timeoutMs + 'ms)')); });
    req.write(body);
    req.end();
  });
}

// 从 LLM 输出中提取 JSON（容错：去掉 ```json 代码块包裹、前后噪音、取第一个 [ 或 { 到结尾）
function extractJson(text) {
  if (!text) return null;
  let s = text.trim();
  // 去掉 markdown 代码块
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  s = s.trim();
  // 去掉首尾非 JSON 噪音（LLM 常夹带说明文字）
  const first = s.search(/[[{]/);
  if (first === -1) return null;
  s = s.slice(first);
  // 从后往前找平衡的结束
  let depth = 0, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') { depth--; if (depth === 0) { s = s.slice(0, i + 1); break; } }
  }
  try { return JSON.parse(s); } catch (e) { return null; }
}

// 对话并解析 JSON（适合拆解任务等结构化输出）
async function chatJson(messages, opts = {}) {
  const text = await chat(messages, opts);
  const json = extractJson(text);
  if (json === null) throw new Error('LLM 未返回可解析的 JSON：' + text.slice(0, 300));
  return json;
}

module.exports = { chat, chatMessage, chatJson, extractJson, aiConfig };
