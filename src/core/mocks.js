// DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.
/**
 * Fictional demo portal (Acme Corp, Example Inc, Sample Industries LLC, Demo Logistics Co.) plus
 * in-memory stand-ins for HubSpot, an LLM API (OpenAI and Anthropic response shapes) and Linear,
 * Jira and Notion. Every email is @example.com and every phone number is in the reserved 555-01XX range.
 */
import { mockLlmResponse } from './llm.js';

export const DEMO_NOW = '2026-11-16T06:00:00.000Z';
const NOW = Date.parse(DEMO_NOW);
const hoursAgo = (hours) => new Date(NOW - hours * 3600000).toISOString();

export const DEMO_PIPELINES = Object.freeze({
  results: [{
    id: 'default',
    label: 'Sales Pipeline',
    stages: [
      { id: 'contractsent', label: 'Contract Sent', displayOrder: 0, metadata: { isClosed: 'false', probability: '0.9' } },
      { id: 'closedwon', label: 'Closed Won', displayOrder: 1, metadata: { isClosed: 'true', probability: '1.0' } },
      { id: 'closedlost', label: 'Closed Lost', displayOrder: 2, metadata: { isClosed: 'true', probability: '0.0' } },
    ],
  }],
});

export function createDemoPortal() {
  const ticket = (subject, content, extra) => ({ subject, content, hs_pipeline: '0', hs_ticket_category: 'PRODUCT_ISSUE', createdate: hoursAgo(48), ...extra });
  return {
    tickets: {
      801: ticket('CSV export error', '<p>Export to CSV fails with error 500 when a report has more than 10k rows. Please call me back on (555) 555-0123 or write to pat.example@example.com.</p>', { hs_ticket_priority: 'MEDIUM', closed_date: hoursAgo(30), hs_lastmodifieddate: hoursAgo(30) }),
      802: ticket('Big report export crashes', 'The CSV export crashes for big reports, we get error 500 every time.', { hs_ticket_priority: 'HIGH', closed_date: hoursAgo(28), hs_lastmodifieddate: hoursAgo(28) }),
      803: ticket('Okta SSO before renewal', 'Please add SSO with Okta. Our security team requires it before we renew next quarter.', { hs_ticket_priority: 'MEDIUM', closed_date: hoursAgo(26), hs_lastmodifieddate: hoursAgo(26) }),
      804: ticket('SAML question', 'It would be great to have SAML single sign-on so our admins can manage access centrally.', { hs_ticket_priority: 'LOW', closed_date: hoursAgo(24), hs_lastmodifieddate: hoursAgo(24) }),
      805: ticket('Seat pricing', 'We are evaluating a competitor because the pricing for extra seats is too expensive. We are considering cancelling.', { hs_ticket_priority: 'HIGH', hs_lastmodifieddate: hoursAgo(20) }),
      806: ticket('Dashboard performance', 'The main dashboard loads slowly, it takes about 30 seconds every morning.', { hs_ticket_priority: 'MEDIUM', closed_date: hoursAgo(18), hs_lastmodifieddate: hoursAgo(18) }),
      807: ticket('Renewal concern', 'Pricing for additional seats is too high for us, we may not renew. Card on file 4111 1111 1111 1111 should not be charged again.', { hs_ticket_priority: 'URGENT', hs_lastmodifieddate: hoursAgo(12) }),
      808: ticket('Thanks', 'All resolved now, thank you for the quick help!', { hs_ticket_priority: 'LOW', closed_date: hoursAgo(6), hs_lastmodifieddate: hoursAgo(6) }),
      809: ticket('Old ticket', 'Login page typo.', { hs_ticket_priority: 'LOW', closed_date: hoursAgo(24 * 30), hs_lastmodifieddate: hoursAgo(24 * 30) }),
    },
    companies: {
      601: { name: 'Acme Corp', domain: 'acme.example.com', annual_recurring_revenue: '120000' },
      602: { name: 'Example Inc', domain: 'example-inc.example.com', annual_recurring_revenue: '45000' },
      603: { name: 'Sample Industries LLC', domain: 'sample-industries.example.com', annual_recurring_revenue: '80000' },
      604: { name: 'Demo Logistics Co.', domain: 'demo-logistics.example.com', annual_recurring_revenue: '30000' },
    },
    deals: {
      701: { dealname: 'Acme Corp - Platform', dealstage: 'closedwon', pipeline: 'default', amount: '120000' },
      702: { dealname: 'Example Inc - Starter', dealstage: 'closedwon', pipeline: 'default', amount: '45000' },
      703: { dealname: 'Sample Industries LLC - Enterprise', dealstage: 'closedwon', pipeline: 'default', amount: '80000' },
      704: { dealname: 'Sample Industries LLC - Expansion', dealstage: 'contractsent', pipeline: 'default', amount: '20000' },
      705: { dealname: 'Demo Logistics Co. - Team', dealstage: 'closedwon', pipeline: 'default', amount: '30000' },
    },
    associations: {
      'tickets/companies': { 801: ['601'], 802: ['602'], 803: ['603'], 804: ['604'], 805: ['601'], 806: ['602'], 807: ['603'], 808: [] },
      'companies/deals': { 601: ['701'], 602: ['702'], 603: ['703', '704'], 604: ['705'] },
    },
  };
}

