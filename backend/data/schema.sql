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
