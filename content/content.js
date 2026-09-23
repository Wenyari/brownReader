(() => {
  // 防止已打开页面按需注入时重复注册事件。
  if (globalThis.brownReaderLoaded) return;
  globalThis.brownReaderLoaded = true;

  let book = null;
  // 阅读区域由一个或多个元素拼接，按选择顺序依次承载正文：[{ element, nodes }]
  let spots = [];
  let showing = false;
  let selecting = false;
  let candidate = null;
  let picked = [];
  let frame = null;
  let notice = null;
  let overlay = null;
  let shield = null;
  let badge = null;
  let marks = null;
  let pointer = null;
  let pageEnd = 0;
  let layoutFrame = 0;
  let noticeTimer = 0;
  let pageStarts = [];
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
      .mark { position:fixed; border:2px solid #16a34a; background:rgba(22,163,74,.18); pointer-events:none; }
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
    marks = document.createElement('div');
    // 已选区域画在悬停框下方，鼠标移过去时仍能看清当前判定。
    root.append(style, shield, marks, frame, notice, badge);
    document.documentElement.appendChild(overlay);
    // 使用 top layer，选择器也能显示在网页的 dialog 和 popover 上方。
    if (typeof overlay.showPopover === 'function') {
      overlay.setAttribute('popover', 'manual');
      overlay.showPopover();
    }
  };

  const announce = (text, timeout = 0) => {
    ensureOverlay();
    notice.style.display = 'block';
    notice.textContent = text;
    clearTimeout(noticeTimer);
    noticeTimer = timeout ? setTimeout(clearNotice, timeout) : 0;
  };

  const clearNotice = () => {
    clearTimeout(noticeTimer);
    noticeTimer = 0;
    if (notice) notice.style.display = 'none';
    if (!selecting) {
      overlay?.remove();
      overlay = shield = frame = notice = badge = marks = null;
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
    const hint = picked.includes(element) ? '已选，点击取消' : '可选择，点击加入';
    badge.textContent = `${name} · ${reason || hint}`;
    Object.assign(badge.style, { display: 'block', background: color, left: '12px', top: '12px' });
    const labelRect = badge.getBoundingClientRect();
    badge.style.left = `${Math.max(12, Math.min(x + 16, window.innerWidth - labelRect.width - 12))}px`;
    badge.style.top = `${Math.max(12, Math.min(y + 20, window.innerHeight - labelRect.height - 12))}px`;
    return reason ? null : element;
  };

  const paintPicked = () => {
    if (!marks) return;
    marks.replaceChildren();
    for (const element of picked) {
      const rect = element.getBoundingClientRect();
      const box = document.createElement('div');
      box.className = 'mark';
      Object.assign(box.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
      marks.appendChild(box);
    }
  };

  const guide = () => {
    announce(picked.length
      ? `已选 ${picked.length} 处，按回车开始阅读；再次点击可取消该处；Esc 退出`
      : '点击纯文本 span/div 选择阅读区域，可点选多处拼接；蓝色可选，红色不可选；Esc 取消');
  };

  const stopSelection = () => {
    selecting = false;
    candidate = pointer = null;
    picked = [];
    clearNotice();
  };

  const restoreNodes = () => {
    for (const spot of spots) spot.element.replaceChildren(...spot.nodes);
  };

  const restore = () => {
    // 保留原节点引用，恢复时不通过 HTML 字符串重建网页内容。
    if (showing) restoreNodes();
    showing = false;
  };

  // 翻页历史跟着小说走，换页面继续读时仍能原路返回。
  const pageStartsKey = () => `pageStarts:${book.id}`;
  const loadPageStarts = async () => {
    const key = pageStartsKey();
    const saved = (await chrome.storage.local.get(key))[key];
    pageStarts = Array.isArray(saved) ? saved.filter(Number.isSafeInteger) : [];
  };
  const savePageStarts = () => {
    pageStarts = pageStarts.slice(-200);
    chrome.storage.local.set({ [pageStartsKey()]: pageStarts }).catch(() => {});
  };

  const persistPosition = () => {
    const data = { id: book.id, position: book.position };
    savePageStarts();
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
    for (const spot of spots) {
      for (let node = spot.element; isElement(node); node = composedParent(node)) {
        resizeObserver.observe(node);
        styleObserver.observe(node, { attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
      }
    }
  };
  window.addEventListener('resize', scheduleLayout);
  document.fonts?.addEventListener('loadingdone', scheduleLayout);

  // 无可用空间时返回 null，由调用方决定跳过该元素还是整页失败。
  const measureArea = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const number = (value) => Number.parseFloat(value) || 0;
    const area = {
      left: rect.left + number(style.borderLeftWidth) + number(style.paddingLeft),
      right: rect.right - number(style.borderRightWidth) - number(style.paddingRight),
      top: rect.top + number(style.borderTopWidth) + number(style.paddingTop),
      bottom: rect.bottom - number(style.borderBottomWidth) - number(style.paddingBottom),
      width: rect.width, height: rect.height, lineHeight: number(style.lineHeight),
    };
    // 将祖先的裁剪边界纳入测量，包括 Shadow DOM 外部容器。
    for (let node = composedParent(element); isElement(node); node = composedParent(node)) {
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
    if (style.visibility !== 'visible' || area.right <= area.left || area.bottom <= area.top) return null;
    return area;
  };

  const measureAreas = () => {
    // 先整体还原原内容再测量：自动高度的元素不能被小说撑大，同行的相邻元素也不能被挤走。
    restoreNodes();
    return spots.map((spot) => measureArea(spot.element));
  };

  const fits = (element, area, text) => {
    element.textContent = text;
    const rect = element.getBoundingClientRect();
    if (rect.width > area.width + 0.5 || rect.height > area.height + 0.5) return false;
    const range = document.createRange();
    range.selectNodeContents(element);
    // Range 包含被 overflow 和 ellipsis 隐藏的文字位置，不能只检查元素自身大小。
    return Array.from(range.getClientRects()).every((line) => {
      // Range 返回字体度量框；字体框高于 line-height 时，用实际行框判断分页。
      const leading = area.lineHeight > 0 ? Math.max(0, line.height - area.lineHeight) / 2 : 0;
      return line.left >= area.left - 0.5 && line.right <= area.right + 0.5 &&
        line.top + leading >= area.top - 0.5 && line.bottom - leading <= area.bottom + 0.5;
    });
  };

  // 返回该元素能容纳到的正文终点；等于 from 表示连一个字符都放不下。
  const fitOne = (element, area, from) => {
    // 单次只测量临近正文；以完整 grapheme 为边界，避免拆开 emoji 或组合字符。
    const limit = Math.min(book.content.length, from + 16384);
    const segmentLimit = Math.min(book.content.length, limit + 128);
    const boundaries = [from];
    for (const part of segmenter.segment(book.content.slice(from, segmentLimit))) {
      const end = from + part.index + part.segment.length;
      if (end > limit) break;
      boundaries.push(end);
    }
    let low = 0;
    let high = boundaries.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (fits(element, area, book.content.slice(from, boundaries[middle]))) low = middle;
      else high = middle - 1;
    }
    return boundaries[low];
  };

  // 依次把正文写进各元素，每段按该元素自己的可用区域裁剪；写入本身就是排版结果。
  // 每段确定后立刻落地，是为了清掉二分探测留下的溢出文字——否则同一行的后续元素会被挤走，
  // 与预先测好的区域坐标不再对应。各元素都不超出原有尺寸，所以拼接不会改变网页布局。
  const fitRange = (anchor) => {
    const areas = measureAreas();
    if (!areas.some(Boolean)) throw new Error('阅读区域没有可用空间，请扩大区域或重新选择');
    let cursor = anchor;
    spots.forEach((spot, index) => {
      const area = areas[index];
      if (!area || cursor >= book.content.length) return;
      const end = fitOne(spot.element, area, cursor);
      // 放不下一个字符就还原该元素：留着二分探测的溢出文字会破坏后续测量。
      if (end <= cursor) {
        spot.element.replaceChildren(...spot.nodes);
        return;
      }
      spot.element.textContent = book.content.slice(cursor, end);
      cursor = end;
    });
    if (cursor === anchor) throw new Error('阅读区域放不下一个完整字符，请扩大区域或重新选择');
    return { start: anchor, end: cursor };
  };

  const render = () => {
    spots = spots.filter((spot) => spot.element.isConnected);
    if (!spots.length) {
      showing = false;
      resizeObserver.disconnect();
      styleObserver.disconnect();
      announce('阅读位置已被网页移除，请重新选择元素');
      return false;
    }
    try {
      pageEnd = fitRange(book.position).end;
      showing = true;
      clearNotice();
      return true;
    } catch (error) {
      restoreNodes();
      showing = false;
      pageEnd = book.position;
      announce(error.message);
      return false;
    }
  };

  // 历史栈为空时（百分比跳转或换书后）反推上一页：从更早的位置按正向规则连续分页，
  // 找出覆盖到当前位置的那一页。几次额外排版换来与正常翻页完全一致的分页结果。
  const rewind = (anchor) => {
    try {
      const capacity = Math.max(1, fitRange(anchor).end - anchor);
      let start = Math.max(0, anchor - capacity * 2);
      let last = start;
      for (let guard = 0; guard < 8; guard++) {
        const page = fitRange(start);
        if (page.end <= start) break;
        if (page.end >= anchor) return start;
        last = start;
        start = page.end;
      }
      return last;
    } catch (error) {
      restoreNodes();
      showing = false;
      announce(error.message);
      return null;
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
    if (!selecting) return;
    paintPicked();
    if (pointer) inspectAt(pointer.x, pointer.y);
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

  const commitSelection = () => {
    restore();
    spots = picked.map((element) => ({ element, nodes: Array.from(element.childNodes) }));
    stopSelection();
    observeLayout();
    saveAnchor();
    render();
  };

  window.addEventListener('click', (event) => {
    if (!selecting) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const chosen = inspectAt(event.clientX, event.clientY);
    if (!chosen) {
      announce(`无法选择：${rejectionReason(candidate)}。请移动鼠标重新选择；Esc 取消`);
      return;
    }
    const index = picked.indexOf(chosen);
    // 再次点击已选区域即取消，误点不必退出重来。
    if (index < 0) picked.push(chosen);
    else picked.splice(index, 1);
    paintPicked();
    guide();
  }, true);

  // 阅读快捷键由插件独占，网页自身的同名快捷键不再被触发。
  const consume = (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  window.addEventListener('keydown', (event) => {
    if (selecting) {
      if (event.key === 'Escape') {
        consume(event);
        stopSelection();
      } else if (event.key === 'Enter') {
        consume(event);
        if (picked.length) commitSelection();
        else announce('还没有选中任何区域，先点击纯文本 span/div 再按回车');
      }
      return;
    }
    if (event.key === 'Escape') clearNotice();
    if (event.isComposing || isTyping(event) || !spots.length || !book) return;
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
    const key = event.key.toLowerCase();
    if (key === 'f1' || key === 's') {
      // 拦截 F1 避免打开浏览器帮助；S 紧邻翻页键，应急时手指不必离开主键区。长按不重复切换。
      consume(event);
      if (event.repeat) return;
      if (showing) restore();
      else render();
      return;
    }
    if (!showing || (key !== 'a' && key !== 'd')) return;
    consume(event);
    const previous = book.position;
    if (key === 'a') {
      if (!pageStarts.length) {
        // 跳转或换书后还没有历史，按正向分页规则反推上一页。
        if (previous === 0) return;
        const start = rewind(previous);
        if (start === null) return;
        book.position = start;
        if (render()) persistPosition();
        else book.position = previous;
        return;
      }
      book.position = pageStarts.at(-1);
      // 回到记录过的起点并按同一方向重排，看到的内容与来时完全一致。
      if (render()) {
        pageStarts.pop();
        persistPosition();
      } else book.position = previous;
    } else {
      if (pageEnd >= book.content.length || pageEnd <= book.position) return;
      book.position = pageEnd;
      if (render()) {
        pageStarts.push(previous);
        persistPosition();
      } else book.position = previous;
    }
  }, true);

  // 切换应用或标签页时立即还原原文字；返回页面不自动显示，须再次按 S 或 F1。
  window.addEventListener('blur', () => {
    if (showing) restore();
  });

  // 同一路径下的页面共用一条记录，query 与 hash 变化不影响命中。
  const anchorKey = () => `anchor:${location.origin}${location.pathname}`;

  // 沿真实 DOM 树回溯到 documentElement，逐跳记录标签与同标签序号；跨 Shadow DOM 边界的一跳标记 s。
  // 不用 class 或 id：现代站点的 hash class 和随机 id 每次构建都会变，结构路径对样式改动免疫。
  const describe = (element) => {
    const steps = [];
    for (let node = element; isElement(node);) {
      const container = node.parentNode;
      if (!container) return '';
      // documentElement 是恢复时的起点，本身不占路径段。
      if (container.nodeType === Node.DOCUMENT_NODE) return steps.join('>');
      let index = 0;
      for (const sibling of container.children) {
        if (sibling === node) break;
        if (sibling.localName === node.localName) index++;
      }
      const shadow = container.nodeType === Node.DOCUMENT_FRAGMENT_NODE;
      steps.unshift(`${node.localName}:${index}${shadow ? ':s' : ''}`);
      node = shadow ? container.host : container;
    }
    return '';
  };

  const locate = (path) => {
    let node = document.documentElement;
    for (const step of path.split('>')) {
      const [tag, order, shadow] = step.split(':');
      const container = shadow ? node.shadowRoot : node;
      if (!container) return null;
      let index = 0;
      node = null;
      for (const child of container.children) {
        if (child.localName === tag && index++ === Number(order)) {
          node = child;
          break;
        }
      }
      if (!node) return null;
    }
    return node;
  };

  const saveAnchor = () => {
    const paths = spots.map((spot) => describe(spot.element));
    if (paths.length && paths.every(Boolean)) chrome.storage.local.set({ [anchorKey()]: { paths, savedAt: Date.now() } }).catch(() => {});
  };

  // 重新加载后静默绑定上次的阅读区域，不写入小说内容，须主动按 S 或 F1 显示。
  const restoreAnchor = async () => {
    const key = anchorKey();
    const saved = (await chrome.storage.local.get(key))[key];
    if (!Array.isArray(saved?.paths) || !saved.paths.length) return;
    // 首屏未渲染完时元素尚无尺寸，按递增间隔重试等待 SPA 挂载。
    for (const delay of [0, 300, 1000, 2500]) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      if (spots.length || selecting) return;
      const elements = saved.paths.map(locate);
      // 少一处都不绑定：宁可让用户重选，也不能把小说写进错配的元素。
      if (elements.some((element) => !element || rejectionReason(element))) continue;
      const data = await message({ action: 'getCurrentBook' });
      // 等待期间用户可能已手动选择区域，重新确认后再接管。
      if (!data?.content?.trim() || spots.length || selecting) return;
      book = data;
      await loadPageStarts();
      spots = elements.map((element) => ({ element, nodes: Array.from(element.childNodes) }));
      observeLayout();
      announce(`已恢复上次阅读区域（${spots.length} 处），按 S 或 F1 显示`, 4000);
      return;
    }
  };
  restoreAnchor().catch(() => {});

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'PING') {
      sendResponse({ status: 'success', pickerVersion: 8 });
    } else if (request.action === 'SELECTION_STATUS') {
      sendResponse({ status: 'success', active: selecting && Boolean(overlay?.isConnected) && shield?.style.display === 'block' });
    } else if (request.action === 'FROM_POPUP') {
      const switched = book?.id !== request.data?.id;
      book = request.data;
      // 换书时历史跟着新书走；同一本书被百分比跳转后，旧历史不再对应当前位置，须连同存储一起清掉。
      if (switched) loadPageStarts().catch(() => { pageStarts = []; });
      else if (book) {
        pageStarts = [];
        savePageStarts();
      }
      if (showing) render();
      sendResponse({ status: 'success' });
    } else if (request.action === 'START_SELECTION') {
      message({ action: 'getCurrentBook' }).then((data) => {
        if (!data?.content?.trim()) throw new Error('请先导入并选择有正文的 TXT 或 EPUB 小说');
        restore();
        book = data;
        // 不阻塞 sendResponse：还要先选区域，历史来得及加载完。
        loadPageStarts().catch(() => { pageStarts = []; });
        stopSelection();
        // guide 会重建 overlay，必须在操作 shield 之前调用。
        guide();
        shield.style.display = 'block';
        selecting = true;
        sendResponse({ status: 'success', active: true, pickerVersion: 8 });
      }).catch((error) => {
        stopSelection();
        sendResponse({ status: 'error', error: error.message });
      });
      return true;
    }
  });
})();
