# FinSherlock AI

**Agentic Anti-Money Laundering Investigation Platform**

FinSherlock AI is an AI-powered AML analyst. Ask a question in plain English — the system decides what analysis to run, executes it, and returns evidence-backed findings with an escalation recommendation, a SHAP feature breakdown, and a SAR draft ready to export.

---

## How It Works

Most fraud-detection tools run every transaction through the same fixed pipeline regardless of what was asked. FinSherlock AI separates two responsibilities:

- **Planner (Brain 1)** — a large language model reads the analyst's query, identifies intent, extracts filters, and emits a structured JSON execution plan naming only the tools needed to answer *this specific question*.
- **Tool Layer (Brain 2)** — independent, deterministic analytical tools (EDA, feature engineering, anomaly detection, graph analysis, ML scoring, SHAP explanation) do the actual number-crunching.

**The LLM never decides whether something is fraud.** It only decides which tools to call and in what order. All fraud decisions are made by deterministic code — keeping the system fully explainable and auditable.

**Proof of "agentic, not pipeline":**

| Query | Tools called |
|---|---|
| `"Find structuring patterns in the last 30 days"` | `run_eda → detect_structuring → classify_risk → explain_flag` |
| `"Explain customer 1098"` | `engineer_features → explain_flag` — EDA and graph skipped entirely |
| `"Show smurfing network"` | `detect_smurfing → detect_layering → classify_risk → explain_flag` |

---

## AML Typologies Detected

| Typology | What it looks like | Detection method |
|---|---|---|
| **Structuring** | Deposits clustered just below the $10,000 CTR threshold | Near-threshold count per account in rolling window |
| **Smurfing** | Large sum split across many small transfers to multiple accounts | Fan-in / fan-out degree in the transaction graph |
| **Layering** | Funds passed through a chain of intermediary accounts | Multi-hop DFS path detection with time-gap constraints |
| **Anomaly** | Statistically unusual patterns not matching a known typology | IsolationForest on engineered features |

---

## System Architecture

```
ANALYST QUERY (natural language)
        │
        ▼
┌──────────────────────┐
│     PLANNER AGENT    │  ← LLM (Groq Llama / Gemini) via litellm
│  intent · filters    │    or deterministic keyword fallback
│  target pattern      │
└──────────┬───────────┘
           │  JSON execution plan
   ┌───────┼──────┬─────────┬──────────┬──────────┐
   ▼       ▼      ▼         ▼          ▼          ▼
  EDA   Feature Anomaly   Graph     ML Risk    SHAP
       Eng    Detection  Analysis   Score    Explain
   └───────┴──────┴─────────┴──────────┴──────────┘
                        │
               ┌────────▼─────────┐
               │  Risk Classifier │  composite score (0–100)
               │  + Explainer     │  grounded NL, evidence-cited
               └────────┬─────────┘
                        │
               ┌────────▼────────────────────────────┐
               │  REACT DASHBOARD                    │
               │  Investigation · Watchlist · Cases  │
               │  Live Stream · SAR Export           │
               └─────────────────────────────────────┘
```

---

## Features

### Investigation Engine
- Natural-language query → agentic tool selection → streamed results (SSE)
- Execution plan rendered live as tools complete
- Per-account risk gauge (0–100 composite score) with escalation recommendation (`report / review / monitor`)
- Evidence-cited NL explanations grounded only in what the tools actually found

### SHAP Per-Transaction Explanations
- On-demand SHAP breakdown for the highest-risk transaction per account
- Shows which features drove the ML score up or down (log-odds), rendered as a diverging bar chart
- Narrative: *"Scored 0.94 because: Format: Bitcoin (+0.28); Hour of day 02:00 (+0.21); Sender unique receivers (+0.19). Base rate: 0.497."*

### XGBoost ML Baseline
- Supervised classifier trained on the IBM HI-Small labeled dataset (5M rows)
- 42 features: degree centrality, log amount, amount entropy, hour-of-day / day-of-week one-hots, payment format one-hots
- F1-tuned threshold; hot-reloadable after retraining without server restart

