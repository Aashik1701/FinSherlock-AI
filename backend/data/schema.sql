-- FinSherlock AI — core AML schema
-- Designed for DuckDB (columnar OLAP); window functions, rolling aggregations are native.

CREATE TABLE IF NOT EXISTS transactions (
    transaction_id      VARCHAR PRIMARY KEY,
    timestamp           TIMESTAMP NOT NULL,
    sender_account_id   VARCHAR   NOT NULL,
    receiver_account_id VARCHAR   NOT NULL,
    amount              DOUBLE    NOT NULL,
    currency            VARCHAR   DEFAULT 'USD',
    transaction_type    VARCHAR,   -- cash_deposit / wire / transfer / withdrawal / crypto
    country             VARCHAR,
    channel             VARCHAR,
    is_laundering       BOOLEAN   DEFAULT FALSE   -- label from IBM AML dataset
);

CREATE TABLE IF NOT EXISTS accounts (
    account_id                      VARCHAR PRIMARY KEY,
    customer_id                     VARCHAR,
    account_open_date               DATE,
    segment                         VARCHAR,   -- retail / corporate / private-banking
    country                         VARCHAR,
    historical_avg_transaction_amount DOUBLE   -- populated by feature engineering
);

-- Derived feature table written by engineer_features tool
CREATE TABLE IF NOT EXISTS account_features (
    account_id              VARCHAR,
    window_days             INTEGER,
    computed_at             TIMESTAMP,
    txn_count               INTEGER,
    total_volume            DOUBLE,
    avg_amount              DOUBLE,
    std_amount              DOUBLE,
    velocity                DOUBLE,   -- txn_count / window_days
    max_single_amount       DOUBLE,
    amount_deviation_pct    DOUBLE,   -- (avg_amount - historical_avg) / historical_avg * 100
    near_threshold_count    INTEGER,  -- txns within 5 % of 10 000 reporting threshold
    PRIMARY KEY (account_id, window_days, computed_at)
);

-- Case management table for investigation tracking
CREATE TABLE IF NOT EXISTS cases (
    case_id         VARCHAR PRIMARY KEY,
    account_id      VARCHAR NOT NULL,
    status          VARCHAR NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'under_review', 'escalated', 'closed')),
    query_text      TEXT,
    risk_score      DOUBLE,
    findings_json   JSON,
    resolution      VARCHAR CHECK (resolution IN ('true_positive', 'false_positive', NULL)),
    created_by      VARCHAR DEFAULT 'analyst',
    assigned_to     VARCHAR,
    notes           TEXT,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_cases_status ON cases(status);
CREATE INDEX IF NOT EXISTS idx_cases_account ON cases(account_id);

-- Analyst feedback table — labels for active learning / model retraining
CREATE TABLE IF NOT EXISTS analyst_feedback (
    feedback_id     VARCHAR PRIMARY KEY,
    account_id      VARCHAR NOT NULL,
    case_id         VARCHAR,
    label           BOOLEAN NOT NULL,       -- true = true_positive, false = false_positive
    risk_score      DOUBLE,                 -- model score at time of labeling
    model_version   VARCHAR,                -- which model version produced the score
    query_text      TEXT,                   -- the investigation query that surfaced this
    transaction_ids JSON,                   -- optional: specific txn IDs flagged
    notes           TEXT,
    created_by      VARCHAR DEFAULT 'analyst',
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_feedback_account ON analyst_feedback(account_id);
CREATE INDEX IF NOT EXISTS idx_feedback_label ON analyst_feedback(label);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON analyst_feedback(created_at);
