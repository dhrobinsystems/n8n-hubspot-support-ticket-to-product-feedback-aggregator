// DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.
/**
 * Destination sync (Linear, Jira, Notion), run state (watermark, processed tickets, cluster
 * registry), totals, redaction and failure alerts. Request objects never carry credentials:
 * the n8n "Destination Sync" node builds the Authorization header from $env.
 */
import { resolveDestinationTarget } from './config.js';
import { ticketUrl } from './hubspot.js';
import { pruneRegistry } from './cluster.js';

const CATEGORY_LABEL = { feature_request: 'Feature request', bug: 'Bug', churn_friction: 'Churn friction', other: 'Other' };
const PRIORITY_LABEL = { 1: 'Urgent', 2: 'High', 3: 'Medium', 4: 'Low' };

function formatMoney(value, currency) {
  return `${Math.round(value).toLocaleString('en-US')} ${currency}`;
}

export function describeCluster(cluster, config, portal) {
  const m = cluster.metrics;
  const companies = Object.values(cluster.companies).sort((a, b) => b.arr - a.arr);
  const lines = [
    `${CATEGORY_LABEL[cluster.category]} · product area: ${cluster.productArea}`,
    '',
    `ARR impact: ${formatMoney(m.arrImpact, config.arr.currency)} across ${m.companyCount} compan${m.companyCount === 1 ? 'y' : 'ies'}`,
    `ARR at risk (churn risk ≥ ${config.arr.churnRiskThreshold}): ${formatMoney(m.arrAtRisk, config.arr.currency)}`,
    `Tickets: ${m.ticketCount} · average churn risk ${m.avgChurnRisk} · max ${m.maxChurnRisk} · negative sentiment ${Math.round(m.negativeShare * 100)}%`,
    '',
    'Companies:',
    ...companies.slice(0, 15).map((company) => `- ${company.name}: ${formatMoney(company.arr, config.arr.currency)} (churn risk ${company.maxChurnRisk})`),
    '',
    'Recent ticket summaries (PII-redacted, LLM-generated):',
    ...cluster.summaries.map((summary) => `- ${summary}`),
    '',
    'HubSpot tickets:',
    ...cluster.ticketIds.slice(-20).map((id) => `- ${ticketUrl(portal, id) || `ticket ${id}`}`),
    '',
    `Maintained by the support-feedback aggregator. Cluster ${cluster.id}.`,
  ];
  return lines.join('\n');
}

function adf(text) {
  return { type: 'doc', version: 1, content: text.split('\n').map((line) => (line ? { type: 'paragraph', content: [{ type: 'text', text: line }] } : { type: 'paragraph', content: [] })) };
}

function notionProperties(cluster, includeTitle) {
  const m = cluster.metrics;
  const properties = {
    Category: { select: { name: CATEGORY_LABEL[cluster.category] } },
    'Product Area': { rich_text: [{ text: { content: cluster.productArea } }] },
    'ARR Impact': { number: m.arrImpact },
    'ARR At Risk': { number: m.arrAtRisk },
    Tickets: { number: m.ticketCount },
    Companies: { number: m.companyCount },
    'Max Churn Risk': { number: m.maxChurnRisk },
    Priority: { select: { name: PRIORITY_LABEL[m.priority] } },
  };
  if (includeTitle) properties.Name = { title: [{ text: { content: cluster.title.slice(0, 200) } }] };
  return properties;
}

const LINEAR_CREATE = 'mutation CreateFeedbackIssue($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }';
const LINEAR_UPDATE = 'mutation UpdateFeedbackIssue($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { id identifier url } } }';