### Case Management
- Create and track investigation cases per account
- Status lifecycle: `open → under_review → escalated → closed`
- Resolution tagging: `true_positive / false_positive` (only settable on closed cases)
- Analyst notes, assigned reviewer, risk score, and investigation query stored per case

### Active Learning
- Analyst TP/FP feedback stored and linked to cases
- One-click model retraining from the Cases dashboard
- Feedback stats (precision, label counts) surfaced in the UI

### Risk Watchlist
- ML-scored ranked list of all accounts in the database
- Temporal risk evolution: 7 / 30 / 90-day windows per account
- Sparkline trend indicators; expandable row with full temporal table

### Live Transaction Stream
- Replays the IBM AML CSV chronologically into DuckDB at adjustable speed (0.1×–10,000×)
- Real-time structuring and large-transaction alerts via SSE
- Alert deduplication — each distinct pattern fires exactly once
- Pause / resume / stop controls; progress bar

### SAR Export
- Generates a formatted Suspicious Activity Report HTML page per flagged account
- Includes risk score, typology evidence, layering path, smurfing network, and SHAP explanation
- Printable to PDF directly from the browser

---

## Folder Structure

```
backend/
├── main.py                        # FastAPI app — REST + SSE routes
├── stream_simulator.py            # Live transaction stream engine
├── agent/
│   ├── registry.py                # @tool decorator + TOOL_REGISTRY
│   ├── planner.py                 # LLM plan chain + deterministic fallback
│   └── orchestrator.py            # Sequential plan execution + error isolation
├── tools/
│   ├── eda.py                     # run_eda — dataset statistics
│   ├── feature_engineering.py     # engineer_features — per-account features
│   ├── anomaly_detection.py       # detect_anomalies — IsolationForest
│   ├── graph_analysis.py          # detect_smurfing, detect_layering — NetworkX
│   ├── advanced_graph.py          # extended graph metrics
│   ├── risk_classifier.py         # classify_risk — composite 0–100 score
│   ├── explainer.py               # explain_flag — NL explanation engine
│   ├── ml_risk_score.py           # ml_risk_score — XGBoost inference
│   ├── temporal_analysis.py       # temporal_analysis — multi-window ML scoring
│   └── shap_explain.py            # shap_explain — per-transaction SHAP values
├── data/
│   ├── db.py                      # DuckDB connection + schema init
│   ├── schema.sql                 # transactions / cases / analyst_feedback tables
│   ├── models/
│   │   └── xgb_baseline.joblib    # trained XGBoost model (gitignored)
│   └── raw/                       # IBM AML CSVs (gitignored)
├── scripts/
│   ├── load_data.py               # one-shot CSV → DuckDB loader
│   ├── train_xgboost_baseline.py  # train + save XGBoost model
│   ├── retrain_with_feedback.py   # fine-tune on analyst feedback labels
│   └── evaluate_detection.py      # precision / recall vs ground truth
└── tests/
    ├── conftest.py                # shared in-memory DuckDB fixture
    ├── test_tools.py              # EDA + feature engineering
    ├── test_planner.py            # deterministic fallback routing
    ├── test_orchestrator.py       # plan execution + error isolation
    ├── test_cases.py              # case CRUD + state machine
    ├── test_stream.py             # stream simulator + alert deduplication
    ├── test_shap.py               # SHAP explainer + label helpers
    ├── test_graph_analysis.py     # smurfing + layering detection
    ├── test_detection.py          # structuring / anomaly detection
    └── test_feedback.py           # analyst feedback + active learning

frontend/src/
├── App.jsx              # root — tab routing, SSE investigation loop
├── QueryPanel.jsx       # natural-language input + preset chips
├── ExecutionPlan.jsx    # live tool-by-tool progress visualization
├── FindingCard.jsx      # per-account risk card + SHAP panel + SAR export
├── RiskGauge.jsx        # SVG arc gauge (0–100)
├── GraphView.jsx        # smurfing / layering network graph
├── HeatmapView.jsx      # transaction heatmap by hour-of-day
├── TimelineView.jsx     # structuring timeline visualization
├── Sparkline.jsx        # mini trend chart for watchlist rows
├── Watchlist.jsx        # ML watchlist + temporal expansion
├── Cases.jsx            # case management CRUD + active learning dashboard
├── LiveStream.jsx       # real-time transaction feed + alert panel
├── MetricsPanel.jsx     # model metrics (precision, recall, AUC)
├── ErrorBoundary.jsx    # React error boundary
└── sarExport.js         # SAR HTML generation
```