function pick(record, names) {
  const out = {};
  for (const name of names) out[name] = record[name] === undefined ? null : record[name];
  return out;
}

export function createMockHubSpot({ portal = createDemoPortal(), account = { portalId: 'DEMO', accountType: 'SANDBOX', uiDomain: 'app.hubspot.com' } } = {}) {
  const calls = [];
  async function request(req) {
    const method = String(req.method || 'GET').toUpperCase();
    const url = new URL(req.url);
    calls.push({ method, path: url.pathname, body: req.body === undefined ? null : JSON.parse(JSON.stringify(req.body)), headers: req.headers || {} });
    if (method === 'GET' && url.pathname === '/account-info/v3/details') return { status: 200, body: { ...account } };
    if (method === 'GET' && url.pathname === '/crm/v3/pipelines/deals') return { status: 200, body: JSON.parse(JSON.stringify(DEMO_PIPELINES)) };
    if (method === 'POST' && url.pathname === '/crm/v3/objects/tickets/search') {
      const since = Number(req.body.filterGroups[0].filters.find((filter) => filter.propertyName === 'hs_lastmodifieddate').value);
      const escalation = req.body.filterGroups[1].filters[0];
      const rows = Object.entries(portal.tickets)
        .filter(([, ticket]) => Date.parse(ticket.hs_lastmodifieddate) >= since && (ticket.closed_date || escalation.values.includes(ticket[escalation.propertyName])))
        .sort((a, b) => Date.parse(a[1].hs_lastmodifieddate) - Date.parse(b[1].hs_lastmodifieddate));
      const page = rows.slice(0, req.body.limit);
      return { status: 200, body: { total: rows.length, results: page.map(([id, ticket]) => ({ id, properties: { hs_object_id: id, ...pick(ticket, req.body.properties) }, updatedAt: ticket.hs_lastmodifieddate })), ...(rows.length > page.length ? { paging: { next: { after: String(page.length) } } } : {}) } };
    }
    const assoc = url.pathname.match(/^\/crm\/v4\/associations\/(\w+)\/(\w+)\/batch\/read$/);
    if (method === 'POST' && assoc) {
      const map = portal.associations[`${assoc[1]}/${assoc[2]}`] || {};
      const results = [];
      const errors = [];
      for (const input of req.body.inputs) {
        const ids = map[input.id] || [];
        if (ids.length) results.push({ from: { id: input.id }, to: ids.map((id) => ({ toObjectId: Number(id), associationTypes: [{ category: 'HUBSPOT_DEFINED', typeId: 1, label: null }] })) });
        else errors.push({ status: 'error', category: 'VALIDATION_ERROR', subCategory: 'crm.associations.NO_ASSOCIATIONS_FOUND', message: `No ${assoc[2]} is associated with ${assoc[1]} ${input.id}.`, context: { fromObjectId: [input.id] } });
      }
      return { status: errors.length ? 207 : 200, body: { status: 'COMPLETE', results, errors } };
    }
    const batch = url.pathname.match(/^\/crm\/v3\/objects\/(\w+)\/batch\/(read|update)$/);
    if (method === 'POST' && batch) {
      const store = portal[batch[1]];
      if (batch[2] === 'read') return { status: 200, body: { status: 'COMPLETE', results: req.body.inputs.filter((input) => store[input.id]).map((input) => ({ id: input.id, properties: pick(store[input.id], req.body.properties) })) } };
      for (const input of req.body.inputs) Object.assign(store[input.id], input.properties);
      return { status: 200, body: { status: 'COMPLETE', results: req.body.inputs.map((input) => ({ id: input.id, properties: input.properties })) } };
    }
    return { status: 404, body: { status: 'error', message: `Mock HubSpot has no route for ${method} ${url.pathname}` } };
  }
  return { request, calls, portal };
}

