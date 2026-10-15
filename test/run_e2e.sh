#!/bin/bash
# Starts the fake services + the Worker (workerd, local D1), runs the e2e suite, then stops everything.
cd "$(dirname "$0")/.."
rm -rf .wrangler
cat > .dev.vars <<VARS
BOT_TOKEN=123456:TESTTOKEN
SECRET_KEY=test-secret-key-for-e2e
WEBHOOK_SECRET=whsecret123
ADMIN_IDS=1
TG_API_BASE=http://127.0.0.1:9999
EITAA_API_BASE=http://127.0.0.1:9999/api
EITAA_WEB_BASE=http://127.0.0.1:9999
OPENROUTER_BASE_URL=http://127.0.0.1:9999/llm
VARS
npx wrangler d1 migrations apply medyas-db --local >/tmp/migr.log 2>&1 || { cat /tmp/migr.log; exit 1; }
python3 test/mock_servers.py >/tmp/mock.log 2>&1 &
MOCK=$!
npx wrangler dev --local --port 8787 --test-scheduled >/tmp/wdev.log 2>&1 &
WD=$!
for i in $(seq 1 90); do curl -s -m 2 localhost:8787/health | grep -q ok && break; sleep 1; done
python3 test/e2e.py
RC=$?
kill $MOCK $WD 2>/dev/null; pkill -f workerd 2>/dev/null
exit $RC
