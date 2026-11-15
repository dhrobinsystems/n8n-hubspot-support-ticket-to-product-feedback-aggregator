// DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.
/**
 * Configuration for the support-ticket → product-feedback aggregator. Every switch fails safe:
 * - DRY_RUN and SANDBOX_MODE stay on unless explicitly set to false/0/no/off.
 * - A placeholder HubSpot token puts the aggregator in demo mode (fictional tickets, no network).
 * - LLM_PROVIDER defaults to "mock" (a local keyword extractor), so no ticket text leaves the
 *   workflow until an LLM is configured on purpose. Ticket text is always PII-redacted first.
 * - FEEDBACK_DESTINATION defaults to "none" (preview only).
 * - DRY_RUN blocks every external write and leaves the watermark and cluster registry untouched.
 */

export const DEFAULT_HUBSPOT_BASE_URL = 'https://api.hubapi.com';
export const SANDBOX_ACCOUNT_TYPES = Object.freeze(['SANDBOX', 'DEVELOPER_TEST']);
export const LLM_PROVIDERS = Object.freeze(['mock', 'openai', 'anthropic']);
export const DESTINATIONS = Object.freeze(['none', 'linear', 'jira', 'notion']);
export const ARR_SOURCES = Object.freeze(['company_property', 'closed_won_deals']);
export const CATEGORIES = Object.freeze(['feature_request', 'bug', 'churn_friction', 'other']);

const DEFAULT_LLM_URLS = { openai: 'https://api.openai.com/v1/chat/completions', anthropic: 'https://api.anthropic.com/v1/messages' };
const PLACEHOLDER_PATTERN = /^(?:|your_[a-z0-9_]+|changeme|change_me|placeholder|x{3,})$/i;
const EMBEDDED_PLACEHOLDER_PATTERN = /YOUR_[A-Z0-9_]{3,}/;
const PROPERTY_NAME_PATTERN = /^[a-z][a-z0-9_]{0,99}$/;

/** True for empty values and template placeholders such as YOUR_HUBSPOT_PRIVATE_APP_TOKEN. */
export function isPlaceholder(value) {
  if (value === undefined || value === null) return true;
  const text = String(value).trim();
  return PLACEHOLDER_PATTERN.test(text) || EMBEDDED_PLACEHOLDER_PATTERN.test(text);
}

/** Only recognised true/false words change a switch; anything else keeps the safe fallback. */
export function readBooleanEnv(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const text = String(value).trim().toLowerCase();
  if (text === '') return fallback;
  if (['false', '0', 'no', 'off'].includes(text)) return false;
  if (['true', '1', 'yes', 'on'].includes(text)) return true;
  return fallback;
}

function readList(value) {
  if (value === undefined || value === null || isPlaceholder(value)) return [];
  return String(value).split(',').map((entry) => entry.trim()).filter(Boolean);
}

function readNumber(raw, fallback, { min, max, integer = true }, name, problems) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const number = Number(String(raw).trim());
  if (!Number.isFinite(number) || (integer && !Number.isInteger(number)) || number < min || number > max) {
    problems.push(`${name} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max} (received "${raw}")`);
    return fallback;
  }
  return number;
}

function readChoice(raw, fallback, choices, name, problems) {
  const value = String(raw === undefined || raw === null || String(raw).trim() === '' ? fallback : raw).trim().toLowerCase();
  if (!choices.includes(value)) {
    problems.push(`${name} must be one of ${choices.join(', ')} (received "${raw}")`);
    return fallback;
  }
  return value;
}

