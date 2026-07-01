#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const {
  validateBackendEnv,
  validateFrontendEnv,
} = require('../backend/config/validate-env');

const args = new Set(process.argv.slice(2));
const backendOnly = args.has('--backend-only');
const frontendOnly = args.has('--frontend-only');
const requireKalshi = args.has('--kalshi');

const repoRoot = path.join(__dirname, '..');
const frontendEnvPath = path.join(repoRoot, 'frontend', '.env.local');

if (!frontendOnly) {
  dotenv.config({ path: path.join(repoRoot, 'backend', '.env') });
}

let frontendEnvFileContent = '';
let frontendVars = {};

if (!backendOnly) {
  frontendEnvFileContent = fs.readFileSync(frontendEnvPath, 'utf8');
  frontendVars = dotenv.parse(frontendEnvFileContent);
  dotenv.config({ path: frontendEnvPath });
}

try {
  if (!frontendOnly) {
    validateBackendEnv({ requireKalshi });
    console.log('[validate-env] backend OK');
  }

  if (!backendOnly) {
    validateFrontendEnv({ vars: frontendVars, frontendEnvFileContent });
    console.log('[validate-env] frontend OK');
  }

  console.log('[validate-env] all checks passed');
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