/** Builds one create or update request per cluster that reached MIN_TICKETS_TO_SYNC. */
export function planDestinationSync(touched, config, portal) {
  const destination = resolveDestinationTarget(config);
  if (config.dryRun || destination.target === 'none' || !destination.container) return [];
  const d = config.destination;
  const plans = [];
  for (const cluster of touched) {
    if (cluster.metrics.ticketCount < config.clustering.minTicketsToSync) continue;
    const description = describeCluster(cluster, config, portal);
    const existing = cluster.destination && cluster.destination.target === destination.target && cluster.destination.container === destination.container ? cluster.destination : null;
    const action = existing ? 'update' : 'create';
    let request;
    if (destination.target === 'linear') {
      const input = { title: cluster.title, description, priority: cluster.metrics.priority };
      request = { method: 'POST', url: d.linear.apiUrl, body: existing ? { query: LINEAR_UPDATE, variables: { id: existing.id, input } } : { query: LINEAR_CREATE, variables: { input: { ...input, teamId: destination.container } } } };
    } else if (destination.target === 'jira') {
      request = existing
        ? { method: 'PUT', url: `${d.jira.baseUrl}/rest/api/3/issue/${encodeURIComponent(existing.key)}`, body: { fields: { description: adf(description) } } }
        : { method: 'POST', url: `${d.jira.baseUrl}/rest/api/3/issue`, body: { fields: { project: { key: destination.container }, summary: cluster.title.slice(0, 250), issuetype: { name: d.jira.issueType }, description: adf(description), labels: ['product-feedback', cluster.category.replace(/_/g, '-')] } } };
    } else {
      request = existing
        ? { method: 'PATCH', url: `${d.notion.apiUrl}/pages/${encodeURIComponent(existing.id)}`, body: { properties: notionProperties(cluster, false) } }
        : {
          method: 'POST',
          url: `${d.notion.apiUrl}/pages`,
          body: {
            parent: { database_id: destination.container },
            properties: notionProperties(cluster, true),
            children: description.split('\n').filter(Boolean).slice(0, 90).map((line) => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: line.slice(0, 1900) } }] } })),
          },
        };
    }
    plans.push({ key: cluster.id, action, target: destination.target, container: destination.container, request });
  }
  return plans;
}

/** Normalises a destination response into { key, ok, ref, error }. Jira updates answer 204 with no body. */
export function parseSyncResponse(plan, body) {
  const fail = (error) => ({ key: plan.key, action: plan.action, ok: false, ref: null, error: String(error || 'sync_failed').slice(0, 200) });
  if (body && body.error) return fail(body.error.message || body.error);
  if (plan.target === 'linear') {
    if (!body || (Array.isArray(body.errors) && body.errors.length)) return fail(body && body.errors ? body.errors[0].message : 'linear_empty_response');
    const result = body.data && (body.data.issueCreate || body.data.issueUpdate);
    if (!result || !result.success || !result.issue) return fail('linear_mutation_failed');
    return { key: plan.key, action: plan.action, ok: true, ref: { target: 'linear', container: plan.container, id: result.issue.id, key: result.issue.identifier, url: result.issue.url }, error: null };
  }
  if (plan.target === 'jira') {
    if (body && Array.isArray(body.errorMessages) && body.errorMessages.length) return fail(body.errorMessages[0]);
    if (body && body.errors && Object.keys(body.errors).length) return fail(Object.values(body.errors)[0]);
    if (plan.action === 'update') return { key: plan.key, action: plan.action, ok: true, ref: null, error: null };
    if (!body || !body.key) return fail('jira_missing_issue_key');
    return { key: plan.key, action: plan.action, ok: true, ref: { target: 'jira', container: plan.container, id: String(body.id), key: body.key, url: null }, error: null };
  }
  if (!body || body.object === 'error' || !body.id) return fail(body && body.message ? body.message : 'notion_missing_page_id');
  return { key: plan.key, action: plan.action, ok: true, ref: { target: 'notion', container: plan.container, id: body.id, key: null, url: body.url || null }, error: null };
}

export function ticketStamps(assignments, registry, syncResults) {
  const refs = Object.fromEntries(syncResults.filter((result) => result.ok && result.ref).map((result) => [result.key, result.ref]));
  const byTicket = {};
  for (const assignment of assignments) {
    const cluster = registry[assignment.clusterId];
    const ref = refs[assignment.clusterId] || (cluster && cluster.destination) || null;
    const label = `${cluster ? cluster.title : assignment.clusterId}${ref ? ` [${ref.key || ref.url || ref.id}]` : ''}`;
    (byTicket[assignment.ticketId] || (byTicket[assignment.ticketId] = [])).push(label);
  }
  return Object.entries(byTicket).map(([ticketId, labels]) => ({ ticketId, value: [...new Set(labels)].join('; ') }));
}

/**
 * Applies a successful run to persistent state: destination refs, pruned registry, processed tickets
 * and the watermark. Tickets whose extraction failed hold the watermark back so they are retried.
 */
