// DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.
/**
 * Node.js mirror of workflows/support_feedback_aggregator.json: the same functions, in the same
 * order as the n8n nodes.
 */
import { isPlaceholder, resolveNow, validateAggregatorConfig } from './config.js';
import {
  buildAccountDetailsRequest, buildAssociationRequests, buildBatchReadRequests, buildPipelinesRequest, buildTicketSearchRequest, buildTicketStampRequests,
  closedWonStages, companyProperties, computeCompanyArr, dealProperties, enforceSandbox, parseAssociations, parseBatchRead, parseTicketSearch, searchWindowStart,
} from './hubspot.js';
import { buildLlmRequest, mockLlmResponse, parseExtraction } from './llm.js';
import { clusterFeedback } from './cluster.js';
import { buildRunTotals, clusterReport, commitRunState, parseSyncResponse, planDestinationSync, redactSecrets, ticketStamps } from './sync.js';
import { createMockDestinations, createMockHubSpot, DEMO_NOW } from './mocks.js';

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** fetch wrapper: retries on 429/5xx (Retry-After honoured) and returns { status, body } for every response. */
export function createHttpClient({ headers = {}, fetchImpl = globalThis.fetch, maxRetries = 3, baseDelayMs = 1000, secrets = [] }) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is not available. Use Node.js 20 or newer.');
  return async function send(req) {
    for (let attempt = 0; ; attempt += 1) {
      let response;
      try {
        response = await fetchImpl(req.url, { method: req.method, headers: { Accept: 'application/json', ...headers, ...(req.body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: req.body === undefined ? undefined : JSON.stringify(req.body) });
      } catch (error) {
        if (attempt < maxRetries) { await sleep(baseDelayMs * 2 ** attempt); continue; }
        throw new Error(redactSecrets(`Request to ${new URL(req.url).host} failed: ${error.message}`, secrets));
      }
      const raw = await response.text();
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = { message: raw.slice(0, 200) }; }
      if ((response.status === 429 || response.status >= 500) && attempt < maxRetries) {
        const retryAfter = Number(response.headers && response.headers.get ? response.headers.get('retry-after') : NaN);
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : baseDelayMs * 2 ** attempt);
        continue;
      }
      return { status: response.status, body };
    }
  };
}

function unwrap(response) {
  if (response.status >= 200 && response.status < 300) return response.body;
  const body = response.body && typeof response.body === 'object' ? response.body : {};
  return { error: { status: response.status, message: (body.error && body.error.message) || body.message || `HTTP ${response.status}` } };
}

async function required(http, request, label) {
  const response = await http(request);
  if (response.status < 200 || response.status >= 300) throw new Error(`HubSpot ${label} failed with ${response.status}`);
  return response.body;
}

async function mergeAll(http, requests, parser) {
  const merged = {};
  for (const request of requests) Object.assign(merged, parser(unwrap(await http(request))));
  return merged;
}

