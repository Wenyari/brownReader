(() => {
  const readChapters = (content) => {
    const chapters = [];
    // 仅识别独立短行，保留原始正文和 UTF-16 偏移量，避免跳转位置错位。
    const heading = /^(?:第[零〇一二三四五六七八九十百千万两\d０-９]+[章回节卷部篇](?:\s.*|[^\s]{0,50})|chapter\s+\d+(?:\s.*|[.:：].*)?|序章|序言|楔子|引子|前言|尾声|后记|终章|番外(?:\s.*|[一二三四五六七八九十\d]+.*)?)$/i;
    for (const match of content.matchAll(/[^\r\n]+/g)) {
      const title = match[0].trim();
      if (!title || title.length > 60 || !heading.test(title)) continue;
      chapters.push({ title, position: match.index + match[0].indexOf(title), level: 0 });
    }
    return chapters;
  };
  globalThis.brownReaderTxt = { readChapters };
})();
