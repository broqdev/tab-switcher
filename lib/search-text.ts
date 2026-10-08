// Ranges use UTF-16 offsets with an exclusive end, matching String.slice.
export type MatchRange = [start: number, end: number];

export interface MatchedText {
  text: string;
  ranges: MatchRange[];
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function normalizeSearchText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase();
}

export function decodeSearchUrl(url: string): string {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}

export function literalRanges(text: string, term: string): MatchRange[] {
  const ranges: MatchRange[] = [];
  if (!term) return ranges;
  for (
    let start = text.indexOf(term);
    start !== -1;
    start = text.indexOf(term, start + 1)
  ) {
    ranges.push([start, start + term.length]);
  }
  return ranges;
}

export function regexRanges(text: string, pattern: RegExp): MatchRange[] {
  return Array.from(text.matchAll(new RegExp(pattern.source, 'giu')))
    .filter((match) => match[0].length > 0)
    .map((match) => [match.index, match.index + match[0].length]);
}

export function mergeRanges(ranges: MatchRange[]): MatchRange[] {
  const merged: MatchRange[] = [];
  for (const [start, end] of [...ranges].sort(
    (a, b) => a[0] - b[0] || a[1] - b[1],
  )) {
    if (end <= start) continue;
    const previous = merged.at(-1);
    if (previous && start <= previous[1])
      previous[1] = Math.max(previous[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

export function matchedText(
  text: string,
  ranges: MatchRange[],
  normalized: boolean,
): MatchedText {
  if (!normalized || ranges.length === 0)
    return { text, ranges: mergeRanges(ranges) };
  // A normalized character can expand (ﬃ → ffi), shrink (é → e), or be
  // represented by several original code units. Keep whole graphemes colored.
  const starts: number[] = [];
  const ends: number[] = [];
  for (const segment of graphemes.segment(text)) {
    const length = normalizeSearchText(segment.segment).length;
    for (let index = 0; index < length; index++) {
      starts.push(segment.index);
      ends.push(segment.index + segment.segment.length);
    }
  }
  return {
    text,
    ranges: mergeRanges(
      ranges.flatMap(([start, end]) => {
        const originalStart = starts[start];
        const originalEnd = ends[end - 1];
        return originalStart === undefined || originalEnd === undefined
          ? []
          : [[originalStart, originalEnd]];
      }),
    ),
  };
}

export function matchExcerpt(
  match: MatchedText,
  leadingContext: number,
): MatchedText {
  const first = match.ranges[0];
  if (!first || first[0] <= leadingContext) return match;
  let offset = 0;
  for (const segment of graphemes.segment(match.text)) {
    if (segment.index > first[0] - leadingContext) break;
    offset = segment.index;
  }
  if (offset === 0) return match;
  return {
    text: `…${match.text.slice(offset)}`,
    ranges: match.ranges.map(([start, end]) => [
      start - offset + 1,
      end - offset + 1,
    ]),
  };
}