/** Builds runtime configuration from n8n `$env` or `process.env`. options.forceMode pins "demo" or "hubspot". */
export function loadAggregatorConfig(env = {}, options = {}) {
  const source = env || {};
  const problems = [];
  const read = (name) => {
    const value = source[name];
    return value === undefined || value === null ? undefined : String(value).trim();
  };
  const token = read('HUBSPOT_PRIVATE_APP_TOKEN') || '';
  const llmProvider = readChoice(read('LLM_PROVIDER'), 'mock', LLM_PROVIDERS, 'LLM_PROVIDER', problems);
  const config = {
    mode: options.forceMode || (isPlaceholder(token) ? 'demo' : 'hubspot'),
    dryRun: readBooleanEnv(read('DRY_RUN'), true),
    sandboxMode: readBooleanEnv(read('SANDBOX_MODE'), true),
    hubspot: {
      token,
      baseUrl: (read('HUBSPOT_BASE_URL') || DEFAULT_HUBSPOT_BASE_URL).replace(/\/+$/, ''),
      sandboxPortalId: read('HUBSPOT_SANDBOX_PORTAL_ID') || '',
    },
    tickets: {
      escalationProperty: read('TICKET_ESCALATION_PROPERTY') || 'hs_ticket_priority',
      escalationValues: readList(read('TICKET_ESCALATION_VALUES')).length ? readList(read('TICKET_ESCALATION_VALUES')) : ['HIGH', 'URGENT'],
      pipelineIds: readList(read('TICKET_PIPELINE_IDS')),
      maxPerRun: readNumber(read('MAX_TICKETS_PER_RUN'), 50, { min: 1, max: 100 }, 'MAX_TICKETS_PER_RUN', problems),
      initialLookbackDays: readNumber(read('INITIAL_LOOKBACK_DAYS'), 7, { min: 1, max: 365 }, 'INITIAL_LOOKBACK_DAYS', problems),
      maxTextChars: readNumber(read('MAX_TICKET_TEXT_CHARS'), 4000, { min: 200, max: 20000 }, 'MAX_TICKET_TEXT_CHARS', problems),
      stampProperty: read('TICKET_FEEDBACK_STAMP_PROPERTY') || '',
    },
    arr: {
      source: readChoice(read('ARR_SOURCE'), 'company_property', ARR_SOURCES, 'ARR_SOURCE', problems),
      companyProperty: read('ARR_COMPANY_PROPERTY') || 'annual_recurring_revenue',
      dealProperty: read('ARR_DEAL_PROPERTY') || 'amount',
      churnRiskThreshold: readNumber(read('CHURN_RISK_THRESHOLD'), 60, { min: 0, max: 100 }, 'CHURN_RISK_THRESHOLD', problems),
      currency: read('ARR_CURRENCY') || 'USD',
    },
    llm: {
      provider: llmProvider,
      apiKey: read('LLM_API_KEY') || '',
      model: read('LLM_MODEL') || '',
      apiUrl: (read('LLM_API_URL') || DEFAULT_LLM_URLS[llmProvider] || '').replace(/\/+$/, ''),
      maxItemsPerTicket: readNumber(read('LLM_MAX_ITEMS_PER_TICKET'), 3, { min: 1, max: 10 }, 'LLM_MAX_ITEMS_PER_TICKET', problems),
      maxTokens: readNumber(read('LLM_MAX_TOKENS'), 800, { min: 200, max: 4000 }, 'LLM_MAX_TOKENS', problems),
    },
    clustering: {
      similarity: readNumber(read('CLUSTER_SIMILARITY'), 0.5, { min: 0.1, max: 1, integer: false }, 'CLUSTER_SIMILARITY', problems),
      registryLimit: readNumber(read('CLUSTER_REGISTRY_LIMIT'), 2000, { min: 50, max: 20000 }, 'CLUSTER_REGISTRY_LIMIT', problems),
      minTicketsToSync: readNumber(read('MIN_TICKETS_TO_SYNC'), 1, { min: 1, max: 100 }, 'MIN_TICKETS_TO_SYNC', problems),
      includeOther: readBooleanEnv(read('SYNC_OTHER_CATEGORY'), false),
    },
    destination: {
      target: readChoice(read('FEEDBACK_DESTINATION'), 'none', DESTINATIONS, 'FEEDBACK_DESTINATION', problems),
      highPriorityArr: readNumber(read('HIGH_PRIORITY_ARR'), 50000, { min: 0, max: 1e12, integer: false }, 'HIGH_PRIORITY_ARR', problems),
      linear: { apiKey: read('LINEAR_API_KEY') || '', teamId: read('LINEAR_TEAM_ID') || '', sandboxTeamId: read('LINEAR_SANDBOX_TEAM_ID') || '', apiUrl: read('LINEAR_API_URL') || 'https://api.linear.app/graphql' },
      jira: { baseUrl: (read('JIRA_BASE_URL') || '').replace(/\/+$/, ''), email: read('JIRA_EMAIL') || '', apiToken: read('JIRA_API_TOKEN') || '', projectKey: read('JIRA_PROJECT_KEY') || '', sandboxProjectKey: read('JIRA_SANDBOX_PROJECT_KEY') || '', issueType: read('JIRA_ISSUE_TYPE') || 'Task' },
      notion: { apiKey: read('NOTION_API_KEY') || '', databaseId: read('NOTION_DATABASE_ID') || '', sandboxDatabaseId: read('NOTION_SANDBOX_DATABASE_ID') || '', apiUrl: read('NOTION_API_URL') || 'https://api.notion.com/v1', version: read('NOTION_VERSION') || '2022-06-28' },
    },
    alerts: { webhookUrl: read('ALERT_WEBHOOK_URL') || '' },
    nowOverride: read('AGGREGATOR_NOW') || null,
    problems,
  };
  if (config.nowOverride && !Number.isFinite(Date.parse(config.nowOverride))) problems.push(`AGGREGATOR_NOW must be an ISO 8601 timestamp (received "${config.nowOverride}")`);
  return config;
}

export function isLiveMode(config) {
  return !config.dryRun && !config.sandboxMode;
}

