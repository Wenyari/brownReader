import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

const executable = process.argv[2];
if (!executable) throw new Error('用法：node tests/run-chapters.mjs <Chromium 路径>');
const profile = await mkdtemp(join(tmpdir(), 'reader-chapters-'));
const browser = spawn(executable, ['--headless', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank']);
let socket;
const deadline = setTimeout(() => browser.kill(), 20000);
try {
  const endpoint = await new Promise((resolve, reject) => {
    let stderr = '';
    browser.on('error', reject);
    browser.on('exit', () => reject(new Error('Chromium 在测试完成前退出')));
    browser.stderr.on('data', (data) => {
      stderr += data;
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) resolve(match[1]);
    });
  });
  socket = new WebSocket(endpoint);
  await once(socket, 'open');
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (!pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });
  socket.addEventListener('close', () => {
    for (const { reject } of pending.values()) reject(new Error('浏览器连接已关闭'));
    pending.clear();
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.navigate', { url: new URL(process.argv[3] || './chapters.html', import.meta.url).href }, sessionId);
  // 按真实完成状态等待，虚拟时间预算可能在 IndexedDB 事务结束前耗尽。
  let output;
  for (let attempt = 0; attempt < 200; attempt++) {
    const { result } = await send('Runtime.evaluate', {
      expression: "JSON.stringify({ title: document.title, text: document.getElementById('result')?.textContent })",
      returnByValue: true,
    }, sessionId);
    output = result.value ? JSON.parse(result.value) : null;
    if (output?.title === 'PASS' || output?.title === 'FAIL') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  console.log(output?.text || '测试未完成');
  if (output?.title !== 'PASS') process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  socket?.close();
  if (browser.exitCode === null && browser.signalCode === null) {
    const exited = once(browser, 'exit');
    browser.kill();
    await exited;
  }
  await rm(profile, { recursive: true, force: true });
}
