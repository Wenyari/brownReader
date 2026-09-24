const element = (id) => document.getElementById(id);
let currentBook = null;
let tabId = null;
let busy = false;

const status = (text, error = false) => {
  element('status').textContent = text;
  element('status').className = error ? 'error' : '';
};
const request = async (action, data) => {
  const response = await chrome.runtime.sendMessage({ action, data });
  if (!response || response.status !== 'success') throw new Error(response?.error || '插件通信失败');
  return response.data;
};
const controls = () => {
  for (const id of ['mySelect', 'readingProgress', 'selectElementBtn']) element(id).disabled = busy || !currentBook;
  element('importBtn').disabled = busy;
  element('chapterSelect').disabled = busy || !currentBook?.chapters?.length;
};
const showBook = (book) => {
  currentBook = book;
  element('readingProgress').value = book ? (100 * book.position / Math.max(1, book.content.length)).toFixed(2) : '';
  if (book) element('mySelect').value = String(book.id);
  const chapters = Array.isArray(book?.chapters) ? book.chapters : [];
  const select = element('chapterSelect');
  select.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = chapters.length ? '选择章节' : book && !Array.isArray(book.chapters) ? '重新导入以生成目录' : '暂无可用章节';
  select.appendChild(placeholder);
  let selected = '';
  let nearest = -1;
  chapters.forEach((chapter, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = `${'　'.repeat(Math.min(chapter.level, 6))}${chapter.title}`;
    select.appendChild(option);
    // EPUB 目录保留层级顺序，当前章节按正文位置确定。
    if (chapter.position <= book.position && chapter.position >= nearest) {
      nearest = chapter.position;
      selected = String(index);
    }
  });
  select.value = selected;
  controls();
};
const run = async (operation) => {
  if (busy) return;
  busy = true;
  controls();
  try { await operation(); }
  catch (error) { status(error.message, true); }
  finally { busy = false; controls(); }
};

const ensurePage = async () => {
  if (tabId === null) throw new Error('没有可用的网页标签页');
  const tab = await chrome.tabs.get(tabId);
  if (!/^https?:\/\//i.test(tab.url || '')) throw new Error('请在普通 HTTP/HTTPS 网页使用，浏览器内部页面不支持');
  let response;
  try {
    response = await chrome.tabs.sendMessage(tabId, { action: 'PING' });
  } catch (_) {
    // 插件重载后，已打开的网页可能尚未加载内容脚本。
  }
  if (response?.status === 'success') {
    if (response.pickerVersion !== 8) throw new Error('此网页仍在使用旧版选择器，请刷新网页后重试');
    return;
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/content.js'] });
  } catch (_) {
    throw new Error('此页面不允许插件访问，请换一个普通网页或检查网站访问权限');
  }
};
const syncBook = async () => {
  await ensurePage();
  const response = await chrome.tabs.sendMessage(tabId, { action: 'FROM_POPUP', data: currentBook });
  if (response?.status !== 'success') throw new Error('页面通信失败，请刷新网页重试');
};
const refreshBooks = async () => {
  const books = await request('fetchDataFromIndexedDB');
  element('mySelect').replaceChildren();
  for (const book of books) {
    const option = document.createElement('option');
    option.value = String(book.id);
    option.textContent = book.name;
    element('mySelect').appendChild(option);
  }
  let book = await request('getCurrentBook');
  if (!book && books.length) book = await request('updateId', books[0].id);
  showBook(book);
};

element('importBtn').addEventListener('click', () => element('fileInput').click());
element('fileInput').addEventListener('change', () => run(async () => {
  const file = element('fileInput').files?.[0];
  element('fileInput').value = '';
  if (!file) return;
  const isEpub = /\.epub$/i.test(file.name);
  if (!isEpub && !/\.txt$/i.test(file.name)) throw new Error('仅支持 TXT 或 EPUB 文件');
  if (isEpub && file.size > brownReaderEpub.MAX_FILE_BYTES) throw new Error('EPUB 文件不能超过 50 MB');
  status(isEpub ? '正在解析 EPUB，请保持弹窗打开…' : '正在导入 TXT…');
  const bytes = await file.arrayBuffer();
  let content;
  let chapters;
  if (isEpub) {
    ({ content, chapters } = await brownReaderEpub.read(bytes));
  } else {
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch (_) { content = new TextDecoder('gbk').decode(bytes); }
    chapters = brownReaderTxt.readChapters(content);
  }
  if (!content.trim()) throw new Error('文件为空，请选择有正文的小说');
  await request('saveToDB', { content, chapters, name: file.name });
  await refreshBooks();
  status('已导入，请点击「选择网页元素」');
  await syncBook();
}));
element('mySelect').addEventListener('change', () => run(async () => {
  showBook(await request('updateId', Number(element('mySelect').value)));
  status('已切换小说');
  await syncBook();
}));
element('readingProgress').addEventListener('change', () => run(async () => {
  if (!currentBook) throw new Error('请先导入小说');
  // 空输入不转换为 0；按比例跳转后仍以正文偏移量持久化。
  const text = element('readingProgress').value.trim();
  const progress = text === '' ? null : Number(text);
  if (typeof progress !== 'number' || !Number.isFinite(progress) || progress < 0 || progress > 100) throw new Error('阅读进度必须是 0 到 100 之间的数字');
  const position = Math.floor(currentBook.content.length * progress / 100);
  showBook(await request('updatePosition', { id: currentBook.id, position }));
  status('阅读位置已保存');
  await syncBook();
}));
element('chapterSelect').addEventListener('change', () => run(async () => {
  const value = element('chapterSelect').value;
  // 空选项不转换为第 0 章；索引与目标位置均须通过类型检查。
  const index = typeof value === 'string' && value.trim() !== '' ? Number(value) : null;
  if (index === null) return;
  const chapter = Number.isSafeInteger(index) && index >= 0 ? currentBook?.chapters?.[index] : null;
  if (!chapter || !Number.isSafeInteger(chapter.position)) throw new Error('章节位置无效，请重新导入');
  showBook(await request('updatePosition', { id: currentBook.id, position: chapter.position }));
  status(`已跳转至：${chapter.title}`);
  await syncBook();
}));
element('selectElementBtn').addEventListener('click', () => run(async () => {
  await ensurePage();
  const response = await chrome.tabs.sendMessage(tabId, { action: 'START_SELECTION' });
  if (response?.status !== 'success' || response.active !== true) throw new Error(response?.error || '选择模式未成功启动，请刷新网页重试');
  // 确认页面已挂载选择界面，再关闭弹窗，避免出现无反馈的启动。
  const state = await chrome.tabs.sendMessage(tabId, { action: 'SELECTION_STATUS' });
  if (state?.status !== 'success' || state.active !== true) throw new Error('选择界面未就绪，请刷新网页重试');
  window.close();
}));
run(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? null;
  await refreshBooks();
  status(currentBook ? '点击「选择网页元素」开始阅读' : '请先导入 TXT 或 EPUB 小说');
});