/** One aggregation run. `state` holds the watermark, processed tickets and the cluster registry. */
export async function processRun({ config, state = {}, hubspotHttp, llmHttp, destinationHttp, now }) {
  const gate = enforceSandbox(await required(hubspotHttp, buildAccountDetailsRequest(config), 'account check'), config);
  if (!gate.ok) throw new Error(gate.reason);
  const portal = { portalId: gate.portalId, uiDomain: gate.uiDomain };
  const wonStages = closedWonStages(await required(hubspotHttp, buildPipelinesRequest(config), 'pipeline read'));

  const since = searchWindowStart(state, config, now);
  const search = parseTicketSearch(await required(hubspotHttp, buildTicketSearchRequest(config, since), 'ticket search'), state, config);
  const tickets = search.tickets;

  const ticketCompanies = tickets.length ? await mergeAll(hubspotHttp, buildAssociationRequests(config, 'tickets', 'companies', tickets.map((ticket) => ticket.id)), parseAssociations) : {};
  const companyIds = [...new Set(Object.values(ticketCompanies).flat())];
  const companies = companyIds.length ? await mergeAll(hubspotHttp, buildBatchReadRequests(config, 'companies', companyIds, companyProperties(config)), parseBatchRead) : {};
  let companyDeals = {};
  let deals = {};
  if (config.arr.source === 'closed_won_deals' && companyIds.length) {
    companyDeals = await mergeAll(hubspotHttp, buildAssociationRequests(config, 'companies', 'deals', companyIds), parseAssociations);
    const dealIds = [...new Set(Object.values(companyDeals).flat())];
    deals = dealIds.length ? await mergeAll(hubspotHttp, buildBatchReadRequests(config, 'deals', dealIds, dealProperties(config)), parseBatchRead) : {};
  }
  const companyArr = computeCompanyArr({ companies, companyDeals, deals, wonStages, config });

  const extractionResults = [];
  for (const ticket of tickets) {
    const body = config.llm.provider === 'mock' ? mockLlmResponse(ticket, config) : unwrap(await llmHttp(buildLlmRequest(config, ticket)));
    extractionResults.push({ ticketId: ticket.id, ...parseExtraction(body, config) });
  }

  const { registry, touched, assignments } = clusterFeedback({ extractions: extractionResults.filter((result) => result.ok), ticketCompanies, companyArr, registry: state.feedbackClusters || {}, config, now });
  const syncResults = [];
  for (const plan of planDestinationSync(touched, config, portal)) syncResults.push(parseSyncResponse(plan, unwrap(await destinationHttp(plan.request))));
  const stampResults = [];
  if (!config.dryRun) {
    for (const request of buildTicketStampRequests(config, ticketStamps(assignments, registry, syncResults))) {
      const body = unwrap(await hubspotHttp(request));
      stampResults.push({ ok: !body.error, count: request.body.inputs.length, error: body.error ? body.error.message : null });
    }
    commitRunState(state, { registry, syncResults, tickets, extractionResults, config });
  }
  const totals = buildRunTotals({ tickets, extractionResults, touched, syncResults, stampResults });
  const touchedWithRefs = touched.map((cluster) => {
    const result = syncResults.find((entry) => entry.key === cluster.id && entry.ok && entry.ref);
    return result ? { ...cluster, destination: result.ref } : cluster;
  });
  return { portal, since, search: { total: search.total, alreadyProcessed: search.alreadyProcessed, hasMore: search.hasMore }, tickets, extractionResults, clusters: touchedWithRefs.map(clusterReport), syncResults, stampResults, totals, state };
}

/** Demo mode: fictional tickets behind the HubSpot mock, the mock LLM, and (when chosen) mock destinations. */
export async function runDemo({ config, state = {} }) {
  const hubspot = createMockHubSpot();
  const destinations = createMockDestinations();
  const demoConfig = { ...config, llm: { ...config.llm, provider: 'mock' } };
  const result = await processRun({ config: demoConfig, state, hubspotHttp: hubspot.request, llmHttp: async () => { throw new Error('demo mode never calls an LLM'); }, destinationHttp: destinations.request, now: Date.parse(DEMO_NOW) });
  return { ...result, hubspot, destinations };
}

function destinationHeaders(config) {
  const d = config.destination;
  if (d.target === 'linear') return { Authorization: d.linear.apiKey };
  if (d.target === 'jira') return { Authorization: `Basic ${Buffer.from(`${d.jira.email}:${d.jira.apiToken}`).toString('base64')}` };
  if (d.target === 'notion') return { Authorization: `Bearer ${d.notion.apiKey}`, 'Notion-Version': d.notion.version };
  return {};
}

/** Full run with real HTTP clients (or injected ones), after configuration validation. */
export async function runAggregator({ config, state = {}, fetchImpl = globalThis.fetch, hubspotHttp, llmHttp, destinationHttp }) {
  const { errors } = validateAggregatorConfig(config);
  if (errors.length) throw new Error(`Configuration invalid:\n- ${errors.join('\n- ')}`);
  if (config.mode === 'demo') return runDemo({ config, state });
  const secrets = [config.hubspot.token, config.llm.apiKey, config.destination.linear.apiKey, config.destination.jira.apiToken, config.destination.notion.apiKey].filter((value) => !isPlaceholder(value));
  const llmHeaders = config.llm.provider === 'anthropic' ? { 'x-api-key': config.llm.apiKey, 'anthropic-version': '2023-06-01' } : { Authorization: `Bearer ${config.llm.apiKey}` };
  return processRun({
    config,
    state,
    hubspotHttp: hubspotHttp || createHttpClient({ headers: { Authorization: `Bearer ${config.hubspot.token}` }, fetchImpl, secrets }),
    llmHttp: llmHttp || createHttpClient({ headers: llmHeaders, fetchImpl, secrets }),
    destinationHttp: destinationHttp || createHttpClient({ headers: destinationHeaders(config), fetchImpl, secrets }),
    now: resolveNow(config),
  });
}
