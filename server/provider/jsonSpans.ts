/**
 * Minimal strict JSON parser that records source spans, so citation byte ranges can be matched
 * to the exact candidate object and field they cover. Rejects anything JSON.parse would reject
 * and limits depth/size to keep hostile model output bounded.
 */
export type Span = { start: number; end: number }; // UTF-16 indices, end exclusive
export type JNode =
  | { t: 'obj'; span: Span; entries: { key: string; keySpan: Span; value: JNode }[] }
  | { t: 'arr'; span: Span; items: JNode[] }
  | { t: 'str'; span: Span; v: string }
  | { t: 'num'; span: Span; v: number }
  | { t: 'bool'; span: Span; v: boolean }
  | { t: 'null'; span: Span };

const MAX_LEN = 200_000;
const MAX_DEPTH = 12;

export function parseWithSpans(text: string): JNode {
  if (text.length > MAX_LEN) throw new Error('JSON too large');
  let i = 0;
  const ws = () => { while (i < text.length && ' \t\n\r'.includes(text[i])) i++; };
  const fail = (m: string): never => { throw new Error(`Malformed JSON at ${i}: ${m}`); };
  const str = (): { v: string; span: Span } => {
    const start = i;
    if (text[i] !== '"') fail('expected string');
    let end = i + 1;
    while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
    if (end >= text.length) fail('unterminated string');
    const v: unknown = JSON.parse(text.slice(start, end + 1));
    if (typeof v !== 'string') fail('bad string');
    i = end + 1;
    return { v: v as string, span: { start, end: i } };
  };
  const value = (depth: number): JNode => {
    if (depth > MAX_DEPTH) fail('too deep');
    ws();
    const start = i;
    const ch = text[i];
    if (ch === '{') {
      i++;
      const entries: { key: string; keySpan: Span; value: JNode }[] = [];
      ws();
      if (text[i] === '}') { i++; return { t: 'obj', span: { start, end: i }, entries }; }
      for (;;) {
        ws();
        const k = str();
        ws();
        if (text[i] !== ':') fail('expected :');
        i++;
        entries.push({ key: k.v, keySpan: k.span, value: value(depth + 1) });
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; break; }
        fail('expected , or }');
      }
      return { t: 'obj', span: { start, end: i }, entries };
    }
    if (ch === '[') {
      i++;
      const items: JNode[] = [];
      ws();
      if (text[i] === ']') { i++; return { t: 'arr', span: { start, end: i }, items }; }
      for (;;) {
        items.push(value(depth + 1));
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; break; }
        fail('expected , or ]');
      }
      return { t: 'arr', span: { start, end: i }, items };
    }
    if (ch === '"') { const s = str(); return { t: 'str', span: s.span, v: s.v }; }
    for (const [lit, node] of [['true', true], ['false', false], ['null', null]] as const) {
      if (text.startsWith(lit, i)) {
        i += lit.length;
        return node === null ? { t: 'null', span: { start, end: i } } : { t: 'bool', span: { start, end: i }, v: node };
      }
    }
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i, i + 40));
    if (!m) fail('unexpected token');
    i += m![0].length;
    return { t: 'num', span: { start, end: i }, v: Number(m![0]) };
  };
  const root = value(0);
  ws();
  if (i !== text.length) fail('trailing content');
  return root;
}

/** Converts UTF-16 index to UTF-8 byte offset. */
export function byteOffsetFactory(text: string): (index: number) => number {
  const cache = new Map<number, number>();
  return (index) => {
    let v = cache.get(index);
    if (v === undefined) { v = Buffer.byteLength(text.slice(0, index), 'utf8'); cache.set(index, v); }
    return v;
  };
}
