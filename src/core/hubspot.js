// DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.
/**
 * HubSpot side: ticket search (closed + escalated since the watermark), PII redaction, association
 * and batch reads for companies and deals, and per-ticket ARR. No network access, and no request
 * object carries the token (the n8n HTTP nodes add it from $env).
 */
import { isPlaceholder, SANDBOX_ACCOUNT_TYPES } from './config.js';

export const TICKET_PROPERTIES = Object.freeze(['subject', 'content', 'hs_pipeline', 'hs_pipeline_stage', 'hs_ticket_priority', 'hs_ticket_category', 'closed_date', 'hs_lastmodifieddate', 'createdate']);
const DAY_MS = 86400000;

export function hubspotUrl(config, path) {
  return `${config.hubspot.baseUrl}${path}`;
}

export const buildAccountDetailsRequest = (config) => ({ method: 'GET', url: hubspotUrl(config, '/account-info/v3/details') });
export const buildPipelinesRequest = (config) => ({ method: 'GET', url: hubspotUrl(config, '/crm/v3/pipelines/deals') });

export function enforceSandbox(account, config) {
  const portalId = account && account.portalId !== undefined && account.portalId !== null ? String(account.portalId) : null;
  const accountType = account && account.accountType ? String(account.accountType).toUpperCase() : null;
  const uiDomain = account && /^app(?:-[a-z0-9]+)?\.hubspot\.com$/.test(String(account.uiDomain || '')) ? account.uiDomain : 'app.hubspot.com';
  const base = { portalId, accountType, uiDomain };
  if (!config.sandboxMode) return { ok: true, ...base, reason: 'SANDBOX_MODE=false, so production portals are allowed' };
  if (accountType && SANDBOX_ACCOUNT_TYPES.includes(accountType)) return { ok: true, ...base, reason: `account type ${accountType} is a sandbox or test account` };
  if (portalId && !isPlaceholder(config.hubspot.sandboxPortalId) && portalId === config.hubspot.sandboxPortalId) return { ok: true, ...base, reason: 'portal ID matches HUBSPOT_SANDBOX_PORTAL_ID' };
  return { ok: false, ...base, reason: `SANDBOX_MODE=true, but the connected portal (account type ${accountType || 'unknown'}) is not a sandbox or developer test account and does not match HUBSPOT_SANDBOX_PORTAL_ID. I refuse to continue.` };
}

/** The search window starts at the stored watermark, or INITIAL_LOOKBACK_DAYS ago on the first run. */
export function searchWindowStart(state, config, now) {
  const watermark = Number(state && state.ticketWatermark);
  return Number.isFinite(watermark) && watermark > 0 ? watermark : now - config.tickets.initialLookbackDays * DAY_MS;
}

/**
 * POST /crm/v3/objects/tickets/search. Two OR-ed filter groups: closed since the watermark, and
 * escalated (TICKET_ESCALATION_PROPERTY in TICKET_ESCALATION_VALUES) and modified since the watermark.
 * Sorted by last modification ascending, so the watermark can advance safely past each processed batch.
 */
export function buildTicketSearchRequest(config, since) {
  const pipelineFilter = config.tickets.pipelineIds.length ? [{ propertyName: 'hs_pipeline', operator: 'IN', values: config.tickets.pipelineIds }] : [];
  const sinceValue = String(since);
  return {
    method: 'POST',
    url: hubspotUrl(config, '/crm/v3/objects/tickets/search'),
    body: {
      filterGroups: [
        { filters: [{ propertyName: 'closed_date', operator: 'GTE', value: sinceValue }, { propertyName: 'hs_lastmodifieddate', operator: 'GTE', value: sinceValue }, ...pipelineFilter] },
        { filters: [{ propertyName: config.tickets.escalationProperty, operator: 'IN', values: config.tickets.escalationValues }, { propertyName: 'hs_lastmodifieddate', operator: 'GTE', value: sinceValue }, ...pipelineFilter] },
      ],
      sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'ASCENDING' }],
      properties: [...new Set([...TICKET_PROPERTIES, config.tickets.escalationProperty])],
      limit: config.tickets.maxPerRun,
    },
  };
}

const REDACTIONS = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
  [/\b\d(?:[ -]?\d){12,18}\b/g, '[card-or-account-number]'],
  [/\+?\(?\d[\d\s().-]{7,}\d/g, '[phone]'],
  [/\bhttps?:\/\/[^\s)]+/gi, '[link]'],
  [/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '[credential]'],
  [/\b(?:api[_-]?key|password|passwd|secret|token)\s*[:=]\s*\S+/gi, '[credential]'],
  [/\b\d{3}-\d{2}-\d{4}\b/g, '[id-number]'],
];

/** Removes emails, phone and card numbers, links, credentials and ID numbers before anything reaches an LLM. */
export function redactPii(text) {
  let output = String(text ?? '');
  for (const [pattern, replacement] of REDACTIONS) output = output.replace(pattern, replacement);
  return output;
}

