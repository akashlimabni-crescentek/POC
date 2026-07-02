#!/usr/bin/env node
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'backend', '.env') });

const { buildWsAuthHeaders } = require('../backend/lib/kalshi-client');
const { KALSHI } = require('../backend/config/providers');

const headers = buildWsAuthHeaders();

console.log('Kalshi WebSocket URL (use wss):');
console.log(KALSHI.wsUrl);
console.log('');
console.log('Copy the block below into Postman → Headers → Bulk Edit');
console.log('(Paste all 3 lines at once, then Connect within 5 seconds)');
console.log('Tip: Kalshi rejects expired timestamps — use npm run kalshi:ws-proxy for Postman instead.');
console.log('');
console.log(
  [
    `KALSHI-ACCESS-KEY:${headers['KALSHI-ACCESS-KEY']}`,
    `KALSHI-ACCESS-TIMESTAMP:${headers['KALSHI-ACCESS-TIMESTAMP']}`,
    `KALSHI-ACCESS-SIGNATURE:${headers['KALSHI-ACCESS-SIGNATURE']}`,
  ].join('\n')
);
console.log('');
console.log('Signed message (debug):');
console.log(`${headers['KALSHI-ACCESS-TIMESTAMP']}GET/trade-api/ws/v2`);
