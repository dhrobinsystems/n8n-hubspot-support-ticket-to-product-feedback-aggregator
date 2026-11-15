#!/usr/bin/env node
// DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.
/**
 * Generates workflows/support_feedback_aggregator.json from src/core/*.js. Each Code node receives
 * the core modules it needs (imports and `export` stripped) plus a short block of node logic; HTTP
 * Request nodes execute the requests those Code nodes plan. Secrets are only read from $env inside
 * node expressions.
 *
 *   npm run build:workflow     regenerate
 *   npm run check:workflow     fail when the workflow JSON is out of date
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const WORKFLOW_PATH = join(ROOT, 'workflows', 'support_feedback_aggregator.json');
export const WORKFLOW_NAME = 'n8n-hubspot-support-ticket-to-product-feedback-aggregator';
export const LICENSE_LINE = 'DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.';

export const NODE = Object.freeze({
  schedule: 'Schedule: Every 6 Hours',
  manual: 'Manual Run',
  load: 'Load Config & Plan Ticket Search',
  isDemo: 'Demo Mode?',
  demo: 'Run Demo Aggregation',
  account: 'HubSpot: Get Account Details',
  enforce: 'Enforce Sandbox',
  pipelines: 'HubSpot: Get Deal Pipelines',
  search: 'HubSpot: Search Closed & Escalated Tickets',
  prepare: 'Prepare Tickets (Redact PII)',
  found: 'Tickets Found?',
  needAssoc: 'Company Associations Needed?',
  assoc: 'HubSpot: Ticket → Company Associations',
  tagAssoc: 'Tag Ticket Associations',
  planCompanies: 'Plan Company Reads',
  needCompanies: 'Company Reads Needed?',
  companies: 'HubSpot: Read Companies (ARR)',
  tagCompanies: 'Tag Company Reads',
  planCompanyDeals: 'Plan Company → Deal Lookups',
  needCompanyDeals: 'Deal Lookups Needed?',
  companyDeals: 'HubSpot: Company → Deal Associations',
  tagCompanyDeals: 'Tag Company Deal Associations',
  planDeals: 'Plan Deal Reads',
  needDeals: 'Deal Reads Needed?',
  deals: 'HubSpot: Read Deals (ARR)',
  tagDeals: 'Tag Deal Reads',
  planLlm: 'Compute ARR & Plan LLM Extraction',
  needLlm: 'LLM Calls Needed?',
  isAnthropic: 'Anthropic Provider?',
  llmAnthropic: 'LLM: Anthropic Messages',
  llmOpenAi: 'LLM: OpenAI-Compatible Chat',
  tagLlm: 'Tag LLM Responses',
  cluster: 'Cluster Feedback & ARR Impact',
  planSync: 'Destination Router (Linear / Jira / Notion)',
  needSync: 'Destination Sync Needed?',
  sync: 'Destination: Create or Update Feedback Record',
  tagSync: 'Tag Destination Results',
  planStamps: 'Plan Ticket Stamps',
  needStamps: 'Ticket Stamps Needed?',
  stamp: 'HubSpot: Stamp Tickets',
  tagStamps: 'Tag Stamp Results',
  finalize: 'Finalize Run',
  errorTrigger: 'On Workflow Error',
  buildFailure: 'Build Redacted Failure Alert',
  needFailure: 'Failure Alert Enabled?',
  sendFailure: 'Send Failure Alert',
  note: 'Read Me: Safety Defaults',
});

const MODULES = {
  config: 'src/core/config.js',
  hubspot: 'src/core/hubspot.js',
  llm: 'src/core/llm.js',
  cluster: 'src/core/cluster.js',
  sync: 'src/core/sync.js',
  mocks: 'src/core/mocks.js',
  pipeline: 'src/core/pipeline.js',
};
const HUB = ['config', 'hubspot'];
const LLM = ['config', 'hubspot', 'llm'];
const SYNC = ['config', 'hubspot', 'cluster', 'sync'];
const ALL = Object.keys(MODULES);

export function stripModuleSyntax(source) {
  return source
    .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];[ \t]*\r?\n/gm, '')
    .replace(/^export\s+(?=(?:async\s+)?function|const|let|class)/gm, '')
    .replace(new RegExp(`^// ${LICENSE_LINE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\r?\\n`, 'm'), '');
}

function topLevelNames(source) {
  const names = [];
  const pattern = /^(?:async\s+)?(?:function\s*\*?\s*([A-Za-z_$][\w$]*)|(?:const|let|class)\s+([A-Za-z_$][\w$]*))/gm;
  let match;
  while ((match = pattern.exec(source))) names.push(match[1] || match[2]);
  return names;
}

const HELPERS = `
// ---- n8n node helpers ----
function nodeOutputs(name) {
  try {
    const reference = $(name);
    if (reference && reference.isExecuted === false) return [];
    return reference.all().map((item) => item.json);
  } catch (error) {
    return [];
  }
}
function firstOutput(name) {
  const outputs = nodeOutputs(name);
  return outputs.length ? outputs[0] : null;
}
function countPlanned(name) {
  return nodeOutputs(name).filter((json) => !json.skip).length;
}
function assertStageComplete(stage, expected, received) {
  if (expected !== received) throw new Error('Feedback aggregator stopped: the ' + stage + ' stage planned ' + expected + ' request(s) but received ' + received + ' response(s).');
}
function runNow() {
  const loaded = firstOutput(${JSON.stringify(NODE.load)});
  const parsed = loaded ? Date.parse(loaded.now) : NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}
function planItems(stage, plans, meta) {
  if (!plans.length) return [{ json: { stage, skip: true, ...(meta ? { meta } : {}) } }];
  return plans.map((plan) => ({ json: { stage, ...plan, ...(meta ? { meta } : {}) }, pairedItem: { item: 0 } }));
}
function mergeTagged(name) {
  return Object.assign({}, ...nodeOutputs(name).map((json) => json.map || {}));
}
function stageTickets() {
  const prepared = firstOutput(${JSON.stringify(NODE.prepare)});
  return prepared ? prepared.meta.tickets : [];
}
`;

export function embed(moduleKeys, logic) {
  const seen = new Map();
  const parts = [];
  for (const key of moduleKeys) {
    const source = stripModuleSyntax(readFileSync(join(ROOT, MODULES[key]), 'utf8'));
    for (const name of topLevelNames(source)) {
      if (seen.has(name)) throw new Error(`Top-level name "${name}" is declared in both ${seen.get(name)} and ${MODULES[key]}`);
      seen.set(name, MODULES[key]);
    }
    parts.push(`// ---- ${MODULES[key]} (embedded by scripts/build-workflow.js) ----\n${source.trim()}\n`);
  }
  for (const name of [...topLevelNames(HELPERS), ...topLevelNames(logic.trim())]) if (seen.has(name)) throw new Error(`"${name}" collides with ${seen.get(name)}`);
  return [`// ${LICENSE_LINE}`, '// Generated by scripts/build-workflow.js. Edit src/core and rebuild instead of editing here.', ...parts, HELPERS.trim(), '', '// ---- node logic ----', logic.trim(), ''].join('\n');
}

const N = (name) => JSON.stringify(NODE[name]);
const mapTag = (parser) => `return $input.all().map((item, index) => ({ json: { map: ${parser}(item.json) }, pairedItem: { item: index } }));`;

const LOGIC = {
  load: `
const config = loadAggregatorConfig($env);
const { errors, warnings } = validateAggregatorConfig(config);
if (errors.length) throw new Error('Configuration invalid:\\n- ' + errors.join('\\n- '));
const now = resolveNow(config);
const since = searchWindowStart($getWorkflowStaticData('global'), config, now);
return [{ json: { mode: config.mode, now: new Date(now).toISOString(), since, safety: describeSafety(config), warnings, request: buildAccountDetailsRequest(config), searchRequest: buildTicketSearchRequest(config, since) } }];`,
  demo: `
const config = loadAggregatorConfig($env);
const staticData = $getWorkflowStaticData('global');
const demoState = staticData.demoState || (staticData.demoState = {});
const result = await runDemo({ config, state: demoState });
return [{ json: { source: 'demo', totals: result.totals, clusters: result.clusters, search: result.search, since: result.since } }];`,
  enforce: `
const config = loadAggregatorConfig($env);
const gate = enforceSandbox($input.first().json, config);
if (!gate.ok) throw new Error(gate.reason);
return [{ json: { portal: { portalId: gate.portalId, uiDomain: gate.uiDomain }, pipelinesRequest: buildPipelinesRequest(config) } }];`,
  prepare: `
const config = loadAggregatorConfig($env);
const search = parseTicketSearch($input.first().json, $getWorkflowStaticData('global'), config);
const meta = { tickets: search.tickets, search: { total: search.total, alreadyProcessed: search.alreadyProcessed, hasMore: search.hasMore } };
const hasTickets = search.tickets.length ? 'yes' : 'no';
const plans = buildAssociationRequests(config, 'tickets', 'companies', search.tickets.map((ticket) => ticket.id)).map((request) => ({ request }));
return planItems('ticket_companies', plans, meta).map((item) => ({ ...item, json: { ...item.json, hasTickets } }));`,
  tagAssoc: mapTag('parseAssociations'),
  planCompanies: `
const config = loadAggregatorConfig($env);
const tagged = nodeOutputs(${N('tagAssoc')});
assertStageComplete('ticket association', countPlanned(${N('prepare')}), tagged.length);
const companyIds = [...new Set(Object.values(mergeTagged(${N('tagAssoc')})).flat())];
return planItems('companies', buildBatchReadRequests(config, 'companies', companyIds, companyProperties(config)).map((request) => ({ request })));`,
  tagCompanies: mapTag('parseBatchRead'),
  planCompanyDeals: `
const config = loadAggregatorConfig($env);
assertStageComplete('company read', countPlanned(${N('planCompanies')}), nodeOutputs(${N('tagCompanies')}).length);
const companyIds = Object.keys(mergeTagged(${N('tagCompanies')}));
const plans = config.arr.source === 'closed_won_deals' ? buildAssociationRequests(config, 'companies', 'deals', companyIds).map((request) => ({ request })) : [];
return planItems('company_deals', plans);`,
  tagCompanyDeals: mapTag('parseAssociations'),
  planDeals: `
const config = loadAggregatorConfig($env);
assertStageComplete('company deal association', countPlanned(${N('planCompanyDeals')}), nodeOutputs(${N('tagCompanyDeals')}).length);
const dealIds = [...new Set(Object.values(mergeTagged(${N('tagCompanyDeals')})).flat())];
return planItems('deals', buildBatchReadRequests(config, 'deals', dealIds, dealProperties(config)).map((request) => ({ request })));`,
  tagDeals: mapTag('parseBatchRead'),
  planLlm: `
const config = loadAggregatorConfig($env);
assertStageComplete('deal read', countPlanned(${N('planDeals')}), nodeOutputs(${N('tagDeals')}).length);
const companyArr = computeCompanyArr({
  companies: mergeTagged(${N('tagCompanies')}),
  companyDeals: mergeTagged(${N('tagCompanyDeals')}),
  deals: mergeTagged(${N('tagDeals')}),
  wonStages: closedWonStages(firstOutput(${N('pipelines')})),
  config,
});
const tickets = stageTickets();
const meta = { companyArr, ticketCompanies: mergeTagged(${N('tagAssoc')}), mockResponses: {} };
if (config.llm.provider === 'mock') {
  for (const ticket of tickets) meta.mockResponses[ticket.id] = mockLlmResponse(ticket, config);
  return planItems('llm', [], meta);
}
return planItems('llm', tickets.map((ticket) => ({ ticketId: ticket.id, request: buildLlmRequest(config, ticket) })), meta);`,
  tagLlm: `
return $input.all().map((item, index) => ({ json: { ticketId: $(${N('planLlm')}).itemMatching(index).json.ticketId, body: item.json }, pairedItem: { item: index } }));`,
  cluster: `
const config = loadAggregatorConfig($env);
const planned = nodeOutputs(${N('planLlm')});
const tagged = nodeOutputs(${N('tagLlm')});
assertStageComplete('LLM extraction', countPlanned(${N('planLlm')}), tagged.length);
const meta = planned[0].meta;
const bodies = { ...meta.mockResponses };
for (const tag of tagged) bodies[tag.ticketId] = tag.body;
const extractionResults = stageTickets().map((ticket) => ({ ticketId: ticket.id, ...parseExtraction(bodies[ticket.id], config) }));
const clustered = clusterFeedback({
  extractions: extractionResults.filter((result) => result.ok),
  ticketCompanies: meta.ticketCompanies,
  companyArr: meta.companyArr,
  registry: $getWorkflowStaticData('global').feedbackClusters || {},
  config,
  now: runNow(),
});
return [{ json: { extractionResults, ...clustered } }];`,
  planSync: `
const config = loadAggregatorConfig($env);
const { touched } = firstOutput(${N('cluster')});
return planItems('sync', planDestinationSync(touched, config, firstOutput(${N('enforce')}).portal));`,
  tagSync: `
return $input.all().map((item, index) => ({ json: parseSyncResponse($(${N('planSync')}).itemMatching(index).json, item.json), pairedItem: { item: index } }));`,
  planStamps: `
const config = loadAggregatorConfig($env);
const syncResults = nodeOutputs(${N('tagSync')});
assertStageComplete('destination sync', countPlanned(${N('planSync')}), syncResults.length);
const { assignments, registry } = firstOutput(${N('cluster')});
const requests = config.dryRun ? [] : buildTicketStampRequests(config, ticketStamps(assignments, registry, syncResults));
return planItems('stamps', requests.map((request) => ({ count: request.body.inputs.length, request })));`,
  tagStamps: `
return $input.all().map((item, index) => ({ json: { ok: !item.json.error, count: $(${N('planStamps')}).itemMatching(index).json.count, error: item.json.error ? String(item.json.error.message || item.json.error) : null }, pairedItem: { item: index } }));`,
  finalize: `
const config = loadAggregatorConfig($env);
const loaded = firstOutput(${N('load')});
const demo = firstOutput(${N('demo')});
if (demo) return [{ json: { safety: loaded.safety, source: 'demo', since: new Date(demo.since).toISOString(), search: demo.search, totals: demo.totals, clusters: demo.clusters } }];
const prepared = firstOutput(${N('prepare')});
const tickets = stageTickets();
const clustered = firstOutput(${N('cluster')}) || { extractionResults: [], registry: $getWorkflowStaticData('global').feedbackClusters || {}, touched: [], assignments: [] };
const syncResults = nodeOutputs(${N('tagSync')});
const stampResults = nodeOutputs(${N('tagStamps')});
assertStageComplete('ticket stamp', countPlanned(${N('planStamps')}), stampResults.length);
const staticData = $getWorkflowStaticData('global');
if (!config.dryRun) commitRunState(staticData, { registry: clustered.registry, syncResults, tickets, extractionResults: clustered.extractionResults, config });
const totals = buildRunTotals({ tickets, extractionResults: clustered.extractionResults, touched: clustered.touched, syncResults, stampResults });
const refs = Object.fromEntries(syncResults.filter((result) => result.ok && result.ref).map((result) => [result.key, result.ref]));
const clusters = clustered.touched.map((cluster) => clusterReport(refs[cluster.id] ? { ...cluster, destination: refs[cluster.id] } : cluster));
const problems = [];
if (totals.syncFailures) problems.push(totals.syncFailures + ' destination sync(s) failed: ' + syncResults.filter((r) => !r.ok).map((r) => r.error).slice(0, 3).join(' | '));
if (totals.stampFailures) problems.push(totals.stampFailures + ' ticket stamp batch(es) failed');
if (tickets.length && !totals.extractionsOk) problems.push('every LLM extraction failed (' + (clustered.extractionResults[0] || {}).error + ')');
if (problems.length) throw new Error(problems.join('; ') + '. Successful writes were kept; failed tickets are retried next run.');
return [{ json: { safety: loaded.safety, source: 'hubspot', since: new Date(loaded.since).toISOString(), search: prepared ? prepared.meta.search : null, totals, clusters, extractionFailures: clustered.extractionResults.filter((r) => !r.ok).map((r) => ({ ticketId: r.ticketId, error: r.error })) } }];`,
  buildFailure: `
const config = loadAggregatorConfig($env);
const data = $input.first().json || {};
const execution = data.execution || {};
const message = buildFailureAlert({
  errorMessage: execution.error && execution.error.message,
  lastNode: execution.lastNodeExecuted,
  executionId: execution.id,
  workflowName: data.workflow && data.workflow.name,
  config,
  secrets: [config.hubspot.token, config.llm.apiKey, config.destination.linear.apiKey, config.destination.jira.apiToken, config.destination.notion.apiKey],
});
return [{ json: { send: alertsEnabled(config) ? 'yes' : 'no', message } }];`,
};

function nodeId(name) {
  const hex = createHash('sha256').update(`${WORKFLOW_NAME}:${name}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function code(name, position, modules, logic, notes) {
  return { parameters: { mode: 'runOnceForAllItems', jsCode: embed(modules, logic) }, id: nodeId(name), name, type: 'n8n-nodes-base.code', typeVersion: 2, position, ...(notes ? { notes, notesInFlow: false } : {}) };
}

function condition(name, position, leftValue, rightValue) {
  return {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        conditions: [{ id: nodeId(`${name}:condition`), leftValue, rightValue, operator: { type: 'string', operation: 'equals' } }],
        combinator: 'and',
      },
      options: {},
    },
    id: nodeId(name), name, type: 'n8n-nodes-base.if', typeVersion: 2, position,
  };
}

const skipIf = (name, position) => condition(name, position, "={{ $json.skip ? 'skip' : 'run' }}", 'run');

function http(name, position, { method, url, headers = [], body, continueOnError = true, batching = null, retries = 3, notes }) {
  const parameters = { method, url, options: { timeout: 60000 } };
  if (headers.length) { parameters.sendHeaders = true; parameters.headerParameters = { parameters: headers.map(([headerName, value]) => ({ name: headerName, value })) }; }
  if (body) { parameters.sendBody = true; parameters.specifyBody = 'json'; parameters.jsonBody = body; }
  if (batching) parameters.options.batching = { batch: batching };
  return {
    parameters, id: nodeId(name), name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position,
    retryOnFail: true, maxTries: retries, waitBetweenTries: 3000,
    ...(continueOnError ? { onError: 'continueRegularOutput' } : {}),
    ...(notes ? { notes, notesInFlow: false } : {}),
  };
}

const HUBSPOT_AUTH = ['Authorization', '=Bearer {{ $env.HUBSPOT_PRIVATE_APP_TOKEN }}'];
const BODY = '={{ JSON.stringify($json.request.body) }}';
const URL = '={{ $json.request.url }}';
const DESTINATION_AUTH = ['Authorization', "={{ $env.FEEDBACK_DESTINATION === 'linear' ? $env.LINEAR_API_KEY : $env.FEEDBACK_DESTINATION === 'jira' ? 'Basic ' + ($env.JIRA_EMAIL + ':' + $env.JIRA_API_TOKEN).base64Encode() : 'Bearer ' + $env.NOTION_API_KEY }}"];
const NOTION_VERSION = ['Notion-Version', "={{ $env.NOTION_VERSION || '2022-06-28' }}"];

const STICKY = `## Support feedback aggregator: safety defaults
- **Demo mode** while HUBSPOT_PRIVATE_APP_TOKEN is a placeholder: fictional tickets, mock LLM, no network.
- **LLM_PROVIDER=mock** by default; ticket text is PII-redacted before any LLM call.
- **DRY_RUN=true**: extracts and clusters, writes nothing, leaves the watermark and registry untouched.
- **SANDBOX_MODE=true**: refuses production portals; syncs only to the sandbox Linear team / Jira project / Notion database.
- Failed extractions hold the watermark back and are retried. Failure alerts are redacted.

${LICENSE_LINE}`;

export function buildWorkflow() {
  const x = (column) => column * 220;
  const row = 360;
  const nodes = [
    { parameters: { rule: { interval: [{ field: 'cronExpression', expression: '0 */6 * * *' }] } }, id: nodeId(NODE.schedule), name: NODE.schedule, type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [x(0), 260] },
    { parameters: {}, id: nodeId(NODE.manual), name: NODE.manual, type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [x(0), 460] },
    code(NODE.load, [x(1), row], HUB, LOGIC.load, 'Validates every setting, computes the search window from the stored watermark.'),
    condition(NODE.isDemo, [x(2), row], '={{ $json.mode }}', 'demo'),
    code(NODE.demo, [x(3), 120], ALL, LOGIC.demo, 'Fictional tickets, mock HubSpot and mock LLM. Separate demo state, no network.'),
    http(NODE.account, [x(3), row], { method: 'GET', url: URL, headers: [HUBSPOT_AUTH], continueOnError: false }),
    code(NODE.enforce, [x(4), row], HUB, LOGIC.enforce, 'Stops unless the portal is a sandbox or developer test account (SANDBOX_MODE=true).'),
    http(NODE.pipelines, [x(5), row], { method: 'GET', url: '={{ $json.pipelinesRequest.url }}', headers: [HUBSPOT_AUTH], continueOnError: false }),
    http(NODE.search, [x(6), row], { method: 'POST', url: `={{ $(${N('load')}).first().json.searchRequest.url }}`, headers: [HUBSPOT_AUTH], body: `={{ JSON.stringify($(${N('load')}).first().json.searchRequest.body) }}`, continueOnError: false, notes: 'POST /crm/v3/objects/tickets/search: closed or escalated since the watermark, oldest first, MAX_TICKETS_PER_RUN.' }),
    code(NODE.prepare, [x(7), row], HUB, LOGIC.prepare, 'Drops already-processed tickets, strips HTML, redacts emails, phone and card numbers, links and credentials.'),
    condition(NODE.found, [x(8), row], '={{ $json.hasTickets }}', 'yes'),
    skipIf(NODE.needAssoc, [x(9), row]),
    http(NODE.assoc, [x(10), 240], { method: 'POST', url: URL, headers: [HUBSPOT_AUTH], body: BODY }),
    code(NODE.tagAssoc, [x(11), 240], HUB, LOGIC.tagAssoc),
    code(NODE.planCompanies, [x(12), row], HUB, LOGIC.planCompanies),
    skipIf(NODE.needCompanies, [x(13), row]),
    http(NODE.companies, [x(14), 240], { method: 'POST', url: URL, headers: [HUBSPOT_AUTH], body: BODY, notes: 'Batch read of name, domain and ARR_COMPANY_PROPERTY.' }),
    code(NODE.tagCompanies, [x(15), 240], HUB, LOGIC.tagCompanies),
    code(NODE.planCompanyDeals, [x(16), row], HUB, LOGIC.planCompanyDeals, 'Only with ARR_SOURCE=closed_won_deals.'),
    skipIf(NODE.needCompanyDeals, [x(17), row]),
    http(NODE.companyDeals, [x(18), 240], { method: 'POST', url: URL, headers: [HUBSPOT_AUTH], body: BODY }),
    code(NODE.tagCompanyDeals, [x(19), 240], HUB, LOGIC.tagCompanyDeals),
    code(NODE.planDeals, [x(20), row], HUB, LOGIC.planDeals),
    skipIf(NODE.needDeals, [x(21), row]),
    http(NODE.deals, [x(22), 240], { method: 'POST', url: URL, headers: [HUBSPOT_AUTH], body: BODY, notes: 'Batch read of dealstage and ARR_DEAL_PROPERTY; only closed-won deals count toward ARR.' }),
    code(NODE.tagDeals, [x(23), 240], HUB, LOGIC.tagDeals),
    code(NODE.planLlm, [x(24), row], LLM, LOGIC.planLlm, 'Per-company ARR, then one extraction request per ticket using the prompt template in src/core/llm.js.'),
    skipIf(NODE.needLlm, [x(25), row]),
    condition(NODE.isAnthropic, [x(26), 240], '={{ $env.LLM_PROVIDER }}', 'anthropic'),
    http(NODE.llmAnthropic, [x(27), 120], { method: 'POST', url: URL, headers: [['x-api-key', '={{ $env.LLM_API_KEY }}'], ['anthropic-version', '2023-06-01']], body: BODY, batching: { batchSize: 3, batchInterval: 1000 }, notes: 'Anthropic Messages API. The key comes from $env.LLM_API_KEY at request time.' }),
    http(NODE.llmOpenAi, [x(27), 300], { method: 'POST', url: URL, headers: [['Authorization', '=Bearer {{ $env.LLM_API_KEY }}']], body: BODY, batching: { batchSize: 3, batchInterval: 1000 }, notes: 'OpenAI-compatible chat completions with JSON output. Works with any compatible endpoint via LLM_API_URL.' }),
    code(NODE.tagLlm, [x(28), 240], [], LOGIC.tagLlm),
    code(NODE.cluster, [x(29), row], [...LLM, 'cluster'], LOGIC.cluster, 'Validates the JSON output, clusters by category and title similarity against the stored registry, sums ARR once per company.'),
    code(NODE.planSync, [x(30), row], SYNC, LOGIC.planSync, 'Creates or updates one record per cluster in the configured destination (sandbox container unless live).'),
    skipIf(NODE.needSync, [x(31), row]),
    http(NODE.sync, [x(32), 240], { method: '={{ $json.request.method }}', url: URL, headers: [DESTINATION_AUTH, NOTION_VERSION], body: BODY, retries: 2, notes: 'Linear GraphQL, Jira REST v3 or Notion pages. Credentials are read from $env at request time.' }),
    code(NODE.tagSync, [x(33), 240], SYNC, LOGIC.tagSync),
    code(NODE.planStamps, [x(34), row], SYNC, LOGIC.planStamps, 'Optional: writes the cluster title and record key to TICKET_FEEDBACK_STAMP_PROPERTY.'),
    skipIf(NODE.needStamps, [x(35), row]),
    http(NODE.stamp, [x(36), 240], { method: 'POST', url: URL, headers: [HUBSPOT_AUTH], body: BODY, retries: 2 }),
    code(NODE.tagStamps, [x(37), 240], [], LOGIC.tagStamps),
    code(NODE.finalize, [x(38), row], SYNC, LOGIC.finalize, 'Commits the watermark, processed tickets and registry (not in DRY_RUN), and fails the execution on any write failure.'),
    { parameters: {}, id: nodeId(NODE.errorTrigger), name: NODE.errorTrigger, type: 'n8n-nodes-base.errorTrigger', typeVersion: 1, position: [x(0), 760] },
    code(NODE.buildFailure, [x(1), 760], SYNC, LOGIC.buildFailure, 'Redacts tokens, API keys, webhook URLs and email addresses.'),
    condition(NODE.needFailure, [x(2), 760], '={{ $json.send }}', 'yes'),
    http(NODE.sendFailure, [x(3), 660], { method: 'POST', url: '={{ $env.ALERT_WEBHOOK_URL }}', body: '={{ JSON.stringify($json.message) }}', retries: 2, continueOnError: false }),
    { parameters: { content: STICKY, height: 320, width: 580, color: 4 }, id: nodeId(NODE.note), name: NODE.note, type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [x(0), -260] },
  ];

  const link = (...branches) => ({ main: branches.map((targets) => targets.map((node) => ({ node, type: 'main', index: 0 }))) });
  const chain = (ifNode, httpNode, tagNode, next) => ({ [ifNode]: link([httpNode], [next]), [httpNode]: link([tagNode]), [tagNode]: link([next]) });
  const connections = {
    [NODE.schedule]: link([NODE.load]),
    [NODE.manual]: link([NODE.load]),
    [NODE.load]: link([NODE.isDemo]),
    [NODE.isDemo]: link([NODE.demo], [NODE.account]),
    [NODE.demo]: link([NODE.finalize]),
    [NODE.account]: link([NODE.enforce]),
    [NODE.enforce]: link([NODE.pipelines]),
    [NODE.pipelines]: link([NODE.search]),
    [NODE.search]: link([NODE.prepare]),
    [NODE.prepare]: link([NODE.found]),
    [NODE.found]: link([NODE.needAssoc], [NODE.finalize]),
    ...chain(NODE.needAssoc, NODE.assoc, NODE.tagAssoc, NODE.planCompanies),
    [NODE.planCompanies]: link([NODE.needCompanies]),
    ...chain(NODE.needCompanies, NODE.companies, NODE.tagCompanies, NODE.planCompanyDeals),
    [NODE.planCompanyDeals]: link([NODE.needCompanyDeals]),
    ...chain(NODE.needCompanyDeals, NODE.companyDeals, NODE.tagCompanyDeals, NODE.planDeals),
    [NODE.planDeals]: link([NODE.needDeals]),
    ...chain(NODE.needDeals, NODE.deals, NODE.tagDeals, NODE.planLlm),
    [NODE.planLlm]: link([NODE.needLlm]),
    [NODE.needLlm]: link([NODE.isAnthropic], [NODE.cluster]),
    [NODE.isAnthropic]: link([NODE.llmAnthropic], [NODE.llmOpenAi]),
    [NODE.llmAnthropic]: link([NODE.tagLlm]),
    [NODE.llmOpenAi]: link([NODE.tagLlm]),
    [NODE.tagLlm]: link([NODE.cluster]),
    [NODE.cluster]: link([NODE.planSync]),
    [NODE.planSync]: link([NODE.needSync]),
    ...chain(NODE.needSync, NODE.sync, NODE.tagSync, NODE.planStamps),
    [NODE.planStamps]: link([NODE.needStamps]),
    ...chain(NODE.needStamps, NODE.stamp, NODE.tagStamps, NODE.finalize),
    [NODE.errorTrigger]: link([NODE.buildFailure]),
    [NODE.buildFailure]: link([NODE.needFailure]),
    [NODE.needFailure]: link([NODE.sendFailure], []),
  };

  return {
    name: WORKFLOW_NAME,
    nodes,
    connections,
    active: false,
    settings: { executionOrder: 'v1', saveDataSuccessExecution: 'none', saveDataErrorExecution: 'all', saveManualExecutions: true, callerPolicy: 'workflowsFromSameOwner' },
    pinData: {},
    meta: { templateCredsSetupCompleted: false, license: LICENSE_LINE },
    tags: [],
  };
}

export function serializeWorkflow() {
  return `${JSON.stringify(buildWorkflow(), null, 2)}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const output = serializeWorkflow();
  if (process.argv.includes('--check')) {
    if (readFileSync(WORKFLOW_PATH, 'utf8') !== output) {
      console.error('workflows/support_feedback_aggregator.json is out of date. Run "npm run build:workflow".');
      process.exit(1);
    }
    console.log('workflows/support_feedback_aggregator.json is up to date.');
  } else {
    mkdirSync(dirname(WORKFLOW_PATH), { recursive: true });
    writeFileSync(WORKFLOW_PATH, output);
    console.log(`Wrote ${WORKFLOW_PATH} (${buildWorkflow().nodes.length} nodes, ${Math.round(Buffer.byteLength(output) / 1024)} KB)`);
  }
}
