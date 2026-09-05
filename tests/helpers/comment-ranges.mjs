const ID = /[A-Za-z0-9_$-￿]/;

// slash starts regex after
const BEFORE_REGEX = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'case', 'do', 'else', 'yield', 'await', 'default',
]);

export function commentRanges(text) {
  const out = [];
  const n = text.length;
  let i = 0;
  const templates = [];
  let braces = 0;
  let prevSignificant = '';
  let prevWord = '';

  const pushWordBoundary = (ch) => {
    if (ID.test(ch)) prevWord += ch;
    else prevWord = '';
    prevSignificant = ch;
  };

  while (i < n) {
    const c = text[i];
    const d = text[i + 1];

    if (c === '/' && d === '/') {
      const start = i;
      while (i < n && text[i] !== '\n') i++;
      out.push({ start, end: text[i - 1] === '\r' ? i - 1 : i });
      prevSignificant = '';
      prevWord = '';
      continue;
    }
    if (c === '/' && d === '*') {
      const start = i;
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i = Math.min(n, i + 2);
      out.push({ start, end: i });
      prevSignificant = '';
      prevWord = '';
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < n && text[i] !== c) {
        if (text[i] === '\\') i++;
        if (text[i] === '\n') break;
        i++;
      }
      i++;
      prevSignificant = c;
      prevWord = '';
      continue;
    }
    if (c === '`') {
      templates.push(braces);
      i++;
      while (i < n) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === '`') { i++; templates.pop(); break; }
        if (text[i] === '$' && text[i + 1] === '{') { i += 2; braces++; break; }
        i++;
      }
      prevSignificant = '`';
      prevWord = '';
      continue;
    }
    if (c === '}' && templates.length && braces === templates[templates.length - 1] + 1) {
      braces--;
      i++;
      while (i < n) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === '`') { i++; templates.pop(); break; }
        if (text[i] === '$' && text[i + 1] === '{') { i += 2; braces++; break; }
        i++;
      }
      prevSignificant = '`';
      prevWord = '';
      continue;
    }
    if (c === '{') { braces++; pushWordBoundary(c); i++; continue; }
    if (c === '}') { braces = Math.max(0, braces - 1); pushWordBoundary(c); i++; continue; }

    if (c === '/') {
      const делит = (prevSignificant === ')' || prevSignificant === ']'
        || (ID.test(prevSignificant) && !BEFORE_REGEX.has(prevWord)))
        && prevSignificant !== '';
      if (!делит) {
        i++;
        let вКлассе = false;
        while (i < n) {
          const ch = text[i];
          if (ch === '\\') { i += 2; continue; }
          if (ch === '\n') break;
          if (ch === '[') вКлассе = true;
          else if (ch === ']') вКлассе = false;
          else if (ch === '/' && !вКлассе) { i++; break; }
          i++;
        }
        while (i < n && /[dgimsuvy]/.test(text[i])) i++;
        prevSignificant = '/';
        prevWord = '';
        continue;
      }
    }

    if (!/\s/.test(c)) pushWordBoundary(c);
    i++;
  }
  return out;
}
