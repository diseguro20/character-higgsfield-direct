const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'character-browser-'));
const server = net.createServer();
server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  server.close();
  const child = spawn(edge, ['--headless=new', '--no-first-run', '--disable-gpu', '--disable-background-networking',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let ws;
  try {
    let pages;
    for (let i = 0; i < 40; i++) {
      try { pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    const page = pages?.find(item => item.type === 'page');
    if (!page) throw new Error('Edge debugging page unavailable');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let id = 0;
    const pending = new Map();
    const errors = [];
    ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
      if (message.method === 'Runtime.exceptionThrown') errors.push(`JS: ${message.params.exceptionDetails.text}: ${message.params.exceptionDetails.exception?.description || ''}`);
      if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') errors.push(`Log: ${message.params.entry.text}`);
      if (message.method === 'Network.loadingFailed') errors.push(`Network: ${message.params.errorText}`);
      if (message.method === 'Network.responseReceived' && (message.params.type === 'Script' || message.params.type === 'Stylesheet') && /text\/html/.test(message.params.response.mimeType)) errors.push(`HTML asset: ${message.params.response.url} HTTP ${message.params.response.status}`);
    };
    const send = (method, params = {}) => new Promise(resolve => {
      const messageId = ++id; pending.set(messageId, resolve);
      ws.send(JSON.stringify({ id: messageId, method, params }));
    });
    await send('Runtime.enable'); await send('Log.enable'); await send('Network.enable'); await send('Page.enable');
    await send('Page.navigate', { url: process.argv[2] || 'https://character-higgsfield-direct.vercel.app/app/' });
    await new Promise(resolve => setTimeout(resolve, 7000));
    const state = await send('Runtime.evaluate', { expression: 'JSON.stringify({title:document.title,appLength:document.querySelector("#app")?.innerHTML.length,body:document.body.innerText.slice(0,200)})', returnByValue: true });
    console.log('State:', state.result?.result?.value);
    for (const error of errors.slice(0, 12)) console.log(error.slice(0, 1000));
    if (!JSON.parse(state.result?.result?.value || '{}').appLength || errors.some(error => error.startsWith('HTML asset:') || error.startsWith('JS:'))) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { ws?.close(); child.kill(); }
});
