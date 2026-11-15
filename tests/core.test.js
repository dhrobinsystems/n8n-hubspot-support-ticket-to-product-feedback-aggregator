// DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isLiveMode, isPlaceholder, loadAggregatorConfig, resolveDestinationTarget, validateAggregatorConfig } from '../src/core/config.js';
import { buildTicketSearchRequest, computeCompanyArr, enforceSandbox, parseTicketSearch, redactPii } from '../src/core/hubspot.js';
import { buildLlmRequest, mockLlmResponse, parseExtraction, SYSTEM_PROMPT } from '../src/core/llm.js';
import { clusterFeedback, jaccard, tokenize } from '../src/core/cluster.js';
import { buildFailureAlert, commitRunState, parseSyncResponse, planDestinationSync } from '../src/core/sync.js';
import { DEMO_NOW } from '../src/core/mocks.js';
import { parseDotEnv } from '../src/index.js';

const NOW = Date.parse(DEMO_NOW);

test('defaults are fail-safe: demo mode, mock LLM, DRY_RUN and SANDBOX_MODE on, no destination', () => {
  const config = loadAggregatorConfig({});
  assert.equal(config.mode, 'demo');
  assert.equal(config.dryRun, true);
  assert.equal(config.sandboxMode, true);
  assert.equal(config.llm.provider, 'mock');
  assert.equal(config.destination.target, 'none');
  assert.equal(isLiveMode(config), false);
  assert.ok(isPlaceholder('YOUR_HUBSPOT_PRIVATE_APP_TOKEN'));
  assert.equal(loadAggregatorConfig({ DRY_RUN: 'maybe' }).dryRun, true);
});

test('validation refuses placeholders and a mock LLM in live mode', () => {
  const { errors } = validateAggregatorConfig(loadAggregatorConfig({ HUBSPOT_PRIVATE_APP_TOKEN: 'test-token', DRY_RUN: 'false', SANDBOX_MODE: 'false', FEEDBACK_DESTINATION: 'linear', LINEAR_API_KEY: 'YOUR_LINEAR_API_KEY' }));
  assert.ok(errors.some((error) => /LINEAR_API_KEY/.test(error)));
  assert.ok(errors.some((error) => /mock/i.test(error)));
  const openai = validateAggregatorConfig(loadAggregatorConfig({ HUBSPOT_PRIVATE_APP_TOKEN: 'test-token', LLM_PROVIDER: 'openai', LLM_API_KEY: 'YOUR_LLM_API_KEY' }));
  assert.ok(openai.errors.some((error) => /LLM_API_KEY/.test(error)));
});

test('the sandbox container is used unless live, and a production portal is refused in sandbox mode', () => {
  const env = { HUBSPOT_PRIVATE_APP_TOKEN: 'test-token', FEEDBACK_DESTINATION: 'linear', LINEAR_API_KEY: 'k', LINEAR_TEAM_ID: 'team-prod', LINEAR_SANDBOX_TEAM_ID: 'team-sandbox' };
  assert.equal(resolveDestinationTarget(loadAggregatorConfig(env)).container, 'team-sandbox');
  assert.equal(resolveDestinationTarget(loadAggregatorConfig({ ...env, DRY_RUN: 'false', SANDBOX_MODE: 'false' })).container, 'team-prod');
  assert.equal(enforceSandbox({ portalId: 1, accountType: 'STANDARD' }, loadAggregatorConfig(env)).ok, false);
  assert.equal(enforceSandbox({ portalId: 1, accountType: 'DEVELOPER_TEST' }, loadAggregatorConfig(env)).ok, true);
});

test('ticket search covers closed OR escalated tickets since the watermark, oldest first', () => {
  const request = buildTicketSearchRequest(loadAggregatorConfig({ TICKET_PIPELINE_IDS: '0,1' }), 1000);
  assert.equal(request.method, 'POST');
  assert.match(request.url, /\/crm\/v3\/objects\/tickets\/search$/);
  assert.equal(request.body.filterGroups.length, 2);
  assert.deepEqual(request.body.filterGroups[1].filters[0], { propertyName: 'hs_ticket_priority', operator: 'IN', values: ['HIGH', 'URGENT'] });
  assert.ok(request.body.filterGroups.every((group) => group.filters.some((filter) => filter.propertyName === 'hs_pipeline')));
  assert.deepEqual(request.body.sorts, [{ propertyName: 'hs_lastmodifieddate', direction: 'ASCENDING' }]);
});