export function resolveNow(config) {
  const parsed = config.nowOverride ? Date.parse(config.nowOverride) : NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

export function alertsEnabled(config) {
  return !isPlaceholder(config.alerts.webhookUrl) && /^https:\/\//.test(config.alerts.webhookUrl);
}

/** The destination container for this run: production when live, the sandbox container otherwise, or none. */
export function resolveDestinationTarget(config) {
  const target = config.destination.target;
  const live = isLiveMode(config);
  const pick = (production, sandbox) => {
    const value = live ? production : sandbox;
    return isPlaceholder(value) ? null : value;
  };
  if (target === 'linear') return { target, container: pick(config.destination.linear.teamId, config.destination.linear.sandboxTeamId) };
  if (target === 'jira') return { target, container: pick(config.destination.jira.projectKey, config.destination.jira.sandboxProjectKey) };
  if (target === 'notion') return { target, container: pick(config.destination.notion.databaseId, config.destination.notion.sandboxDatabaseId) };
  return { target: 'none', container: null };
}

export function describeSafety(config) {
  const destination = resolveDestinationTarget(config);
  return {
    mode: config.mode,
    dryRun: config.dryRun,
    sandboxMode: config.sandboxMode,
    llmProvider: config.llm.provider,
    destination: destination.target,
    destinationWrites: !config.dryRun && destination.target !== 'none' && Boolean(destination.container),
  };
}

/** Returns { errors, warnings }. Any error stops the workflow before it touches HubSpot, the LLM or the destination. */
export function validateAggregatorConfig(config) {
  const errors = [...config.problems];
  const warnings = [];
  const live = isLiveMode(config);
  const d = config.destination;

  if (!PROPERTY_NAME_PATTERN.test(config.tickets.escalationProperty)) errors.push('TICKET_ESCALATION_PROPERTY is not a valid HubSpot property name');
  if (config.tickets.stampProperty && !isPlaceholder(config.tickets.stampProperty) && !PROPERTY_NAME_PATTERN.test(config.tickets.stampProperty)) errors.push('TICKET_FEEDBACK_STAMP_PROPERTY is not a valid HubSpot property name');
  for (const name of [config.arr.companyProperty, config.arr.dealProperty]) if (!PROPERTY_NAME_PATTERN.test(name)) errors.push(`ARR property "${name}" is not a valid HubSpot property name`);

  if (config.llm.provider !== 'mock') {
    if (isPlaceholder(config.llm.apiKey)) errors.push(`LLM_PROVIDER=${config.llm.provider} needs LLM_API_KEY`);
    if (isPlaceholder(config.llm.model)) errors.push(`LLM_PROVIDER=${config.llm.provider} needs LLM_MODEL`);
    if (!/^https:\/\//.test(config.llm.apiUrl)) errors.push('LLM_API_URL must use https://');
  }
  if (d.target === 'linear' && isPlaceholder(d.linear.apiKey)) errors.push('FEEDBACK_DESTINATION=linear needs LINEAR_API_KEY');
  if (d.target === 'jira') {
    if (!/^https:\/\/[^/]+$/.test(d.jira.baseUrl) || isPlaceholder(d.jira.baseUrl)) errors.push('FEEDBACK_DESTINATION=jira needs JIRA_BASE_URL like https://your-site.atlassian.net');
    if (isPlaceholder(d.jira.email) || isPlaceholder(d.jira.apiToken)) errors.push('FEEDBACK_DESTINATION=jira needs JIRA_EMAIL and JIRA_API_TOKEN');
  }
  if (d.target === 'notion' && isPlaceholder(d.notion.apiKey)) errors.push('FEEDBACK_DESTINATION=notion needs NOTION_API_KEY');
  if (!isPlaceholder(config.alerts.webhookUrl) && !/^https:\/\//.test(config.alerts.webhookUrl)) errors.push('ALERT_WEBHOOK_URL must use https://');
  const destination = resolveDestinationTarget(config);
  if (d.target !== 'none' && !destination.container) {
    if (live) errors.push(`Live mode with FEEDBACK_DESTINATION=${d.target} needs its production team/project/database ID`);
    else warnings.push(`FEEDBACK_DESTINATION=${d.target} has no sandbox team/project/database ID, so sync is preview-only.`);
  }

  if (config.mode === 'demo') {
    if (live) errors.push('Live mode (DRY_RUN=false and SANDBOX_MODE=false) needs a real HUBSPOT_PRIVATE_APP_TOKEN. Replace the placeholder or turn DRY_RUN back on.');
    warnings.push('HUBSPOT_PRIVATE_APP_TOKEN is a placeholder, so the aggregator runs against bundled fictional tickets and makes no network calls.');
    return { errors, warnings };
  }
  if (!/^https:\/\//.test(config.hubspot.baseUrl)) errors.push('HUBSPOT_BASE_URL must use https://');
  if (!isPlaceholder(config.hubspot.sandboxPortalId) && !/^\d+$/.test(config.hubspot.sandboxPortalId)) errors.push('HUBSPOT_SANDBOX_PORTAL_ID must be numeric when set');
  if (config.llm.provider === 'mock') {
    if (live) errors.push('LLM_PROVIDER=mock uses a keyword extractor meant for demos and tests; configure a real LLM for live mode');
    else warnings.push('LLM_PROVIDER=mock: feedback is extracted with a simple keyword model.');
  }
  if (live && !alertsEnabled(config)) warnings.push('Live mode without ALERT_WEBHOOK_URL: failures are only visible in the n8n execution log.');
  return { errors, warnings };
}
