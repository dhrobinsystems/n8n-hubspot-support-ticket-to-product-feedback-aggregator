# ⚠️ Disclaimer & Liability Limitation

**Use at your own risk.** The code, workflows, and scripts provided in this repository (`n8n-hubspot-support-ticket-to-product-feedback-aggregator`) are for educational and architectural demonstration purposes.

* **No Liability:** The author and dhRobin Systems assume no responsibility or liability for any direct, indirect, incidental, or consequential damages resulting from the use, misuse, or deployment of these scripts. This includes, without limitation, incorrect or incomplete feedback classification, mis-clustered or duplicated product records, inaccurate ARR impact or churn risk figures, roadmap or commercial decisions taken on the basis of those figures, unintended writes to HubSpot, Linear, Jira or Notion, LLM usage charges, and any exposure of ticket content to a third-party model provider.
* **No Warranty:** All software, n8n JSON blueprints, and JavaScript modules are provided "AS IS" without warranty of any kind, express or implied, including but not limited to merchantability, fitness for a particular purpose, or non-infringement. LLM output is probabilistic: categories, titles, sentiment and churn risk scores are estimates and can be wrong, and the PII redaction is a best-effort pattern filter, not a guarantee.
* **Production Testing Required:** Always test thoroughly in an isolated staging environment (for example a HubSpot developer test account or sandbox) with `SANDBOX_MODE=true` and `DRY_RUN=true` enabled before connecting live HubSpot credentials. Point the aggregator at a sandbox Linear team, Jira project or Notion database first, and review the extracted clusters and ARR figures against the source tickets before letting it create records anywhere a product team will act on them.
* **Third-Party APIs & Compliance:** Users are solely responsible for complying with the terms of service, rate limits, data privacy regulations (GDPR/CCPA), and security policies of HubSpot and any connected services, including the chosen LLM provider, Linear, Atlassian Jira and Notion. Support tickets routinely contain personal data; confirm that a lawful basis, a data processing agreement and any required customer notice are in place before sending ticket text to an external model, and that the configured retention of n8n execution data matches your obligations.

Nothing in this repository is legal, financial, or compliance advice. All company names, tickets, people, amounts and identifiers in the code, tests and documentation (for example Acme Corp, Example Inc, Sample Industries LLC and Demo Logistics Co.) are fictional; email addresses use `example.com` and phone numbers use the reserved 555-0100 to 555-0199 range.

## License

Released under the MIT License. Copyright (c) 2026 DH Robin (dhRobin Systems). See [LICENSE](https://github.com/dhrobinsystems/n8n-hubspot-support-ticket-to-product-feedback-aggregator/blob/main/LICENSE).

DH Robin | dhRobin Systems · https://dhrobinsystems.com

---

DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.
