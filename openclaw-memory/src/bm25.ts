export interface BM25Corpus {
  docs: Map<string, { tf: Map<string, number>; length: number }>;
  df: Map<string, number>;
  N: number;
  avgdl: number;
}

const K1 = 1.5;
const B = 0.75;

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(t => t.length > 1);
}

export function buildCorpus(docs: Array<{ id: string; text: string }>): BM25Corpus {
  const docMap = new Map<string, { tf: Map<string, number>; length: number }>();
  const df = new Map<string, number>();
  let totalLength = 0;

  for (const doc of docs) {
    const tokens = tokenize(doc.text);
    const tf = new Map<string, number>();
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
    docMap.set(doc.id, { tf, length: tokens.length });
    totalLength += tokens.length;
    for (const term of tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  }

  return {
    docs: docMap,
    df,
    N: docs.length,
    avgdl: docs.length > 0 ? totalLength / docs.length : 0,
  };
}

export function scoreDoc(corpus: BM25Corpus, docId: string, queryTokens: string[]): number {
  const doc = corpus.docs.get(docId);
  if (!doc) return 0;

  let score = 0;
  for (const term of queryTokens) {
    const freq = doc.tf.get(term) ?? 0;
    if (freq === 0) continue;
    const df = corpus.df.get(term) ?? 0;
    const idf = Math.log((corpus.N - df + 0.5) / (df + 0.5) + 1);
    const tfNorm = (freq * (K1 + 1)) / (freq + K1 * (1 - B + B * (doc.length / corpus.avgdl)));
    score += idf * tfNorm;
  }
  return score;
}

export function search(corpus: BM25Corpus, query: string): Array<{ id: string; score: number }> {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  const results: Array<{ id: string; score: number }> = [];
  for (const id of corpus.docs.keys()) {
    const score = scoreDoc(corpus, id, queryTokens);
    if (score > 0) results.push({ id, score });
  }
  return results.sort((a, b) => b.score - a.score);
}
