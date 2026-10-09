import type { WindowHit } from "../store/window-index.js";
import { WINDOW_LINES } from "../constants.js";

export interface Range {
  readonly from: number;
  readonly to: number;
}

// A queried window's range and the hit it found in another file.
export interface Pair extends Range {
  readonly other: WindowHit;
}

const near = (a: Range, b: Range): boolean =>
  a.from <= b.to + WINDOW_LINES && a.to >= b.from - WINDOW_LINES;

// A hit joins any pair of the same other file that is near on both sides, so two copies stay two.
export function merge(hits: readonly Pair[]): Pair[] {
  const out: Pair[] = [];
  for (const hit of [...hits].sort((a, b) => a.from - b.from)) {
    const at = out.findIndex(
      (pair) =>
        pair.other.file === hit.other.file &&
        near(pair, hit) &&
        near(pair.other, hit.other)
    );
    const pair = out[at];
    if (!pair) {
      out.push(hit);
      continue;
    }
    out[at] = {
      from: Math.min(pair.from, hit.from),
      to: Math.max(pair.to, hit.to),
      other: {
        ...pair.other,
        from: Math.min(pair.other.from, hit.other.from),
        to: Math.max(pair.other.to, hit.other.to),
        score: Math.max(pair.other.score, hit.other.score),
      },
    };
  }
  return out;
}
