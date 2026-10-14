#!/bin/bash
# Starts the fake services + the Worker (workerd, local D1), runs the e2e suite, then stops everything.
cd "$(dirname "$0")/.."
rm -rf .wrangler && npx wrangler d1 migrations apply medyas-db --local >/dev/null 2>&1
grep -q RUBIKA_API_BASE .dev.vars 2>/dev/null || echo "RUBIKA_API_BASE=http://127.0.0.1:9999/rubika" >> .dev.vars
python3 test/mock_servers.py >/tmp/mock.log 2>&1 &
MOCK=$!
npx wrangler dev --local --port 8787 --test-scheduled >/tmp/wdev.log 2>&1 &
WD=$!
for i in $(seq 1 60); do curl -s -m 2 localhost:8787/health | grep -q ok && break; sleep 1; done
python3 test/e2e.py
RC=$?
kill $MOCK $WD 2>/dev/null; pkill -f workerd 2>/dev/null
exit $RC