/** LLM API stand-in. Anthropic-style URLs get Messages responses, everything else chat-completions responses. */
export function createMockLlmApi({ config, failTickets = [] }) {
  const calls = [];
  async function request(req) {
    calls.push({ url: req.url, headers: req.headers || {}, body: JSON.parse(JSON.stringify(req.body)) });
    const userText = req.url.includes('anthropic') ? req.body.messages[0].content : req.body.messages[1].content;
    const id = (userText.match(/^Ticket (\d+)/) || [])[1];
    if (failTickets.includes(id)) return { status: 429, body: { error: { type: 'rate_limit_error', message: 'Rate limited' } } };
    const text = (userText.match(/<ticket>\n([\s\S]*)\n<\/ticket>/) || [])[1] || '';
    const content = mockLlmResponse({ id, text, escalated: /\(escalated\)/.test(userText) }, config).choices[0].message.content;
    if (req.url.includes('anthropic')) return { status: 200, body: { id: `msg_${id}`, type: 'message', role: 'assistant', content: [{ type: 'text', text: content }], stop_reason: 'end_turn' } };
    return { status: 200, body: { id: `chatcmpl-${id}`, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] } };
  }
  return { request, calls };
}

/** Linear (GraphQL), Jira (REST v3) and Notion (pages) stand-ins sharing one store. */
export function createMockDestinations({ fail = false } = {}) {
  const records = {};
  const calls = [];
  let counter = 0;
  async function request(req) {
    const url = new URL(req.url);
    calls.push({ method: req.method, url: req.url, headers: req.headers || {}, body: req.body === undefined ? null : JSON.parse(JSON.stringify(req.body)) });
    if (fail) return { status: 500, body: { error: { message: 'Destination unavailable' } } };
    if (url.hostname.includes('linear')) {
      const update = /issueUpdate/.test(req.body.query);
      const input = req.body.variables.input;
      const id = update ? req.body.variables.id : `lin-${++counter}`;
      records[id] = { ...(records[id] || {}), ...input, system: 'linear' };
      const issue = { id, identifier: records[id].identifier || `FB-${counter}`, url: `https://linear.app/example/issue/FB-${counter}` };
      records[id].identifier = issue.identifier;
      return { status: 200, body: { data: { [update ? 'issueUpdate' : 'issueCreate']: { success: true, issue } } } };
    }
    if (url.pathname.startsWith('/rest/api/3/issue')) {
      if (req.method === 'PUT') {
        const key = decodeURIComponent(url.pathname.split('/').pop());
        records[key] = { ...records[key], ...req.body.fields };
        return { status: 204, body: {} };
      }
      const key = `FB-${++counter}`;
      records[key] = { ...req.body.fields, system: 'jira' };
      return { status: 201, body: { id: String(10000 + counter), key, self: `https://example.atlassian.net/rest/api/3/issue/${10000 + counter}` } };
    }
    if (url.pathname.startsWith('/v1/pages')) {
      if (req.method === 'PATCH') {
        const id = decodeURIComponent(url.pathname.split('/').pop());
        records[id] = { ...records[id], properties: { ...records[id].properties, ...req.body.properties } };
        return { status: 200, body: { object: 'page', id, url: `https://www.notion.so/${id}` } };
      }
      const id = `page-${++counter}`;
      records[id] = { ...req.body, system: 'notion' };
      return { status: 200, body: { object: 'page', id, url: `https://www.notion.so/${id}` } };
    }
    return { status: 404, body: { error: { message: 'no route' } } };
  }
  return { request, records, calls };
}