function stripHtml(text) {
  return String(text ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/** Normalises search results into tickets with redacted, truncated text. Already-processed tickets are dropped. */
export function parseTicketSearch(body, state, config) {
  const results = body && Array.isArray(body.results) ? body.results : [];
  const processed = (state && state.processedTickets) || {};
  const tickets = [];
  let alreadyProcessed = 0;
  for (const result of results) {
    const properties = result.properties || {};
    const modified = Date.parse(properties.hs_lastmodifieddate || result.updatedAt) || 0;
    if (processed[result.id] && processed[result.id] >= modified) { alreadyProcessed += 1; continue; }
    const raw = `${stripHtml(properties.subject)}\n\n${stripHtml(properties.content)}`.trim();
    tickets.push({
      id: String(result.id),
      subject: redactPii(stripHtml(properties.subject)).slice(0, 200),
      text: redactPii(raw).slice(0, config.tickets.maxTextChars),
      priority: properties.hs_ticket_priority || null,
      category: properties.hs_ticket_category || null,
      escalated: config.tickets.escalationValues.includes(String(properties[config.tickets.escalationProperty] ?? '')),
      closed: Boolean(properties.closed_date),
      modifiedAt: modified,
    });
  }
  return { tickets, alreadyProcessed, total: results.length, hasMore: Boolean(body && body.paging && body.paging.next) };
}

function chunk(list, size) {
  const chunks = [];
  for (let index = 0; index < list.length; index += size) chunks.push(list.slice(index, index + size));
  return chunks;
}

export function buildAssociationRequests(config, fromType, toType, ids) {
  return chunk([...new Set(ids)], 100).map((group) => ({
    method: 'POST',
    url: hubspotUrl(config, `/crm/v4/associations/${fromType}/${toType}/batch/read`),
    body: { inputs: group.map((id) => ({ id: String(id) })) },
  }));
}

/** Parses a v4 batch read into { fromId: [toId, ...] }. "No associations" errors simply mean an empty list. */
export function parseAssociations(body) {
  const map = {};
  for (const result of (body && Array.isArray(body.results) ? body.results : [])) {
    const from = String(result.from && result.from.id);
    map[from] = (result.to || []).map((entry) => String(entry.toObjectId));
  }
  return map;
}

export function buildBatchReadRequests(config, objectType, ids, properties) {
  return chunk([...new Set(ids)], 100).map((group) => ({
    method: 'POST',
    url: hubspotUrl(config, `/crm/v3/objects/${objectType}/batch/read`),
    body: { inputs: group.map((id) => ({ id: String(id) })), properties },
  }));
}

export function parseBatchRead(body) {
  const map = {};
  for (const result of (body && Array.isArray(body.results) ? body.results : [])) map[String(result.id)] = result.properties || {};
  return map;
}

export function companyProperties(config) {
  return ['name', 'domain', config.arr.companyProperty];
}

export function dealProperties(config) {
  return ['dealname', 'dealstage', 'pipeline', config.arr.dealProperty];
}

/** Closed-won stages: closed with probability 1 in GET /crm/v3/pipelines/deals. */
export function closedWonStages(pipelinesBody) {
  const won = new Set();
  for (const pipeline of (pipelinesBody && Array.isArray(pipelinesBody.results) ? pipelinesBody.results : [])) {
    for (const stage of pipeline.stages || []) {
      const metadata = stage.metadata || {};
      if (String(metadata.isClosed).toLowerCase() === 'true' && Number(metadata.probability) === 1) won.add(String(stage.id));
    }
  }
  return won;
}

function parseMoney(value) {
  const number = Number(String(value ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/**
 * Company ARR either from ARR_COMPANY_PROPERTY, or as the sum of ARR_DEAL_PROPERTY across the
 * company's closed-won deals. Returns { companyId: { name, arr, arrSource } }.
 */
export function computeCompanyArr({ companies, companyDeals = {}, deals = {}, wonStages = new Set(), config }) {
  const out = {};
  for (const [companyId, properties] of Object.entries(companies)) {
    let arr = 0;
    let arrSource = 'none';
    if (config.arr.source === 'company_property') {
      arr = parseMoney(properties[config.arr.companyProperty]);
      arrSource = arr ? 'company_property' : 'none';
    } else {
      for (const dealId of companyDeals[companyId] || []) {
        const deal = deals[dealId];
        if (deal && wonStages.has(String(deal.dealstage))) arr += parseMoney(deal[config.arr.dealProperty]);
      }
      arrSource = arr ? 'closed_won_deals' : 'none';
    }
    out[companyId] = { companyId, name: properties.name || `Company ${companyId}`, arr: Math.round(arr), arrSource };
  }
  return out;
}

export function ticketUrl(portal, ticketId) {
  if (!portal || !/^\d+$/.test(String(portal.portalId || ''))) return null;
  return `https://${portal.uiDomain || 'app.hubspot.com'}/contacts/${portal.portalId}/record/0-5/${ticketId}`;
}

/** Optional write-back: stamps processed tickets with their feedback cluster (TICKET_FEEDBACK_STAMP_PROPERTY). */
export function buildTicketStampRequests(config, stamps) {
  if (!config.tickets.stampProperty || isPlaceholder(config.tickets.stampProperty) || !stamps.length) return [];
  return chunk(stamps, 100).map((group) => ({
    method: 'POST',
    url: hubspotUrl(config, '/crm/v3/objects/tickets/batch/update'),
    body: { inputs: group.map((stamp) => ({ id: stamp.ticketId, properties: { [config.tickets.stampProperty]: stamp.value.slice(0, 500) } })) },
  }));
}
