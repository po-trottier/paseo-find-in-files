export type QueryPlan = { alternatives: Uint32Array[] | null };

export function trigrams(bytes: Uint8Array): Uint32Array {
  const unique = new Set<number>();
  let packed = 0;
  for (let index = 0; index < bytes.length; index++) {
    const byte = bytes[index];
    packed = ((packed << 8) | (byte >= 65 && byte <= 90 ? byte + 32 : byte)) & 0xffffff;
    if (index >= 2) unique.add(packed);
  }
  return Uint32Array.from(unique).sort();
}

function requiredTrigrams(literal: string, caseSensitive: boolean): Uint32Array {
  const values = trigrams(Buffer.from(literal, "utf8"));
  if (caseSensitive) return values;
  let length = 0;
  for (const value of values) {
    const first = value >>> 16;
    const second = (value >>> 8) & 255;
    const third = value & 255;
    // Unicode /iu also matches Kelvin sign for k and long s for s.
    if (first !== 107 && first !== 115 && second !== 107 && second !== 115 && third !== 107 && third !== 115) {
      values[length++] = value;
    }
  }
  return values.subarray(0, length);
}

function skipClass(query: string, start: number): number {
  for (let index = start + 1; index < query.length; index++) {
    if (query[index] === "\\") index++;
    else if (query[index] === "]") return index + 1;
  }
  return -1;
}

function skipGroup(query: string, start: number): number {
  let depth = 1;
  for (let index = start + 1; index < query.length; index++) {
    const character = query[index];
    if (character === "\\") index++;
    else if (character === "[") {
      const end = skipClass(query, index);
      if (end < 0) return -1;
      index = end - 1;
    } else if (character === "(") depth++;
    else if (character === ")" && --depth === 0) return index + 1;
  }
  return -1;
}

function escapeEnd(query: string, start: number): number {
  const character = query[start + 1];
  if (!character) return -1;
  if ("dDsSwWbBtnrfv0".includes(character)) return start + 2;
  if (character === "c") return start + 3 <= query.length ? start + 3 : -1;
  if (character === "x") return start + 4 <= query.length ? start + 4 : -1;
  if (character === "u" && query[start + 2] !== "{") return start + 6 <= query.length ? start + 6 : -1;
  if (character === "u" || character === "p" || character === "P") {
    if (query[start + 2] !== "{") return -1;
    const end = query.indexOf("}", start + 3);
    return end < 0 ? -1 : end + 1;
  }
  if (character === "k" && query[start + 2] === "<") {
    const end = query.indexOf(">", start + 3);
    return end < 0 ? -1 : end + 1;
  }
  if (character >= "1" && character <= "9") {
    let end = start + 2;
    while (query[end] >= "0" && query[end] <= "9") end++;
    return end;
  }
  return -1;
}

function quantifier(query: string, start: number): { end: number; optional: boolean } | null {
  const character = query[start];
  if (character === "*" || character === "?" || character === "+") {
    return { end: start + (query[start + 1] === "?" ? 2 : 1), optional: character !== "+" };
  }
  if (character !== "{") return null;
  let end = start + 1;
  let digits = 0;
  let positive = false;
  while (query[end] >= "0" && query[end] <= "9") {
    positive ||= query[end] !== "0";
    digits++;
    end++;
  }
  if (!digits) return null;
  if (query[end] === ",") {
    end++;
    while (query[end] >= "0" && query[end] <= "9") end++;
  }
  if (query[end] !== "}") return null;
  end++;
  if (query[end] === "?") end++;
  return { end, optional: !positive };
}

export function planQuery(query: string, regex: boolean, caseSensitive = false): QueryPlan {
  if (!caseSensitive) {
    for (let index = 0; index < query.length; index++) {
      if (query.charCodeAt(index) > 127) return { alternatives: null };
    }
  }
  if (!regex) {
    const required = requiredTrigrams(query, caseSensitive);
    return { alternatives: required.length ? [required] : null };
  }

  const alternatives: Uint32Array[] = [];
  let required = new Set<number>();
  let run = "";
  const flush = () => {
    if (run) for (const value of requiredTrigrams(run, caseSensitive)) required.add(value);
    run = "";
  };
  for (let index = 0; index < query.length;) {
    const character = query[index];
    if (character === "|") {
      flush();
      if (!required.size) return { alternatives: null };
      alternatives.push(Uint32Array.from(required).sort());
      required = new Set<number>();
      index++;
      continue;
    }

    let literal: string | undefined;
    let end = index + 1;
    if (character === "\\") {
      const escaped = query[index + 1];
      if (escaped && "\\^$.*+?()[]{}|/".includes(escaped)) {
        literal = escaped;
        end++;
      } else {
        end = escapeEnd(query, index);
        if (end < 0) return { alternatives: null };
      }
    } else if (character === "(" || character === "[") {
      end = character === "(" ? skipGroup(query, index) : skipClass(query, index);
      if (end < 0) return { alternatives: null };
    } else if (".^$".includes(character)) {
      // Assertions and unknown atoms cannot join two required literal runs.
    } else if (")]}*+?{".includes(character)) {
      return { alternatives: null };
    } else {
      const codePoint = query.codePointAt(index)!;
      end = index + (codePoint > 0xffff ? 2 : 1);
      literal = query.slice(index, end);
    }

    const repetition = quantifier(query, end);
    if (literal !== undefined) {
      if (repetition?.optional) flush();
      else run += literal;
      if (repetition) flush();
    } else flush();
    index = repetition?.end ?? end;
  }
  flush();
  if (!required.size) return { alternatives: null };
  alternatives.push(Uint32Array.from(required).sort());
  return { alternatives };
}
