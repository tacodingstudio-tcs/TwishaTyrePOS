#!/bin/bash
# Does the app keep working when Redis is completely down? Stops the local Redis container, exercises the
# request paths that touch Redis (sign-in, cache, AI card, WhatsApp queue) plus a sale and a PDF, then restarts it.
#   bash e2e/redis-down.sh            (needs the API on :3200 and the demo shop 9200000001 / 1111)
API=${API:-http://localhost:3200}
H='content-type: application/json'
fail=0
t() {  # name, expected-status-regex, curl args...
  local name=$1 want=$2; shift 2
  local out; out=$(curl -s -m 15 -o /tmp/rd.out -w "%{http_code} %{time_total}" "$@")
  local code=${out% *} secs=${out#* }
  if [[ $code =~ $want ]] && awk "BEGIN{exit !($secs < 8)}"; then printf "PASS  %-46s %s in %ss\n" "$name" "$code" "$secs"
  else printf "FAIL  %-46s %s in %ss  %s\n" "$name" "$code" "$secs" "$(head -c 120 /tmp/rd.out)"; fail=$((fail+1)); fi
}
login() { curl -s -m 15 -X POST $API/api/auth/login -H "$H" -d '{"tenantPhone":"9200000001","phone":"9200000001","pin":"1111"}' | sed 's/.*"accessToken":"\([^"]*\)".*/\1/'; }

echo "== Redis UP (reference)"; TOKEN=$(login); A="authorization: Bearer $TOKEN"
t "login (up)" "^200$" -X POST $API/api/auth/login -H "$H" -d '{"tenantPhone":"9200000001","phone":"9200000001","pin":"1111"}'

docker stop tyre_redis >/dev/null; sleep 3
echo "== Redis DOWN"
t "login"                              "^200$" -X POST $API/api/auth/login -H "$H" -d '{"tenantPhone":"9200000001","phone":"9200000001","pin":"1111"}'
t "wrong PIN is refused, not hung"     "^401$" -X POST $API/api/auth/login -H "$H" -d '{"tenantPhone":"9200000001","phone":"9200000001","pin":"9999"}'
TOKEN=$(login); A="authorization: Bearer $TOKEN"
t "home dashboard"                     "^200$" -H "$A" $API/api/tyre/dashboard
t "charts (cached endpoint)"           "^200$" -H "$A" "$API/api/analytics/dashboard?period=30d"
t "AI insight card (cached + flag)"    "^200$" -H "$A" $API/api/ai/insight
t "invoice list"                       "^200$" -H "$A" "$API/api/invoices?limit=5"
PROD=$(curl -s -H "$A" "$API/api/tyre/finder?kind=tyre&limit=1&inStock=true" | sed 's/.*"id":"\([^"]*\)".*/\1/')
t "save a sale"                        "^201$" -X POST $API/api/tyre/sales -H "$H" -H "$A" -H "Idempotency-Key: rd-$RANDOM$RANDOM" -d "{\"customer\":{\"name\":\"Redis Down Test\",\"phone\":\"9825077001\"},\"items\":[{\"productId\":\"$PROD\",\"qty\":1}],\"payments\":[]}"
INV=$(curl -s -H "$A" "$API/api/invoices?limit=1&txnType=sale_invoice" | sed 's/.*"data":\[{"id":"\([^"]*\)".*/\1/')
t "bill PDF"                           "^200$" -H "$A" $API/api/tyre/invoices/$INV/pdf
t "CA Excel export"                    "^200$" -H "$A" "$API/api/tyre/reports/ca-pack?only=expenses"
t "WhatsApp send says 'queue unreachable' (no hang)" "^422$" -X POST $API/api/tyre/invoices/$INV/notify -H "$H" -H "$A" -d '{"toPhone":"9825077001"}'
grep -q "Could not queue" /tmp/rd.out && echo "PASS  ...and the reason is shown to the user" || { echo "FAIL  reason missing: $(head -c 150 /tmp/rd.out)"; fail=$((fail+1)); }
t "WhatsApp Messages list"             "^200$" -H "$A" "$API/api/tyre/notifications"

docker start tyre_redis >/dev/null; sleep 4
echo "== Redis back"
t "login (after recovery)"             "^200$" -X POST $API/api/auth/login -H "$H" -d '{"tenantPhone":"9200000001","phone":"9200000001","pin":"1111"}'
t "charts (after recovery)"            "^200$" -H "$A" "$API/api/analytics/dashboard?period=7d"
t "WhatsApp send queues again"         "^202$" -X POST $API/api/tyre/invoices/$INV/notify -H "$H" -H "$A" -d '{"toPhone":"9825077001"}'
echo; [ $fail -eq 0 ] && echo "ALL PASS" || echo "$fail FAILED"
exit $fail