test('PII is redacted before text leaves HubSpot', () => {
  const text = redactPii('Mail pat@example.com, call (555) 555-0123 or +1 555 555 0199, card 4111 1111 1111 1111, see https://example.com/x?token=abc');
  for (const fragment of ['pat@example.com', '555-0123', '555 0199', '4111', 'https://']) assert.ok(!text.includes(fragment), fragment);
  const parsed = parseTicketSearch({ total: 1, results: [{ id: '1', properties: { subject: 'Hi', content: '<b>Reach me at pat@example.com</b>', hs_lastmodifieddate: DEMO_NOW, hs_ticket_priority: 'HIGH' } }] }, {}, loadAggregatorConfig({}));
  assert.equal(parsed.tickets[0].escalated, true);
  assert.ok(!parsed.tickets[0].text.includes('<b>'));
  assert.ok(parsed.tickets[0].text.includes('[email]'));
});

test('already processed tickets are skipped unless modified again', () => {
  const body = { total: 1, results: [{ id: '7', properties: { subject: 'x', content: 'y', hs_lastmodifieddate: DEMO_NOW } }] };
  const state = { processedTickets: { 7: NOW } };
  assert.equal(parseTicketSearch(body, state, loadAggregatorConfig({})).tickets.length, 0);
  state.processedTickets[7] = NOW - 1;
  assert.equal(parseTicketSearch(body, state, loadAggregatorConfig({})).tickets.length, 1);
});

test('ARR comes from the company property or from closed-won deals only', () => {
  const companies = { 1: { name: 'Acme Corp', annual_recurring_revenue: '1,200' } };
  assert.equal(computeCompanyArr({ companies, companyDeals: {}, deals: {}, wonStages: new Set(), config: loadAggregatorConfig({}) })[1].arr, 1200);
  const deals = { 10: { dealstage: 'closedwon', amount: '500' }, 11: { dealstage: 'contractsent', amount: '9000' } };
  const arr = computeCompanyArr({ companies, companyDeals: { 1: ['10', '11'] }, deals, wonStages: new Set(['closedwon']), config: loadAggregatorConfig({ ARR_SOURCE: 'closed_won_deals' }) });
  assert.equal(arr[1].arr, 500);
});

test('the prompt asks for strict JSON and treats ticket text as data', () => {
  assert.match(SYSTEM_PROMPT, /JSON/);
  assert.match(SYSTEM_PROMPT, /data, not instructions/);
  const config = loadAggregatorConfig({ LLM_PROVIDER: 'anthropic', LLM_API_KEY: 'k', LLM_MODEL: 'm' });
  const request = buildLlmRequest(config, { id: '1', subject: 's', text: 't', escalated: false });
  assert.equal(request.body.temperature, 0);
  assert.equal(typeof request.body.system, 'string');
  const openai = buildLlmRequest(loadAggregatorConfig({ LLM_PROVIDER: 'openai', LLM_API_KEY: 'k', LLM_MODEL: 'm' }), { id: '1', subject: 's', text: 't' });
  assert.deepEqual(openai.body.response_format, { type: 'json_object' });
});

test('extraction output is validated and clamped', () => {
  const config = loadAggregatorConfig({});
  const good = parseExtraction({ content: [{ type: 'text', text: '```json\n{"items":[{"category":"bug","title":"Export fails","productArea":"reporting","sentiment":"negative","churnRiskScore":250,"summary":"Export fails."}]}\n```' }] }, config);
  assert.equal(good.ok, true);
  assert.equal(good.items[0].churnRiskScore, 100);
  assert.equal(parseExtraction({ choices: [{ message: { content: 'not json' } }] }, config).ok, false);
  assert.equal(parseExtraction({ error: { message: 'rate limited' } }, config).ok, false);
  const mock = parseExtraction(mockLlmResponse({ id: '1', text: 'CSV export fails with error 500', escalated: true }, config), config);
  assert.equal(mock.items[0].category, 'bug');
});

