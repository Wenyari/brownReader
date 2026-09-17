(() => {
  // 防止已打开页面按需注入时重复注册事件。
  if (globalThis.brownReaderLoaded) return;
  globalThis.brownReaderLoaded = true;

  let book = null;
  let target = null;
  let originalNodes = [];
  let showing = false;
  let selecting = false;
  let candidate = null;
  let frame = null;
  let notice = null;
  let overlay = null;
  let shield = null;
  let badge = null;
  let pointer = null;
  let pageEnd = 0;
  let layoutFrame = 0;
  let progressQueue = Promise.resolve();
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const resizeObserver = new ResizeObserver(() => scheduleLayout());
  const styleObserver = new MutationObserver(() => scheduleLayout());

  const message = async (request) => {
    const response = await chrome.runtime.sendMessage(request);
    if (!response || response.status !== 'success') {
      throw new Error(response?.error || '插件通信失败，请重新加载插件并刷新网页');
    }
    return response.data;
  };

  const ensureOverlay = () => {
    if (overlay?.isConnected) return;
    overlay = document.createElement('div');
    // Shadow DOM 隔离内部样式；宿主使用 important 避免网页通用规则隐藏选择器。
    overlay.style.cssText = 'all:initial !important;display:block !important;position:fixed !important;inset:0 !important;width:100vw !important;height:100vh !important;margin:0 !important;padding:0 !important;border:0 !important;background:transparent !important;opacity:1 !important;visibility:visible !important;transform:none !important;pointer-events:none !important;z-index:2147483647 !important;';
    const root = overlay.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      :host { color-scheme: light; }
      * { box-sizing: border-box; }
      .shield { display:none; position:fixed; inset:0; pointer-events:auto; cursor:crosshair; }
      .frame { display:none; position:fixed; border:2px solid; pointer-events:none; }
      .notice, .badge { position:fixed; margin:0; padding:8px 12px; color:#fff; background:#20242b; font:13px/1.5 sans-serif; border-radius:4px; pointer-events:none; overflow-wrap:anywhere; }
      .notice { top:12px; left:12px; max-width:calc(100vw - 24px); }
      .badge { display:none; max-width:min(420px, calc(100vw - 24px)); }
    `;
    shield = document.createElement('div');
    shield.className = 'shield';
    frame = document.createElement('div');
    frame.className = 'frame';
    notice = document.createElement('div');
    notice.className = 'notice';
    badge = document.createElement('div');
    badge.className = 'badge';
    root.append(style, shield, frame, notice, badge);
    document.documentElement.appendChild(overlay);
    // 使用 top layer，选择器也能显示在网页的 dialog 和 popover 上方。
    if (typeof overlay.showPopover === 'function') {
      overlay.setAttribute('popover', 'manual');
      overlay.showPopover();
    }
  };

  const announce = (text) => {
    ensureOverlay();
    notice.style.display = 'block';
    notice.textContent = text;
  };

  const clearNotice = () => {
    if (notice) notice.style.display = 'none';
    if (!selecting) {
      overlay?.remove();
      overlay = shield = frame = notice = badge = null;
    }
  };

  // Wujie 的节点可能由 iframe 创建，跨 realm 时不能用 instanceof 判断元素类型。
  const isElement = (node) => node?.nodeType === Node.ELEMENT_NODE;
  const composedParent = (element) => element.assignedSlot || element.parentElement || element.getRootNode()?.host || null;

  const hasInteractiveAncestor = (element) => {
    for (let current = element; isElement(current); current = composedParent(current)) {
      if (current.isContentEditable || current.matches('a, button, label, select, [role="button"], [role="link"], [contenteditable]:not([contenteditable="false"])')) return true;
    }
    return false;
  };

  const deepestElementAt = (x, y) => {
    let element = document.elementFromPoint(x, y);
    const visited = new Set();
    // 每层 ShadowRoot 都使用同一视口坐标；宿主边界或 slot 回指时停止，避免循环。
    while (isElement(element) && element.shadowRoot && !visited.has(element)) {
      visited.add(element);
      const inner = element.shadowRoot.elementFromPoint(x, y);
      if (!isElement(inner) || inner === element || visited.has(inner)) break;
      element = inner;
    }
    return element;
  };

  const isTyping = (event) => {
    // Shadow DOM 会将 event.target 和 document.activeElement 重定向为宿主。
    let active = document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    const origin = event.composedPath().find(isElement);
    return [active, origin].some((element) => {
      for (let current = element; isElement(current); current = composedParent(current)) {
        if (current.matches('input, textarea, select') || current.isContentEditable) return true;
      }
      return false;
    });
  };

  // 返回不可选的具体原因，悬停与点击始终使用同一套判断。
  const rejectionReason = (element) => {
    if (!isElement(element)) return '未找到网页元素';
    if (element.matches('iframe, frame')) return '暂不支持选择 iframe 内的元素';
    if (element.namespaceURI !== 'http://www.w3.org/1999/xhtml' || !element.matches('span, div')) return '仅支持 span 或 div';
    if (hasInteractiveAncestor(element)) return '链接、按钮或可编辑区域不可选';
    if (element.shadowRoot) return '这是 Shadow DOM 宿主，请移动到内部文字区域';
    if (element.childElementCount) return '包含子元素，请选择无子元素的纯文本 span/div';
    if (!element.textContent.trim()) return '元素没有文字';
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (style.visibility !== 'visible' || Number(style.opacity) === 0 || rect.width <= 0 || rect.height <= 0) return '元素不可见';
    return '';
  };

  const inspectAt = (x, y) => {
    // 临时关闭拦截层命中，取得鼠标下真实的网页元素，随后继续拦截网页点击。
    shield.style.pointerEvents = 'none';
    let element;
    try {
      element = deepestElementAt(x, y);
    } finally {
      shield.style.pointerEvents = 'auto';
    }
    candidate = element;
    const reason = rejectionReason(element);
    if (!element || element === overlay) {
      frame.style.display = badge.style.display = 'none';
      return null;
    }
    const rect = element.getBoundingClientRect();
    const color = reason ? '#dc2626' : '#2563eb';
    Object.assign(frame.style, {
      display: 'block', left: `${rect.left}px`, top: `${rect.top}px`,
      width: `${rect.width}px`, height: `${rect.height}px`,
      borderColor: color, background: reason ? 'rgba(220,38,38,.12)' : 'rgba(37,99,235,.15)',
    });
    const name = element.localName + (element.id ? `#${element.id}` : '');
    badge.textContent = `${name} · ${reason || '可选择，点击替换文字'}`;
    Object.assign(badge.style, { display: 'block', background: color, left: '12px', top: '12px' });
    const labelRect = badge.getBoundingClientRect();
    badge.style.left = `${Math.max(12, Math.min(x + 16, window.innerWidth - labelRect.width - 12))}px`;
    badge.style.top = `${Math.max(12, Math.min(y + 20, window.innerHeight - labelRect.height - 12))}px`;
    return reason ? null : element;
  };

  const stopSelection = () => {
    selecting = false;
    candidate = pointer = null;
    clearNotice();
  };

  const restore = () => {
    // 保留原节点引用，恢复时不通过 HTML 字符串重建网页内容。
    if (target && showing) target.replaceChildren(...originalNodes);
    showing = false;
  };

  const persistPosition = () => {
    const data = { id: book.id, position: book.position };
    // 串行提交快照，连续快速翻页时不会被较早的请求覆盖最新位置。
    progressQueue = progressQueue.then(() => message({ action: 'updatePosition', data })).catch((error) => announce(error.message));
  };

  const scheduleLayout = () => {
    if (!showing || selecting || layoutFrame) return;
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = 0;
      if (showing && !selecting) render();
    });
  };

  const observeLayout = () => {
    resizeObserver.disconnect();
    styleObserver.disconnect();
    for (let node = target; isElement(node); node = composedParent(node)) {
      resizeObserver.observe(node);
      styleObserver.observe(node, { attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
    }
  };
  window.addEventListener('resize', scheduleLayout);
  document.fonts?.addEventListener('loadingdone', scheduleLayout);

  const measureArea = () => {
    // 先恢复原内容测量区域，自动高度的元素也不能被小说撑大。
    target.replaceChildren(...originalNodes);
    const rect = target.getBoundingClientRect();
    const style = getComputedStyle(target);
    const number = (value) => Number.parseFloat(value) || 0;
    const area = {
      left: rect.left + number(style.borderLeftWidth) + number(style.paddingLeft),
      right: rect.right - number(style.borderRightWidth) - number(style.paddingRight),
      top: rect.top + number(style.borderTopWidth) + number(style.paddingTop),
      bottom: rect.bottom - number(style.borderBottomWidth) - number(style.paddingBottom),
      width: rect.width, height: rect.height, lineHeight: number(style.lineHeight),
    };
    // 将祖先的裁剪边界纳入测量，包括 Shadow DOM 外部容器。
    for (let node = composedParent(target); isElement(node); node = composedParent(node)) {
      const parentStyle = getComputedStyle(node);
      const bounds = node.getBoundingClientRect();
      if (/hidden|clip|auto|scroll/.test(parentStyle.overflowX)) {
        area.left = Math.max(area.left, bounds.left + node.clientLeft);
        area.right = Math.min(area.right, bounds.left + node.clientLeft + node.clientWidth);
      }
      if (/hidden|clip|auto|scroll/.test(parentStyle.overflowY)) {
        area.top = Math.max(area.top, bounds.top + node.clientTop);
        area.bottom = Math.min(area.bottom, bounds.top + node.clientTop + node.clientHeight);
      }
    }
    if (style.visibility !== 'visible' || area.right <= area.left || area.bottom <= area.top) throw new Error('阅读区域没有可用空间，请扩大区域或重新选择');
    return area;
  };

  const fitRange = (anchor, backward = false) => {
    const area = measureArea();
    // 单次只测量临近正文；以完整 grapheme 为边界，避免拆开 emoji 或组合字符。
    const start = backward ? Math.max(0, anchor - 16384) : anchor;
    const limit = backward ? anchor : Math.min(book.content.length, anchor + 16384);
    const segmentLimit = Math.min(book.content.length, limit + 128);
    const boundaries = [start];
    for (const part of segmenter.segment(book.content.slice(start, segmentLimit))) {
      const end = start + part.index + part.segment.length;
      if (end > limit) break;
      boundaries.push(end);
    }
    if (backward && boundaries.at(-1) !== anchor) boundaries.push(anchor);
    const count = boundaries.length - 1;
    const fits = (length) => {
      const from = backward ? boundaries[count - length] : anchor;
      const to = backward ? anchor : boundaries[length];
      target.textContent = book.content.slice(from, to);
      const rect = target.getBoundingClientRect();
      if (rect.width > area.width + 0.5 || rect.height > area.height + 0.5) return false;
      const range = document.createRange();
      range.selectNodeContents(target);
      // Range 包含被 overflow 和 ellipsis 隐藏的文字位置，不能只检查元素自身大小。
      return Array.from(range.getClientRects()).every((line) => {
        // Range 返回字体度量框；字体框高于 line-height 时，用实际行框判断分页。
        const leading = area.lineHeight > 0 ? Math.max(0, line.height - area.lineHeight) / 2 : 0;
        return line.left >= area.left - 0.5 && line.right <= area.right + 0.5 &&
          line.top + leading >= area.top - 0.5 && line.bottom - leading <= area.bottom + 0.5;
      });
    };
    let low = 0;
    let high = count;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (fits(middle)) low = middle;
      else high = middle - 1;
    }
    if (!low) throw new Error('阅读区域放不下一个完整字符，请扩大区域或重新选择');
    return backward ? { start: boundaries[count - low], end: anchor } : { start: anchor, end: boundaries[low] };
  };

  const render = (backward = false) => {
    if (!target?.isConnected) {
      target = null;
      originalNodes = [];
      showing = false;
      resizeObserver.disconnect();
      styleObserver.disconnect();
      announce('阅读位置已被网页移除，请重新选择元素');
      return false;
    }
    try {
      const page = fitRange(book.position, backward);
      target.textContent = book.content.slice(page.start, page.end);
      book.position = page.start;
      pageEnd = page.end;
      showing = true;
      clearNotice();
      return true;
    } catch (error) {
      target.replaceChildren(...originalNodes);
      showing = false;
      pageEnd = book.position;
      announce(error.message);
      return false;
    }
  };

  // 全屏拦截层提供一致的十字光标，并阻止选择动作触发网页按钮或链接。
  window.addEventListener('pointermove', (event) => {
    if (!selecting) return;
    pointer = { x: event.clientX, y: event.clientY };
    inspectAt(pointer.x, pointer.y);
    event.stopImmediatePropagation();
  }, true);

  const refreshHighlight = () => {
    if (selecting && pointer) inspectAt(pointer.x, pointer.y);
  };
  window.addEventListener('scroll', refreshHighlight, true);
  window.addEventListener('resize', refreshHighlight);
  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick', 'contextmenu']) {
    window.addEventListener(type, (event) => {
      if (!selecting) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
  }

  window.addEventListener('click', (event) => {
    if (!selecting) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const chosen = inspectAt(event.clientX, event.clientY);
    if (!chosen) {
      announce(`无法选择：${rejectionReason(candidate)}。请移动鼠标重新选择；Esc 取消`);
      return;
    }
    restore();
    target = chosen;
    originalNodes = Array.from(target.childNodes);
    stopSelection();
    observeLayout();
    render();
  }, true);

  document.addEventListener('keydown', (event) => {
    if (selecting && event.key === 'Escape') {
      event.preventDefault();
      stopSelection();
      return;
    }
    if (event.key === 'Escape') clearNotice();
    if (event.isComposing || isTyping(event) || selecting || !target || !book) return;
    if (event.key === 'F1' && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
      // 阅读位置已选中时拦截 F1，避免打开浏览器帮助；长按不重复切换。
      event.preventDefault();
      if (event.repeat) return;
      if (showing) restore();
      else render();
      return;
    }
    if (!showing || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
    const key = event.key.toLowerCase();
    if (key !== 'a' && key !== 'd') return;
    event.preventDefault();
    if (key === 'a') {
      if (book.position === 0) return;
      if (render(true)) persistPosition();
    } else {
      if (pageEnd >= book.content.length || pageEnd <= book.position) return;
      const previous = book.position;
      book.position = pageEnd;
      if (render()) persistPosition();
      else book.position = previous;
    }
  }, true);

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'PING') {
      sendResponse({ status: 'success', pickerVersion: 4 });
    } else if (request.action === 'SELECTION_STATUS') {
      sendResponse({ status: 'success', active: selecting && Boolean(overlay?.isConnected) && shield?.style.display === 'block' });
    } else if (request.action === 'FROM_POPUP') {
      book = request.data;
      if (showing) render();
      sendResponse({ status: 'success' });
    } else if (request.action === 'START_SELECTION') {
      message({ action: 'getCurrentBook' }).then((data) => {
        if (!data?.content?.trim()) throw new Error('请先导入并选择有正文的 TXT 或 EPUB 小说');
        restore();
        book = data;
        stopSelection();
        announce('选择模式已开启：蓝色可选，红色不可选；点击纯文本 span/div；Esc 取消');
        shield.style.display = 'block';
        selecting = true;
        sendResponse({ status: 'success', active: true, pickerVersion: 4 });
      }).catch((error) => {
        stopSelection();
        sendResponse({ status: 'error', error: error.message });
      });
      return true;
    }
  });
})();