---

## Dataset

**IBM Transactions for Anti-Money Laundering (AML)**
- Kaggle: [`ealtman2019/ibm-transactions-for-anti-money-laundering-aml`](https://www.kaggle.com/datasets/ealtman2019/ibm-transactions-for-anti-money-laundering-aml)
- Synthetic dataset generated by IBM Research with realistic AML patterns and ground-truth laundering labels
- Use `HI-Small_Trans.csv` (~5M rows) for training and the live stream simulation

**Column mapping** (the loader auto-detects case-insensitively):

| Internal name | Source columns |
|---|---|
| `transaction_id` | `TRANSACTION_ID`, `id`, `Index` |
| `timestamp` | `TIMESTAMP`, `Timestamp`, `Date` |
| `sender_account_id` | `Account`, `FROM_ACCOUNT` |
| `receiver_account_id` | `Account.1`, `TO_ACCOUNT` |
| `amount` | `Amount Paid`, `AMOUNT` |
| `currency` | `Payment Currency`, `CURRENCY` |
| `channel` | `Payment Format`, `CHANNEL` |
| `is_laundering` | `Is Laundering`, `IS_LAUNDERING` |

---

## Setup

**Requirements:** Python 3.11+, Node.js 18+

### Backend

```bash
cd backend

# Create virtual environment
python3.11 -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Configure LLM API keys (optional — system works without them)
cp .env.example .env
# Add GROQ_API_KEY and/or GEMINI_API_KEY
```

### Frontend

```bash
cd frontend
npm install
```

---

## Loading the Dataset

Place `HI-Small_Trans.csv` at `backend/data/raw/HI-Small_Trans.csv`, then:

```bash
cd backend

# Load full dataset (~5M rows, takes 30–60s)
.venv/bin/python scripts/load_data.py

# Load a sample for development
.venv/bin/python scripts/load_data.py --limit 100000

# Load from a custom path
.venv/bin/python scripts/load_data.py --csv /path/to/file.csv
```

---

## Training the ML Model

```bash
cd backend

# Train XGBoost baseline (requires data loaded first)
.venv/bin/python scripts/train_xgboost_baseline.py

# Retrain with analyst feedback labels
.venv/bin/python scripts/retrain_with_feedback.py
```

The trained model is saved to `data/models/xgb_baseline.joblib` and hot-reloaded by the running API without a restart.

---

## Running

```bash
# Terminal 1 — backend
cd backend
.venv/bin/uvicorn main:app --reload
# API:     http://localhost:8000
# Swagger: http://localhost:8000/docs

# Terminal 2 — frontend
cd frontend
npm run dev
# UI: http://localhost:5173
```

---

## API Reference

### Investigation

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/investigate` | Run full investigation, return complete JSON |
| `POST` | `/investigate/stream` | Run investigation with SSE streaming |
| `POST` | `/tools/{name}` | Call any registered tool directly |
| `GET` | `/tools` | List all registered tools |
| `GET` | `/tools/llm-schemas` | OpenAI-compatible function-calling schemas |

```bash
curl -X POST http://localhost:8000/investigate \
  -H "Content-Type: application/json" \
  -d '{"query": "Find structuring patterns in the last 30 days"}'
```

### Case Management

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/cases` | List cases (filter by status, limit) |
| `POST` | `/cases` | Create a new investigation case |
| `GET` | `/cases/{id}` | Get a single case |
| `PATCH` | `/cases/{id}` | Update status, resolution, notes, assignee |
| `DELETE` | `/cases/{id}` | Delete a case |

### Analyst Feedback

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/feedback` | Submit a TP/FP label for an account |
| `GET` | `/feedback/stats` | Label counts and precision |
| `POST` | `/feedback/retrain` | Retrain model with accumulated feedback |

### Watchlist

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/watchlist` | ML-ranked account list |
| `GET` | `/watchlist/temporal` | Multi-window risk evolution per account |

### Live Stream

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/stream/start` | Start stream simulation |
| `POST` | `/stream/stop` | Stop simulation |
| `POST` | `/stream/pause` | Pause simulation |
| `POST` | `/stream/resume` | Resume simulation |
| `GET` | `/stream/status` | Current stream status |
| `GET` | `/stream/events` | SSE feed (transactions + alerts) |

---

## Running Tests

Tests use an in-memory DuckDB seeded with synthetic rows — no real dataset or API keys needed.

```bash
cd backend
.venv/bin/python -m pytest tests/ -v
# 225 passed, 3 skipped
```

| Test file | What it covers |
|---|---|
| `test_tools.py` | `run_eda`, `engineer_features` correctness |
| `test_planner.py` | Deterministic fallback routing (zero API calls) |
| `test_orchestrator.py` | Plan execution, result structure, error isolation |
| `test_cases.py` | Case CRUD, status state machine, resolution guard |
| `test_stream.py` | Stream simulator, alert deduplication, txn ID uniqueness |
| `test_shap.py` | SHAP output structure, feature labels, graceful degradation |
| `test_graph_analysis.py` | Smurfing fan-out/in, layering path detection |
| `test_detection.py` | Structuring threshold detection, anomaly scoring |
| `test_feedback.py` | Feedback submission, stats, retrain trigger |

---

## LLM Configuration

The system works fully offline using the deterministic keyword-based planner. To enable LLM planning:

```env
# backend/.env
GROQ_API_KEY=your_key_here       # https://console.groq.com/keys
GEMINI_API_KEY=your_key_here     # https://aistudio.google.com/app/apikey
```

**Provider fallback order:** Groq (Llama 3.3 70B) → Gemini 2.0 Flash → deterministic keyword fallback

If both APIs fail or rate-limit, the deterministic fallback activates automatically — the demo never goes dark.

---

## Adding a New Tool

Every new analytical capability is a single decorated function:

```python
# tools/my_tool.py
from pydantic import BaseModel
from agent.registry import tool

class MyToolArgs(BaseModel):
    account_ids: list[str] | None = None
    window_days: int = 30

@tool(
    name="my_tool",
    description="What this tool does — shown to the LLM and in Swagger",
    schema=MyToolArgs,
)
def my_tool(args: MyToolArgs) -> dict:
    ...
    return {"result": ...}
```

Then add one line to `tools/__init__.py`:

```python
from tools import my_tool  # noqa: F401
```

The tool automatically appears in `/tools/llm-schemas` (the LLM can plan with it), `POST /tools/my_tool` (Swagger), and the test suite.

---

## Key Design Decisions

| Decision | Rationale |
|---|---|
| LLM plans, code decides | LLM output is unreliable for binary fraud decisions; deterministic rules are auditable and explainable |
| DuckDB, not PostgreSQL | Columnar OLAP, zero server process, fast aggregations on millions of rows, trivial CI/test setup |
| SSE streaming | Results render progressively as each tool completes — investigation feels live even on slow queries |
| SHAP on-demand | Computing SHAP for all accounts on every query is too slow; analysts request it per-card |
| Alert deduplication | Stream simulator re-runs detection every batch — dedup set prevents alert storms |
| Active learning loop | Analyst labels feed back into the model, improving precision over time without full retraining |
| No GNN / PyTorch | NetworkX DFS covers the required typologies without CUDA or training infrastructure |

---

## AI and Tool Disclosure

| Component | Technology | Role |
|---|---|---|
| **Planner** | Llama 3.3 70B (Groq) / Gemini 2.0 Flash (Google AI Studio) via `litellm` | Parse query intent → structured execution plan. Never makes fraud decisions. |
| **ML classifier** | XGBoost trained on IBM HI-Small 5M row dataset | Binary fraud probability per transaction (0–1) |
| **SHAP explainer** | `shap.TreeExplainer` | Per-transaction feature attribution in log-odds space |
| **Anomaly detection** | Scikit-learn `IsolationForest` | Detects statistically unusual patterns outside known typologies |
| **Graph analysis** | NetworkX | Smurfing (fan-out) and layering (multi-hop path) detection |

All fraud-detection decisions are made by deterministic code. The LLM's only role is to select which tools to invoke for a given query.
