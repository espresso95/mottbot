const VECTOR_DIMENSIONS = 256;

function normalizeToken(raw: string): string {
  return raw.trim().toLowerCase();
}

function hashToken(token: string): number {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function tokenize(text: string): string[] {
  return text
    .split(/[^\p{L}\p{N}_-]+/u)
    .map(normalizeToken)
    .filter(Boolean);
}

export function createTextEmbedding(text: string): number[] {
  const tokens = tokenize(text);
  if (tokens.length === 0) {
    return [];
  }
  const vector = new Array<number>(VECTOR_DIMENSIONS).fill(0);
  for (const token of tokens) {
    const hash = hashToken(token);
    const primaryIndex = hash % VECTOR_DIMENSIONS;
    const secondaryIndex = (((hash >>> 9) ^ (hash >>> 19)) >>> 0) % VECTOR_DIMENSIONS;
    const primarySign = (hash & 1) === 0 ? 1 : -1;
    const secondarySign = (hash & 2) === 0 ? 0.5 : -0.5;
    vector[primaryIndex] = (vector[primaryIndex] ?? 0) + primarySign;
    vector[secondaryIndex] = (vector[secondaryIndex] ?? 0) + secondarySign;
  }
  let magnitude = 0;
  for (const value of vector) {
    magnitude += value * value;
  }
  if (magnitude <= Number.EPSILON) {
    return [];
  }
  const scale = Math.sqrt(magnitude);
  return vector.map((value) => Number((value / scale).toFixed(6)));
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) {
    return 0;
  }
  let score = 0;
  for (let index = 0; index < a.length; index += 1) {
    const aValue = a[index] ?? 0;
    const bValue = b[index] ?? 0;
    score += aValue * bValue;
  }
  return score;
}