export function commitRunState(state, { registry, syncResults, tickets, extractionResults, config }) {
  const refs = Object.fromEntries(syncResults.filter((result) => result.ok && result.ref).map((result) => [result.key, result.ref]));
  const next = JSON.parse(JSON.stringify(registry));
  for (const [id, ref] of Object.entries(refs)) if (next[id]) next[id].destination = ref;
  state.feedbackClusters = pruneRegistry(next, config.clustering.registryLimit);
  const failed = new Set(extractionResults.filter((result) => !result.ok).map((result) => result.ticketId));
  const processed = state.processedTickets || (state.processedTickets = {});
  for (const ticket of tickets) if (!failed.has(ticket.id)) processed[ticket.id] = ticket.modifiedAt;
  const failedTimes = tickets.filter((ticket) => failed.has(ticket.id)).map((ticket) => ticket.modifiedAt);
  const doneTimes = tickets.filter((ticket) => !failed.has(ticket.id)).map((ticket) => ticket.modifiedAt);
  const previous = Number(state.ticketWatermark) || 0;
  if (failedTimes.length) state.ticketWatermark = Math.max(previous, Math.min(...failedTimes));
  else if (doneTimes.length) state.ticketWatermark = Math.max(previous, ...doneTimes);
  const cutoff = (state.ticketWatermark || 0) - 30 * 86400000;
  for (const [id, at] of Object.entries(processed)) if (at < cutoff) delete processed[id];
  return state;
}

export function buildRunTotals({ tickets, extractionResults, touched, syncResults, stampResults }) {
  const items = extractionResults.reduce((sum, result) => sum + result.items.length, 0);
  return {
    ticketsScanned: tickets.length,
    extractionsOk: extractionResults.filter((result) => result.ok).length,
    extractionFailures: extractionResults.filter((result) => !result.ok).length,
    feedbackItems: items,
    clustersTouched: touched.length,
    clustersNew: touched.filter((cluster) => cluster.isNew).length,
    arrImpactTouched: touched.reduce((sum, cluster) => sum + cluster.metrics.arrImpact, 0),
    recordsCreated: syncResults.filter((result) => result.ok && result.action === 'create').length,
    recordsUpdated: syncResults.filter((result) => result.ok && result.action === 'update').length,
    syncFailures: syncResults.filter((result) => !result.ok).length,
    ticketsStamped: stampResults.filter((result) => result.ok).reduce((sum, result) => sum + (result.count || 0), 0),
    stampFailures: stampResults.filter((result) => !result.ok).length,
  };
}

export function clusterReport(cluster) {
  return { clusterId: cluster.id, category: cluster.category, title: cluster.title, productArea: cluster.productArea, isNew: cluster.isNew, ...cluster.metrics, destination: cluster.destination ? cluster.destination.key || cluster.destination.url || cluster.destination.id : null };
}

const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /Basic\s+[A-Za-z0-9+/=]{8,}/gi,
  /pat-[a-z0-9]+-[A-Za-z0-9-]+/gi,
  /\b(?:sk|lin_api|secret|ntn)_[A-Za-z0-9_-]{8,}/g,
  /https:\/\/hooks\.slack\.com\/[^\s"']+/gi,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
];

export function redactSecrets(value, extraSecrets = []) {
  let output = String(value ?? '');
  for (const secret of extraSecrets) if (secret && String(secret).length >= 6) output = output.split(String(secret)).join('[redacted]');
  for (const pattern of SECRET_PATTERNS) output = output.replace(pattern, '[redacted]');
  return output;
}

export function buildFailureAlert({ errorMessage, lastNode, executionId, workflowName, config, secrets }) {
  const message = redactSecrets(errorMessage || 'Unknown error', secrets).slice(0, 1500);
  const label = config.dryRun || config.sandboxMode ? ' [DRY RUN / SANDBOX]' : '';
  return {
    text: `Support feedback aggregator failed${label}${lastNode ? ` in "${lastNode}"` : ''}.`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Support feedback aggregator failed', emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text: `:x: Node: *${lastNode || 'unknown'}*${label}\n\`\`\`${message}\`\`\`` } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `Workflow ${workflowName || 'n8n-hubspot-support-ticket-to-product-feedback-aggregator'} · execution ${executionId || 'unknown'}` }] },
    ],
  };
}
