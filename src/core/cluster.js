// DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.
/**
 * Clustering and ARR impact. Feedback items are grouped by category and title similarity (Jaccard on
 * normalised tokens) against a persistent cluster registry, so the same request from different
 * customers, and across runs, lands on the same product-feedback record. ARR is counted once per company.
 */

const STOPWORDS = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'for', 'in', 'on', 'with', 'is', 'are', 'be', 'not', 'no', 'when', 'at', 'by', 'from', 'it', 'its', 'this', 'that', 'support', 'issue', 'problem', 'request', 'feature', 'add', 'please', 'need', 'needs', 'too']);

export function tokenize(text) {
  return [...new Set(String(text ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter((word) => word && !STOPWORDS.has(word))
    .map((word) => (word.length > 5 && word.endsWith('ing') ? word.slice(0, -3) : word.length > 4 && word.endsWith('ed') ? word.slice(0, -2) : word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word)))]
    .sort();
}

export function jaccard(a, b) {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  const shared = a.filter((token) => setB.has(token)).length;
  return shared / (a.length + b.length - shared);
}

/** FNV-1a 32-bit, hex: a short stable cluster ID. */
export function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function priorityFor(metrics, config) {
  if (metrics.arrAtRisk >= config.destination.highPriorityArr && config.destination.highPriorityArr > 0) return 1;
  if (metrics.arrImpact >= config.destination.highPriorityArr && config.destination.highPriorityArr > 0) return 2;
  if (metrics.ticketCount >= 3 || metrics.maxChurnRisk >= config.arr.churnRiskThreshold) return 3;
  return 4;
}

export function clusterMetrics(cluster, config) {
  const companies = Object.values(cluster.companies);
  const scores = cluster.churnScores.length ? cluster.churnScores : [0];
  const metrics = {
    ticketCount: cluster.ticketIds.length,
    companyCount: companies.length,
    arrImpact: companies.reduce((sum, company) => sum + company.arr, 0),
    arrAtRisk: companies.filter((company) => company.maxChurnRisk >= config.arr.churnRiskThreshold).reduce((sum, company) => sum + company.arr, 0),
    avgChurnRisk: Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length),
    maxChurnRisk: Math.max(...scores),
    negativeShare: cluster.sentiments.total ? Math.round((cluster.sentiments.negative / cluster.sentiments.total) * 100) / 100 : 0,
  };
  return { ...metrics, priority: priorityFor(metrics, config) };
}

/**
 * Assigns extracted items to clusters.
 * extractions: [{ ticketId, items }]; ticketCompanies: { ticketId: [companyId] }; companyArr: { companyId: { name, arr } }.
 * Returns { registry, touched, assignments } without mutating the input registry.
 */
export function clusterFeedback({ extractions, ticketCompanies, companyArr, registry = {}, config, now }) {
  const working = JSON.parse(JSON.stringify(registry));
  const touched = new Set();
  const created = new Set();
  const assignments = [];
  for (const extraction of extractions) {
    for (const item of extraction.items) {
      if (item.category === 'other' && !config.clustering.includeOther) continue;
      const tokens = tokenize(`${item.title} ${item.productArea}`);
      let best = null;
      let bestScore = 0;
      for (const cluster of Object.values(working)) {
        if (cluster.category !== item.category) continue;
        const score = jaccard(tokens, cluster.tokens);
        if (score > bestScore) { best = cluster; bestScore = score; }
      }
      let cluster = best && bestScore >= config.clustering.similarity ? best : null;
      if (!cluster) {
        const id = `fb-${fnv1a(`${item.category}:${tokens.join(' ')}`)}`;
        cluster = working[id] || (working[id] = {
          id, category: item.category, title: item.title, productArea: item.productArea, tokens,
          ticketIds: [], companies: {}, churnScores: [], sentiments: { positive: 0, neutral: 0, negative: 0, total: 0 },
          summaries: [], destination: null, firstSeenAt: new Date(now).toISOString(), lastSeenAt: null,
        });
        if (!registry[id]) created.add(id);
      }
      if (!cluster.ticketIds.includes(extraction.ticketId)) {
        cluster.ticketIds.push(extraction.ticketId);
        cluster.churnScores.push(item.churnRiskScore);
        cluster.sentiments[item.sentiment] = (cluster.sentiments[item.sentiment] || 0) + 1;
        cluster.sentiments.total += 1;
        cluster.summaries = [item.summary, ...cluster.summaries].filter(Boolean).slice(0, 5);
      }
      for (const companyId of ticketCompanies[extraction.ticketId] || []) {
        const company = companyArr[companyId] || { name: `Company ${companyId}`, arr: 0 };
        const existing = cluster.companies[companyId] || { name: company.name, arr: 0, maxChurnRisk: 0 };
        cluster.companies[companyId] = { name: company.name, arr: company.arr, maxChurnRisk: Math.max(existing.maxChurnRisk, item.churnRiskScore) };
      }
      cluster.lastSeenAt = new Date(now).toISOString();
      touched.add(cluster.id);
      assignments.push({ ticketId: extraction.ticketId, clusterId: cluster.id });
    }
  }
  const touchedClusters = [...touched].sort().map((id) => ({ ...working[id], isNew: created.has(id), metrics: clusterMetrics(working[id], config) }));
  return { registry: working, touched: touchedClusters, assignments };
}

/** Keeps the registry within CLUSTER_REGISTRY_LIMIT, dropping the least recently seen clusters first. */
export function pruneRegistry(registry, limit) {
  const ids = Object.keys(registry);
  if (ids.length <= limit) return registry;
  const keep = ids.sort((a, b) => String(registry[b].lastSeenAt).localeCompare(String(registry[a].lastSeenAt))).slice(0, limit);
  return Object.fromEntries(keep.map((id) => [id, registry[id]]));
}
