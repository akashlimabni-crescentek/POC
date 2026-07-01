'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { createClient } = require('@supabase/supabase-js');
const { readEnv, assertNonEmpty } = require('./validate-env');

const supabaseUrl = readEnv('SUPABASE_URL');
const supabaseServiceRoleKey = readEnv('SUPABASE_SERVICE_ROLE_KEY');

assertNonEmpty('SUPABASE_URL', supabaseUrl);
assertNonEmpty('SUPABASE_SERVICE_ROLE_KEY', supabaseServiceRoleKey);

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});

module.exports = { supabase };