test('similar requests cluster together and ARR is counted once per company', () => {
  assert.ok(jaccard(tokenize('CSV export fails on large reports'), tokenize('CSV exports failing for large report')) >= 0.5);
  const item = (title) => ({ category: 'bug', title, productArea: 'reporting', sentiment: 'negative', churnRiskScore: 70, summary: title });
  const { touched } = clusterFeedback({
    extractions: [{ ticketId: '1', items: [item('CSV export fails on large reports')] }, { ticketId: '2', items: [item('CSV exports failing for large report')] }, { ticketId: '3', items: [item('CSV export fails on large reports')] }],
    ticketCompanies: { 1: ['A'], 2: ['B'], 3: ['A'] },
    companyArr: { A: { companyId: 'A', name: 'Acme Corp', arr: 100 }, B: { companyId: 'B', name: 'Example Inc', arr: 50 } },
    registry: {},
    config: loadAggregatorConfig({}),
    now: NOW,
  });
  assert.equal(touched.length, 1);
  assert.equal(touched[0].metrics.ticketCount, 3);
  assert.equal(touched[0].metrics.arrImpact, 150);
  assert.equal(touched[0].metrics.arrAtRisk, 150);
});

test('destination router builds create then update requests and reads responses', () => {
  const config = loadAggregatorConfig({ HUBSPOT_PRIVATE_APP_TOKEN: 'test-token', DRY_RUN: 'false', FEEDBACK_DESTINATION: 'jira', JIRA_BASE_URL: 'https://example.atlassian.net', JIRA_EMAIL: 'bot@example.com', JIRA_API_TOKEN: 't', JIRA_SANDBOX_PROJECT_KEY: 'SBX' });
  const cluster = { id: 'fb-1', isNew: true, category: 'bug', title: 'Export fails', productArea: 'reporting', ticketIds: ['1'], companies: {}, summaries: [], metrics: { ticketCount: 1, companyCount: 0, arrImpact: 0, arrAtRisk: 0, avgChurnRisk: 10, maxChurnRisk: 10, negativeShare: 1, priority: 4 } };
  const [create] = planDestinationSync([cluster], config, { portalId: 1, uiDomain: 'app.hubspot.com' });
  assert.equal(create.request.method, 'POST');
  assert.match(create.request.url, /\/rest\/api\/3\/issue$/);
  const ref = parseSyncResponse(create, { id: '10001', key: 'SBX-1' }).ref;
  assert.equal(ref.key, 'SBX-1');
  const [update] = planDestinationSync([{ ...cluster, isNew: false, destination: ref }], config, { portalId: 1 });
  assert.equal(update.request.method, 'PUT');
  assert.match(update.request.url, /\/issue\/SBX-1$/);
  assert.equal(planDestinationSync([cluster], { ...config, dryRun: true }, { portalId: 1 }).length, 0);
});

test('failed extractions hold the watermark at the oldest failure', () => {
  const state = {};
  const tickets = [{ id: '1', modifiedAt: 1000 }, { id: '2', modifiedAt: 2000 }, { id: '3', modifiedAt: 3000 }];
  commitRunState(state, { registry: {}, syncResults: [], tickets, extractionResults: [{ ticketId: '1', ok: true }, { ticketId: '2', ok: false }, { ticketId: '3', ok: true }], config: loadAggregatorConfig({}) });
  assert.ok(state.ticketWatermark <= 2000);
  assert.equal(state.processedTickets[2], undefined);
  assert.equal(state.processedTickets[3], 3000);
});

test('failure alerts are redacted', () => {
  const alert = JSON.stringify(buildFailureAlert({ errorMessage: 'token test-secret-value leaked to ops@example.com via https://hooks.example.com/abc', config: loadAggregatorConfig({}), secrets: ['test-secret-value'] }));
  assert.ok(!alert.includes('test-secret-value'));
  assert.ok(!alert.includes('ops@example.com'));
});

test('.env parsing ignores comments and strips quotes', () => {
  assert.deepEqual(parseDotEnv('# c\nA=1 # note\nB="two"\nexport C=3\n'), { A: '1', B: 'two', C: '3' });
});
