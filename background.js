const openDB = (name, storeName, keyPath, autoIncrement = false) => new Promise((resolve, reject) => {
  const request = indexedDB.open(name, 1);
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(storeName)) {
      request.result.createObjectStore(storeName, { keyPath, autoIncrement });
    }
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const transact = async (database, storeName, mode, operation) => {
  const db = await database;
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      let result;
      // 等事务提交成功再返回，避免导入后立即读取时拿到旧数据。
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error || new Error('数据库操作失败'));
      transaction.onabort = () => reject(transaction.error || new Error('数据库事务取消'));
      operation(transaction.objectStore(storeName), (value) => { result = value; });
    });
  } finally {
    db.close();
  }
};

const files = (mode, operation) => transact(openDB('FileDB', 'files', 'id', true), 'files', mode, operation);
const selection = (mode, operation) => transact(openDB('myDatabase', 'idStore', 'id'), 'idStore', mode, operation);
const getId = () => selection('readonly', (store, done) => {
  store.get('unique').onsuccess = (event) => done(event.target.result?.value ?? null);
});
const setId = (id) => selection('readwrite', (store) => store.put({ id: 'unique', value: id }));
// 旧页码只用于一次性迁移，之后始终保存正文中的绝对偏移量。
const normalizeOffset = (content, offset) => {
  let value = Math.min(Math.max(0, offset), Math.max(0, content.length - 1));
  const code = content.charCodeAt(value);
  if (value > 0 && code >= 0xdc00 && code <= 0xdfff) value--;
  return value;
};
const getBook = (id) => files('readwrite', (store, done) => {
  store.get(Number(id)).onsuccess = (event) => {
    const book = event.target.result;
    if (book && !Number.isSafeInteger(book.position)) {
      const size = Number.isSafeInteger(book.pageSize) && book.pageSize > 0 ? book.pageSize : 20;
      const page = Number.isSafeInteger(book.pageNum) && book.pageNum >= 0 ? book.pageNum : 0;
      book.position = normalizeOffset(book.content, page * size);
      delete book.pageNum;
      delete book.pageSize;
      store.put(book);
    }
    done(book ?? null);
  };
});

const handleMessage = async (request) => {
  switch (request.action) {
    case 'fetchDataFromIndexedDB':
      return files('readonly', (store, done) => {
        store.getAll().onsuccess = (event) => done(event.target.result);
      });
    case 'getId':
      return getId();
    case 'getCurrentBook': {
      const id = await getId();
      return id === null ? null : getBook(id);
    }
    case 'saveToDB': {
      const { content, name, chapters: inputChapters } = request.data || {};
      if (typeof content !== 'string' || !content.trim() || typeof name !== 'string' || !name.trim()) throw new Error('文件内容或名称无效');
      // 目录允许为空，但不接受非数组或超出正文的章节位置。
      const chapters = inputChapters == null ? [] : inputChapters;
      if (!Array.isArray(chapters) || chapters.some((chapter) => !chapter ||
        typeof chapter.title !== 'string' || !chapter.title.trim() ||
        !Number.isSafeInteger(chapter.position) || chapter.position < 0 || chapter.position >= content.length ||
        !Number.isSafeInteger(chapter.level) || chapter.level < 0)) throw new Error('章节目录无效');
      const id = await files('readwrite', (store, done) => {
        store.add({ content, name, chapters, position: 0 }).onsuccess = (event) => done(event.target.result);
      });
      await setId(id);
      return getBook(id);
    }
    case 'updateId': {
      const id = Number(request.data);
      if (!Number.isInteger(id) || id <= 0) throw new Error('小说编号无效');
      const book = await getBook(id);
      if (!book) throw new Error('小说不存在，请重新导入');
      await setId(id);
      return book;
    }
    case 'updatePosition': {
      const { id, position } = request.data || {};
      if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(position) || position < 0) throw new Error('阅读位置必须为有效整数');
      await files('readwrite', (store) => {
        store.get(id).onsuccess = (event) => {
          const book = event.target.result;
          if (!book) {
            store.transaction.abort();
            return;
          }
          book.position = normalizeOffset(book.content, position);
          delete book.pageNum;
          delete book.pageSize;
          store.put(book);
        };
      });
      return getBook(id);
    }
    default:
      throw new Error('未知操作');
  }
};

// 请求页面直接获得响应，后台不再向不确定的活动标签页推送小说。
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  handleMessage(request).then(
    (data) => sendResponse({ status: 'success', data }),
    (error) => sendResponse({ status: 'error', error: error.message || '操作失败' })
  );
  return true;
});
