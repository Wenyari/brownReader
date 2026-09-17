(() => {
  const MAX_FILE_BYTES = 50 * 1024 * 1024;
  const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
  const MAX_TEXT_BYTES = 40 * 1024 * 1024;
  const elements = (root, name) => Array.from(root.getElementsByTagNameNS('*', name));

  const parseXML = (bytes, name) => {
    // XML 文档不挂载到页面，书内脚本和外部资源不会执行或加载。
    let encoding = 'utf-8';
    if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
    else {
      const declaration = new TextDecoder().decode(bytes.subarray(0, 200));
      encoding = declaration.match(/^\s*<\?xml[^>]*encoding\s*=\s*['"]([^'"]+)['"]/i)?.[1] || encoding;
    }
    let text;
    try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes); }
    catch (_) { throw new Error(`EPUB 文件编码无效：${name}`); }
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (elements(doc, 'parsererror').length) throw new Error(`EPUB 文档损坏，无法解析：${name}`);
    return doc;
  };

  const resolvePath = (base, reference) => {
    if (typeof reference !== 'string' || !reference.trim()) throw new Error('EPUB 缺少资源路径');
    // EPUB 内部 URI 相对于 OPF 所在目录解析，禁止访问书外地址或越过 ZIP 根目录。
    const path = reference.split(/[?#]/, 1)[0];
    if (!path || /^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith('/')) throw new Error('EPUB 包含不支持的外部资源路径');
    let decoded;
    try { decoded = decodeURIComponent(path); }
    catch (_) { throw new Error('EPUB 资源路径编码无效'); }
    if (decoded.includes('\\') || decoded.startsWith('/') || decoded.includes('\0')) throw new Error('EPUB 资源路径无效');
    const parts = base ? base.split('/').slice(0, -1) : [];
    for (const part of decoded.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') {
        if (!parts.length) throw new Error('EPUB 资源路径超出文件范围');
        parts.pop();
      } else parts.push(part);
    }
    return parts.join('/');
  };

  const extractText = (doc) => {
    const body = elements(doc, 'body')[0];
    if (!body) throw new Error('EPUB 章节缺少正文');
    const blocks = new Set(['p', 'div', 'section', 'article', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'pre', 'tr', 'dl', 'dt', 'dd']);
    const skipped = new Set(['script', 'style', 'nav', 'noscript', 'iframe', 'object', 'svg', 'math', 'rt', 'rp']);
    const chunks = [];
    const visit = (node) => {
      if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.CDATA_SECTION_NODE) {
        chunks.push(node.textContent.replace(/\s+/g, ' '));
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE || skipped.has(node.localName) || node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true') return;
      const name = node.localName;
      if (name === 'br' || name === 'hr') { chunks.push('\n'); return; }
      if (blocks.has(name)) chunks.push('\n\n');
      for (const child of node.childNodes) visit(child);
      if (blocks.has(name)) chunks.push('\n\n');
      if (name === 'td' || name === 'th') chunks.push(' ');
    };
    visit(body);
    return chunks.join('').replace(/[^\S\n]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  };

  const read = async (buffer) => {
    const zip = new Uint8Array(buffer);
    if (zip.length > MAX_FILE_BYTES) throw new Error('EPUB 文件不能超过 50 MB');
    if (zip[0] !== 0x50 || zip[1] !== 0x4b) throw new Error('不是有效的 EPUB 文件');
    const entries = new Map();
    try {
      // 先读取 ZIP 目录，按需解压正文，避免将图片和字体全部加载进内存。
      fflate.unzipSync(zip, { filter: (entry) => {
        if (entries.has(entry.name)) throw new Error('重复资源路径');
        entries.set(entry.name, entry);
        return false;
      } });
    } catch (_) { throw new Error('EPUB 压缩包损坏或格式不受支持'); }
    let totalBytes = 0;
    const readEntry = (name) => {
      const metadata = entries.get(name);
      if (!metadata) throw new Error(`EPUB 缺少资源：${name}`);
      if (metadata.originalSize > MAX_ENTRY_BYTES || totalBytes + metadata.originalSize > MAX_TEXT_BYTES) throw new Error('EPUB 正文过大：单个文档最多 8 MB，累计最多 40 MB');
      let bytes;
      try { bytes = fflate.unzipSync(zip, { filter: (entry) => entry.name === name })[name]; }
      catch (_) { throw new Error(`EPUB 资源损坏或已加密：${name}`); }
      if (!bytes || bytes.length !== metadata.originalSize) throw new Error(`EPUB 资源长度异常：${name}`);
      totalBytes += bytes.length;
      return bytes;
    };
    if (new TextDecoder().decode(readEntry('mimetype')).trim() !== 'application/epub+zip') throw new Error('不是有效的 EPUB 文件');
    const container = parseXML(readEntry('META-INF/container.xml'), 'container.xml');
    const rootfile = elements(container, 'rootfile').find((node) => node.getAttribute('media-type') === 'application/oebps-package+xml');
    if (!rootfile) throw new Error('EPUB 缺少书籍目录文件');
    const opfPath = resolvePath('', rootfile.getAttribute('full-path'));
    const encryptedPaths = new Set();
    if (entries.has('META-INF/encryption.xml')) {
      const encryption = parseXML(readEntry('META-INF/encryption.xml'), 'encryption.xml');
      for (const node of elements(encryption, 'CipherReference')) encryptedPaths.add(resolvePath('', node.getAttribute('URI')));
    }
    if (encryptedPaths.has(opfPath)) throw new Error('不支持带 DRM 或正文加密的 EPUB');
    const opf = parseXML(readEntry(opfPath), opfPath);
    const manifest = elements(opf, 'manifest')[0];
    const spine = elements(opf, 'spine')[0];
    if (!manifest || !spine) throw new Error('EPUB 缺少章节清单或阅读顺序');
    const items = new Map(elements(manifest, 'item').map((node) => [node.getAttribute('id'), node]));
    const chapters = [];
    // 必须使用 spine 顺序；ZIP 顺序和文件名排序都不能代表真实阅读顺序。
    for (const ref of elements(spine, 'itemref')) {
      if (ref.getAttribute('linear') === 'no') continue;
      const item = items.get(ref.getAttribute('idref'));
      if (!item) throw new Error('EPUB 阅读顺序引用了不存在的章节');
      if ((item.getAttribute('properties') || '').split(/\s+/).includes('nav')) continue;
      if (item.getAttribute('media-type') !== 'application/xhtml+xml') throw new Error('EPUB 包含不支持的正文格式，仅支持 XHTML 文字章节');
      const path = resolvePath(opfPath, item.getAttribute('href'));
      if (encryptedPaths.has(path)) throw new Error('不支持带 DRM 或正文加密的 EPUB');
      const text = extractText(parseXML(readEntry(path), path));
      if (text) chapters.push(text);
      // 章节之间让出事件循环，弹窗可以继续显示导入状态。
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (!chapters.length) throw new Error('EPUB 中没有可读取的文字正文');
    return chapters.join('\n\n');
  };

  globalThis.brownReaderEpub = { read, MAX_FILE_BYTES };
})();
