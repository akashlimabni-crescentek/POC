#!/usr/bin/env node
'use strict';

/**
 * Test Kalshi WebSocket via local proxy (or direct).
 *
 *   npm run kalshi:ws-proxy    # terminal 1
 *   npm run kalshi:ws-test     # terminal 2
 */

const WebSocket = require('ws');

const url = process.env.KALSHI_WS_TEST_URL || 'ws://localhost:8787';
const ticker = process.argv[2] || 'KXMENWORLDCUP-26-FR';

const ws = new WebSocket(url);

ws.on('open', () => {
  console.log('Connected:', url);
  const subscribe = {
    id: 1,
    cmd: 'subscribe',
    params: {
      channels: ['ticker', 'trade'],
      market_tickers: [ticker],
    },
  };
  console.log('Sending subscribe for', ticker);
  ws.send(JSON.stringify(subscribe));
});

ws.on('message', (data) => {
  const text = data.toString();
  try {
    const json = JSON.parse(text);
    console.log(JSON.stringify(json, null, 2));
  } catch {
    console.log(text);
  }
});

ws.on('error', (err) => {
  console.error('WebSocket error:', err.message);
  console.error('Is the proxy running? npm run kalshi:ws-proxy');
});

ws.on('close', (code, reason) => {
  console.log('Closed:', code, reason?.toString() || '');
});

setTimeout(() => {
  console.log('Done (15s). Closing.');
  ws.close();
  process.exit(0);
}, 15_000);
