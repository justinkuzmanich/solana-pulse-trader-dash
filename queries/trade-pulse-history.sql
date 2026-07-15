-- Solana Trade Pulse — HISTORY query (generated; do not edit by hand)
-- Last 5 complete UTC days of terminal volume. Columns: t (epoch sec), v (USD)
WITH fee_accounts (terminal, address) AS (
  VALUES
    ('Axiom', '7oi1L8U9MRu5zDz5syFahsiLUric47LzvJBQX6r827ws'),
    ('Axiom', '9kPrgLggBJ69tx1czYAbp7fezuUmL337BsqQTKETUEhP'),
    ('Axiom', 'DKyUs1xXMDy8Z11zNsLnUg3dy9HZf6hYZidB6WodcaGy'),
    ('Axiom', '4FobGn5ZWYquoJkxMzh2VUAWvV36xMgxQ3M7uG1pGGhd'),
    ('Axiom', '76sxKrPtgoJHDJvxwFHqb3cAXWfRHFLe3VpKcLCAHSEf'),
    ('Axiom', 'H2cDR3EkJjtTKDQKk8SJS48du9mhsdzQhy8xJx5UMqQK'),
    ('Axiom', '8m5GkL7nVy95G4YVUbs79z873oVKqg2afgKRmqxsiiRm'),
    ('Axiom', '4kuG6NsAFJNwqEkac8GFDMMheCGKUPEbaRVHHyFHSwWz'),
    ('Axiom', '8vFGAKdwpn4hk7kc1cBgfWZzpyW3MEMDATDzVZhddeQb'),
    ('Axiom', '86Vh4XGLW2b6nvWbRyDs4ScgMXbuvRCHT7WbUT3RFxKG'),
    ('Axiom', 'DZfEurFKFtSbdWZsKSDTqpqsQgvXxmESpvRtXkAdgLwM'),
    ('Axiom', '5L2QKqDn5ukJSWGyqR4RPvFvwnBabKWqAqMzH4heaQNB'),
    ('Axiom', 'DYVeNgXGLAhZdeLMMYnCw1nPnMxkBN7fJnNpHmizTrrF'),
    ('Axiom', 'Hbj6XdxX6eV4nfbYTseysibp4zZJtVRRPn2J3BhGRuK9'),
    ('Axiom', '846ah7iBSu9ApuCyEhA5xpnjHHX7d4QJKetWLbwzmJZ8'),
    ('Axiom', '5BqYhuD4q1YD3DMAYkc1FeTu9vqQVYYdfBAmkZjamyZg'),
    ('Axiom', '7LCZckF6XXGQ1hDY6HFXBKWAtiUgL9QY5vj1C4Bn1Qjj'),
    ('Axiom', '4V65jvcDG9DSQioUVqVPiUcUY9v6sb6HKtMnsxSKEz5S'),
    ('Axiom', 'CeA3sPZfWWToFEBmw5n1Y93tnV66Vmp8LacLzsVprgxZ'),
    ('Axiom', 'AaG6of1gbj1pbDumvbSiTuJhRCRkkUNaWVxijSbWvTJW'),
    ('Photon', 'AVUCZyuT35YSuj4RH7fwiyPu82Djn2Hfg7y2ND2XcnZH'),
    ('GMGN', 'BB5dnY55FXS1e1NXqZDwCzgdYJdMCj3B92PU6Q5Fb6DT'),
    ('GMGN', '7sHXjs1j7sDJGVSMSPjD1b4v3FD6uRSvRWfhRdfv5BiA'),
    ('GMGN', 'HeZVpHj9jLwTVtMMbzQRf6mLtFPkWNSg11o68qrbUBa3'),
    ('GMGN', 'ByRRgnZenY6W2sddo1VJzX9o4sMU4gPDUkcmgrpGBxRy'),
    ('GMGN', 'DXfkEGoo6WFsdL7x6gLZ7r6Hw2S6HrtrAQVPWYx2A1s9'),
    ('GMGN', '3t9EKmRiAUcQUYzTZpNojzeGP1KBAVEEbDNmy6wECQpK'),
    ('GMGN', 'DymeoWc5WLNiQBaoLuxrxDnDRvLgGZ1QGsEoCAM7Jsrx'),
    ('GMGN', 'dBhdrmwBkRa66XxBuAK4WZeZnsZ6bHeHCCLXa3a8bTJ'),
    ('GMGN', '6TxjC5wJzuuZgTtnTMipwwULEbMPx5JPW3QwWkdTGnrn'),
    ('BullX', '9RYJ3qr5eU5xAooqVcbmdeusjcViL5Nkiq7Gske3tiKq'),
    ('BullX', 'F4hJ3Ee3c5UuaorKAMfELBjYCjiiLH75haZTKqTywRP3'),
    ('Trojan', '9yMwSPk9mrXSN7yDHUuZurAh1sjbJsfpUqjZ7SvVtdco'),
    ('Trojan', '92Med3qeK7duC5iiYsHX38H2f2twJfRsSx93oNrza2VH'),
    ('Trojan', '2jwHNxavSoMZMEDbT1eV9PcPt5dDcayCqM6MkgaPpmWQ'),
    ('Trojan', '65gDv7pZQCZELsNpNYSFEBtNFpWZAbxmRFB6BGMqFkHH'),
    ('Trojan', 'BWgb8wR1FEGiu1jCDSKuHKf752W27b4iN6SvoNCiK4qp'),
    ('Trojan', '8jgg7moFJkHyTtAv9M6RBSPMp2oXeXhuiUMKW8YbYCWn'),
    ('Trojan', 'BBYXdwhqbCxVRVtnuMTTxh8biNisz3ZxsnHfr44jXytR'),
    ('Phantom', '25mYnjJ2MXHZH6NvTTdA63JvjgRVcuiaj6MRiEQNs1Dq'),
    ('Phantom', '9yj3zvLS3fDMqi1F8zhkaWfq8TZpZWHe6cz1Sgt7djXf'),
    ('Phantom', '8psNvWTrdNTiVRNzAgsou9kETXNJm2SXZyaKuJraVRtf'),
    ('Phantom', 'tzvXws1qhmfdPkPcprezULCDQPAJqzPhbZ3SMrqRPNE'),
    ('Phantom', 'CnmA6Zb8hLrG33AT4RTzKdGv1vKwRBKQQr8iNckvv8Yg'),
    ('Phantom', '2rQZb9xqQGwoCMDkpabbzDB9wyPTjSPj9WNhJodTaRHm'),
    ('Phantom', '9gnLg6NtVxaASvxtADLFKZ9s8yHft1jXb1Vu6gVKvh1J'),
    ('Phantom', 'wtpXRqKLdGc7vpReogsRugv6EFCw4HBHcxm8pFcR84a'),
    ('Phantom', 'D1NJy3Qq3RKBG29EDRj28ozbGwnhmM5yBUp8PonSYUnm')
),
fee_txs AS (
  SELECT f.terminal, aa.tx_id
  FROM solana.account_activity aa
  JOIN fee_accounts f ON aa.address = f.address
  WHERE aa.block_time >= date_trunc('day', now()) - interval '5' day
    AND aa.block_time < date_trunc('day', now())
    AND aa.tx_success = true
    AND aa.balance_change > 0
  UNION
  SELECT f.terminal, aa.tx_id
  FROM solana.account_activity aa
  JOIN fee_accounts f ON aa.token_balance_owner = f.address
  WHERE aa.block_time >= date_trunc('day', now()) - interval '5' day
    AND aa.block_time < date_trunc('day', now())
    AND aa.tx_success = true
    AND aa.token_balance_change > 0
),
term_trades AS (
  SELECT ft.terminal, t.tx_id, t.trader_id, t.amount_usd, t.block_time
  FROM dex_solana.trades t
  JOIN fee_txs ft ON t.tx_id = ft.tx_id
  WHERE t.block_time >= date_trunc('day', now()) - interval '5' day
    AND t.block_time < date_trunc('day', now())
),
launch_ix AS (
  SELECT block_time,
         CASE WHEN bytearray_substring(data, 1, 8) IN (0x181ec828051c0777)
              THEN 'created' ELSE 'migrated' END AS kind
  FROM solana.instruction_calls
  WHERE ((executing_account = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P' AND bytearray_substring(data, 1, 8) IN (0x181ec828051c0777, 0x9beae792ec9ea21e)))
    AND block_time >= date_trunc('day', now()) - interval '5' day
    AND block_time < date_trunc('day', now())
    AND tx_success = true
)
SELECT CAST(to_unixtime(date_trunc('day', block_time)) AS bigint) AS t,
       SUM(amount_usd) AS v
FROM term_trades
GROUP BY date_trunc('day', block_time)
ORDER BY t
