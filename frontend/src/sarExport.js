/**
 * SAR (Suspicious Activity Report) HTML generator.
 *
 * All values are sourced from already-computed tool outputs — no data is invented.
 * The generated HTML is self-contained and print-ready (Cmd+P → PDF).
 */

const fmtUSD = (n) =>
  typeof n === 'number'
    ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : '—'

const fmtTS = (str) => {
  try {
    return new Date(str.replace(' ', 'T')).toLocaleString('en-US', {
      year: 'numeric', month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    })
  } catch { return str ?? '—' }
}

const TYPOLOGY_LABEL = {
  structuring: 'Structuring — Sub-threshold Deposit Evasion (31 U.S.C. § 5324)',
  smurfing:    'Smurfing — Multi-account Fund Dispersal (BSA SAR)',
  layering:    'Layering — Multi-hop Chain Obfuscation (BSA SAR)',
}

const RISK_COLOR = { high: '#b91c1c', medium: '#b45309', low: '#15803d' }

// ─── CSS ────────────────────────────────────────────────────────────────────

const CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  @page { margin: 0.9in 1in; size: letter; }

  body {
    font-family: 'Times New Roman', Times, serif;
    font-size: 10.5pt;
    color: #111;
    line-height: 1.45;
    background: #fff;
    padding: 0.4in 0.5in;
    max-width: 8.5in;
    margin: 0 auto;
  }

  /* ── Watermark ── */
  body::before {
    content: 'DRAFT';
    position: fixed;
    top: 50%; left: 50%;
    transform: translate(-50%, -50%) rotate(-40deg);
    font-size: 140pt;
    font-weight: 900;
    color: rgba(0,0,0,0.04);
    pointer-events: none;
    z-index: -1;
    letter-spacing: 0.1em;
  }

  /* ── Top bar (hidden on print) ── */
  .toolbar {
    background: #1e3a5f;
    color: #fff;
    padding: 10px 18px;
    margin: -0.4in -0.5in 24pt;
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-family: 'Helvetica Neue', Arial, sans-serif;
  }
  .toolbar span { font-size: 12px; font-weight: 600; }
  .toolbar button {
    background: #fff;
    color: #1e3a5f;
    border: none;
    padding: 6px 18px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 700;
    cursor: pointer;
    letter-spacing: 0.02em;
  }

  /* ── Report header ── */
  .rpt-header {
    text-align: center;
    border-top: 3px solid #000;
    border-bottom: 3px solid #000;
    padding: 10pt 0;
    margin-bottom: 10pt;
  }
  .rpt-header h1 {
    font-size: 15pt;
    text-transform: uppercase;
    letter-spacing: 3px;
    font-weight: bold;
  }
  .rpt-header .sub {
    font-size: 9pt;
    color: #444;
    margin-top: 3pt;
  }

  .confidential {
    text-align: center;
    font-size: 8.5pt;
    font-weight: bold;
    color: #b91c1c;
    text-transform: uppercase;
    letter-spacing: 3px;
    border: 1.5px solid #b91c1c;
    padding: 3pt 0;
    margin-bottom: 14pt;
  }

  /* ── Sections ── */
  .section { margin-bottom: 16pt; break-inside: avoid; }

  .section-title {
    font-size: 9pt;
    font-weight: bold;
    text-transform: uppercase;
    letter-spacing: 1.5px;
    background: #1e3a5f;
    color: #fff;
    padding: 3pt 8pt;
    margin-bottom: 8pt;
  }

  /* ── Field rows ── */
  .fields { border: 1px solid #ccc; }
  .field-row {
    display: flex;
    border-bottom: 1px solid #e0e0e0;
    font-size: 9.5pt;
  }
  .field-row:last-child { border-bottom: none; }
  .field-label {
    font-weight: bold;
    width: 170pt;
    min-width: 170pt;
    padding: 4pt 8pt;
    background: #f0f4f8;
    border-right: 1px solid #ccc;
  }
  .field-value {
    padding: 4pt 8pt;
    flex: 1;
  }

  /* ── Risk badge ── */
  .risk-badge {
    display: inline-block;
    font-weight: bold;
    font-size: 9.5pt;
    text-transform: uppercase;
    letter-spacing: 1px;
    padding: 1pt 7pt;
    border: 1.5px solid;
  }

  /* ── Narrative ── */
  .narrative {
    font-size: 10pt;
    line-height: 1.65;
    text-align: justify;
    padding: 8pt 10pt;
    border: 1px solid #ccc;
    background: #fafafa;
  }

  /* ── Tables ── */
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 8.5pt;
    margin-top: 4pt;
  }
  th {
    background: #dde5ef;
    font-weight: bold;
    text-align: left;
    padding: 4pt 6pt;
    border: 1px solid #aab;
    font-size: 8pt;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  td {
    padding: 3.5pt 6pt;
    border: 1px solid #ccc;
    vertical-align: top;
  }
  tr:nth-child(even) td { background: #f5f7fb; }
  .mono { font-family: 'Courier New', Courier, monospace; font-size: 8pt; }
  .right { text-align: right; }
  .center { text-align: center; }

  /* ── Evidence list ── */
  .evidence-item {
    padding: 4pt 8pt;
    border-bottom: 1px dotted #ccc;
    font-size: 9pt;
  }
  .evidence-item:last-child { border-bottom: none; }
  .evidence-item::before { content: '▶ '; font-size: 7pt; color: #666; }

  /* ── Chain path ── */
  .chain {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4pt;
    padding: 8pt;
    border: 1px solid #ccc;
    background: #fafafa;
    font-family: 'Courier New', monospace;
    font-size: 8.5pt;
  }
  .chain-node {
    padding: 3pt 7pt;
    border: 1px solid;
    font-weight: bold;
  }
  .chain-arrow { color: #666; font-size: 9pt; padding: 0 3pt; }

  /* ── Certification ── */
  .cert-box {
    border: 1.5px solid #000;
    padding: 10pt 12pt;
  }
  .cert-text { font-size: 9pt; line-height: 1.55; margin-bottom: 14pt; }
  .sig-row { display: flex; gap: 24pt; margin-top: 16pt; }
  .sig-field { flex: 1; }
  .sig-line { border-bottom: 1px solid #000; margin-bottom: 3pt; height: 18pt; }
  .sig-label { font-size: 8pt; color: #555; }

  /* ── Footer ── */
  .rpt-footer {
    margin-top: 16pt;
    font-size: 7.5pt;
    color: #888;
    text-align: center;
    border-top: 1px solid #ccc;
    padding-top: 6pt;
  }

  @media print {
    .toolbar { display: none !important; }
    body { padding: 0; }
    body::before { display: block; }
  }
`

// ─── Section builders ────────────────────────────────────────────────────────

function fieldsHTML(rows) {
  return `<div class="fields">${rows.map(([label, value, mono]) => `
    <div class="field-row">
      <div class="field-label">${label}</div>
      <div class="field-value${mono ? ' mono' : ''}">${value}</div>
    </div>`).join('')}
  </div>`
}

function signaturesHTML(labels) {
  return `<div class="sig-row">${labels.map(l => `
    <div class="sig-field">
      <div class="sig-line"></div>
      <div class="sig-label">${l}</div>
    </div>`).join('')}
  </div>`
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Generate a self-contained SAR HTML string.
 *
 * @param {object} exp          - one item from explain_flag.explanations
 * @param {object|null} classify - matching entry from classify_risk.classifications
 * @param {object|null} structEntry  - flagged_accounts entry from detect_structuring
 * @param {object|null} smurfEntry   - flagged_accounts entry from detect_smurfing
 * @param {object|null} layerPath    - detected_paths entry from detect_layering
 * @param {string} filingDate   - ISO date string (e.g. '2026-07-26')
 */
export function generateSAR({ exp, classify, structEntry, smurfEntry, layerPath, filingDate }) {
  const date     = filingDate ?? new Date().toISOString().split('T')[0]
  const reportId = `SAR-${date}-${exp.account_id}`.replace(/[^A-Z0-9-]/gi, '-')
  const riskColor = RISK_COLOR[exp.risk_level] ?? '#555'

  const typologies = [
    structEntry && TYPOLOGY_LABEL.structuring,
    smurfEntry  && TYPOLOGY_LABEL.smurfing,
    layerPath   && TYPOLOGY_LABEL.layering,
  ].filter(Boolean)

  // Total amount involved (best estimate from available detection data)
  let totalAmount = 0
  if (structEntry?.total_amount_structured) totalAmount += structEntry.total_amount_structured
  if (smurfEntry?.total_sent)               totalAmount  = Math.max(totalAmount, smurfEntry.total_sent)
  if (layerPath?.total_amount)              totalAmount  = Math.max(totalAmount, layerPath.total_amount)

  const signals = classify?.contributing_signals ?? []

  // ── Part I — Filing info ──────────────────────────────────────────────────
  const part1 = fieldsHTML([
    ['Report ID',      `<span class="mono">${reportId}</span>`],
    ['Filing Date',    date],
    ['Report Type',    'Initial Suspicious Activity Report (SAR)'],
    ['Institution',    'FinSherlock AI Compliance System'],
    ['Detection Method', 'Automated AML Pattern Analysis — IBM HI-Small Dataset'],
    ['Generated By',   'FinSherlock AI v1.0 · Deterministic Rule Engine + ML Risk Score'],
  ])

  // ── Part II — Subject info ────────────────────────────────────────────────
  const riskBadge = `<span class="risk-badge" style="color:${riskColor};border-color:${riskColor}">${exp.risk_level.toUpperCase()}</span>`
  const part2 = fieldsHTML([
    ['Account Identifier',  `<span class="mono">${exp.account_id}</span>`],
    ['Risk Classification', `${riskBadge}&nbsp;&nbsp;Composite score: ${exp.risk_score?.toFixed(1) ?? '—'} / 100`],
    ['Escalation Action',   `<strong>${exp.escalation?.toUpperCase() ?? '—'}</strong> — ${exp.instruction ?? ''}`],
    ['Activity Types',      typologies.length ? typologies.join('<br>') : 'Multiple AML Indicators'],
    ...(totalAmount > 0 ? [['Total Amount Involved', `<span class="mono">${fmtUSD(totalAmount)}</span>`]] : []),
    ...(structEntry?.date_range ? [[
      'Activity Period',
      `${fmtTS(structEntry.date_range.first)} — ${fmtTS(structEntry.date_range.last)}`,
    ]] : []),
    ...(layerPath?.time_span_hours != null ? [[
      'Chain Time Span',
      `${layerPath.time_span_hours.toFixed(1)} hours`,
    ]] : []),
  ])

  // ── Part III — Narrative ──────────────────────────────────────────────────
  const part3 = `<div class="narrative">${exp.explanation ?? '—'}</div>`

  // ── Part IV — Evidence cited ──────────────────────────────────────────────
  const citedItems = (exp.evidence_cited ?? [])
    .map(e => `<div class="evidence-item">${e}</div>`).join('')

  const signalRows = signals.map(s => `
    <tr>
      <td class="mono">${s.signal}</td>
      <td class="mono right">${typeof s.value === 'number' ? s.value.toLocaleString('en-US', { maximumFractionDigits: 4 }) : s.value}</td>
      <td>${s.label}</td>
      <td class="mono center">${s.weight != null ? (s.weight * 100).toFixed(0) + '%' : '—'}</td>
    </tr>`).join('')

  const part4 = `
    ${citedItems ? `
      <p style="font-size:9pt;font-weight:bold;margin-bottom:5pt">Evidence Cited in Narrative</p>
      <div style="border:1px solid #ccc;margin-bottom:10pt">${citedItems}</div>` : ''}
    ${signalRows ? `
      <p style="font-size:9pt;font-weight:bold;margin-bottom:5pt">Classifier Contributing Signals</p>
      <table>
        <tr><th>Signal ID</th><th>Value</th><th>Description</th><th>Weight</th></tr>
        ${signalRows}
      </table>` : '<p style="font-size:9pt;color:#666">No structured signal data available.</p>'}
  `

  // ── Part V — Structuring transactions ────────────────────────────────────
  let part5 = ''
  if (structEntry?.transactions?.length) {
    const shown = structEntry.transactions.slice(0, 15)
    const rows  = shown.map(txn => `
      <tr>
        <td class="mono">${fmtTS(txn.timestamp)}</td>
        <td class="mono right">${fmtUSD(txn.amount)}</td>
        <td class="mono right">${fmtUSD(txn.distance_from_threshold)}&nbsp;(${txn.pct_below_threshold?.toFixed(1) ?? '—'}%)</td>
        <td class="mono">${txn.transaction_id ?? '—'}</td>
      </tr>`).join('')
    const more = structEntry.transactions.length > 15
      ? `<tr><td colspan="4" style="font-size:8pt;color:#666;text-align:center">
           + ${structEntry.transactions.length - 15} additional transactions not shown
         </td></tr>` : ''
    part5 = `
      <p style="font-size:9pt;margin-bottom:5pt">
        <strong>${structEntry.near_threshold_txn_count}</strong> near-threshold transaction(s) detected.
        Reporting threshold: <strong>${fmtUSD(structEntry.threshold ?? 10000)}</strong>.
        Total structured: <strong>${fmtUSD(structEntry.total_amount_structured)}</strong>.
      </p>
      <table>
        <tr>
          <th>Timestamp</th>
          <th>Amount</th>
          <th>Below Limit</th>
          <th>Transaction ID</th>
        </tr>
        ${rows}${more}
      </table>`
  }

  // ── Part VI — Smurfing network ────────────────────────────────────────────
  let part6 = ''
  if (smurfEntry) {
    const sentRows = (smurfEntry.counterparties_sent_to ?? []).map(cp =>
      `<tr><td class="mono">${cp}</td><td class="center">Sent</td></tr>`).join('')
    const recvRows = (smurfEntry.counterparties_received_from ?? []).map(cp =>
      `<tr><td class="mono">${cp}</td><td class="center">Received</td></tr>`).join('')
    part6 = `
      <p style="font-size:9pt;margin-bottom:5pt">
        Fan-out degree: <strong>${smurfEntry.fan_out_degree}</strong> &nbsp;|&nbsp;
        Fan-in degree: <strong>${smurfEntry.fan_in_degree}</strong> &nbsp;|&nbsp;
        Total sent: <strong>${fmtUSD(smurfEntry.total_sent)}</strong> &nbsp;|&nbsp;
        Total received: <strong>${fmtUSD(smurfEntry.total_received)}</strong>
      </p>
      <table>
        <tr><th>Counterparty Account</th><th>Direction</th></tr>
        ${sentRows}${recvRows}
      </table>`
  }

  // ── Part VII — Layering chain ─────────────────────────────────────────────
  let part7 = ''
  if (layerPath?.path?.length) {
    const { path, transaction_ids = [], hop_count, total_amount, time_span_hours } = layerPath
    const nodeColors = {
      0:              '#7c2d12',  // origin — dark amber
      [path.length-1]:'#14532d',  // destination — dark green
    }
    const chainNodes = path.map((node, i) => {
      const color = nodeColors[i] ?? '#1e3a5f'
      const label = i === 0 ? 'ORIGIN' : i === path.length - 1 ? 'DEST' : `HOP ${i}`
      const txnId = transaction_ids[i] ? `<div style="font-size:7pt;color:#888">${transaction_ids[i].slice(-8)}</div>` : ''
      return `
        <div style="display:flex;flex-direction:column;align-items:center;gap:2pt">
          <span style="font-size:7pt;color:${color};font-weight:bold">${label}</span>
          <span class="chain-node" style="color:${color};border-color:${color}">${node}</span>
          ${txnId}
        </div>
        ${i < path.length - 1 ? '<span class="chain-arrow">→</span>' : ''}`
    }).join('')

    const hopRows = path.slice(0, -1).map((node, i) => `
      <tr>
        <td class="center mono">${i + 1}</td>
        <td class="mono">${node}</td>
        <td class="mono">${path[i + 1]}</td>
        <td class="mono">${transaction_ids[i] ?? '—'}</td>
      </tr>`).join('')

    part7 = `
      <p style="font-size:9pt;margin-bottom:5pt">
        Hop count: <strong>${hop_count}</strong> &nbsp;|&nbsp;
        Total amount: <strong>${fmtUSD(total_amount)}</strong> &nbsp;|&nbsp;
        Time span: <strong>${time_span_hours?.toFixed(1) ?? '—'} hours</strong>
      </p>
      <div class="chain" style="margin-bottom:8pt">${chainNodes}</div>
      <table>
        <tr><th>Hop</th><th>From Account</th><th>To Account</th><th>Transaction ID</th></tr>
        ${hopRows}
      </table>`
  }

  // ── Assemble ──────────────────────────────────────────────────────────────
  const sections = [
    ['Part I — Filing Information',                part1],
    ['Part II — Subject Account Information',      part2],
    ['Part III — Suspicious Activity Narrative',   part3],
    ['Part IV — Supporting Evidence',              part4],
    ...(part5 ? [['Part V — Structuring Transactions',  part5]] : []),
    ...(part6 ? [['Part VI — Network Dispersal Detail', part6]] : []),
    ...(part7 ? [['Part VII — Layering Chain Detail',   part7]] : []),
    ['Part VIII — Analyst Certification', `
      <div class="cert-box">
        <p class="cert-text">
          I certify that the information provided in this Suspicious Activity Report is accurate
          and complete to the best of my knowledge, and that I have investigated the subject
          account activity to the extent practicable. I understand that filing a knowingly false
          SAR is a federal criminal offense. This report was generated by the FinSherlock AI
          system and requires human review and approval prior to submission to FinCEN.
        </p>
        ${signaturesHTML(['Analyst Signature', 'Printed Name / Title', 'Supervisor Approval', 'Filing Date'])}
      </div>`],
  ]

  const sectionsHTML = sections.map(([title, body]) => `
    <div class="section">
      <div class="section-title">${title}</div>
      ${body}
    </div>`).join('')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>SAR Draft — ${exp.account_id} — ${date}</title>
  <style>${CSS}</style>
</head>
<body>
  <div class="toolbar">
    <span>FinSherlock AI &nbsp;·&nbsp; SAR Draft Report &nbsp;·&nbsp; ${exp.account_id}</span>
    <button onclick="window.print()">Print / Export PDF &nbsp;↗</button>
  </div>

  <div class="rpt-header">
    <h1>Suspicious Activity Report — Draft</h1>
    <div class="sub">Bank Secrecy Act &nbsp;·&nbsp; FinCEN BSA Form 111 &nbsp;·&nbsp; For Compliance Review Only</div>
  </div>

  <div class="confidential">Confidential &nbsp;—&nbsp; For Internal Compliance Use Only &nbsp;—&nbsp; Do Not Distribute</div>

  ${sectionsHTML}

  <div class="rpt-footer">
    FinSherlock AI &nbsp;·&nbsp; Automated AML Detection System &nbsp;·&nbsp;
    Report ID: ${reportId} &nbsp;·&nbsp; Generated: ${date}<br>
    This is a system-generated draft. Human review, legal counsel, and supervisor approval
    are required before submission to FinCEN.
  </div>
</body>
</html>`
}

/**
 * Open the generated SAR HTML in a new browser tab.
 */
export function openSAR(sarArgs) {
  const html = generateSAR(sarArgs)
  const blob = new Blob([html], { type: 'text/html' })
  const url  = URL.createObjectURL(blob)
  window.open(url, '_blank')
  // Revoke after a short delay to allow the tab to load
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
