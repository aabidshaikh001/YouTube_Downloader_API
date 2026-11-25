#!/usr/bin/env bash
# API test suite — run against a local server or a deployed Render URL:
#   BASE_URL=http://localhost:3000 bash test-api.sh
#   BASE_URL=https://youtube-downloader-api.onrender.com bash test-api.sh
# The server must already be running (npm start). The download test
# uses a real YouTube video and can take a few minutes on a slow
# connection — the poll loop waits up to 15 minutes.
set -u
BASE_URL="${BASE_URL:-http://localhost:3000}"
VIDEO_URL="${VIDEO_URL:-https://www.youtube.com/watch?v=dQw4w9WgXcQ}"
PASS=0; FAIL=0

say()  { printf '\n== %s ==\n' "$1"; }
ok()   { PASS=$((PASS+1)); echo "PASS: $1"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL: $1"; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing tool: $1"; exit 1; }; }
need curl; need python3

# --- 1. Health check -------------------------------------------------
say "1. Health check"
HEALTH=$(curl -s -w '\n%{http_code}' "$BASE_URL/health")
CODE=$(echo "$HEALTH" | tail -1); BODY=$(echo "$HEALTH" | head -n -1)
echo "$BODY"
[ "$CODE" = "200" ] && echo "$BODY" | grep -q '"status":"ok"' && ok "health is ok" || bad "health (HTTP $CODE)"

# --- 2. Video information --------------------------------------------
say "2. Video information"
INFO=$(curl -s "$BASE_URL/api/video/info?url=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$VIDEO_URL")")
echo "$INFO" | python3 -m json.tool | head -30
echo "$INFO" | grep -q '"success":true' && echo "$INFO" | grep -q 'Rick Astley' && ok "info returns title" || bad "video info"

# --- 3. Available formats --------------------------------------------
say "3. Available formats"
FORMATS=$(curl -s "$BASE_URL/api/video/formats?url=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$VIDEO_URL")")
echo "$FORMATS" | python3 -m json.tool | head -40
echo "$FORMATS" | grep -q '"resolution":"720p"' && ok "720p listed" || bad "720p in formats"
echo "$FORMATS" | grep -q '"resolution":"144p"' && ok "144p listed" || bad "144p in formats"

# --- 4. Start video download (144p — smallest, fastest to test) ------
say "4. Start video download (144p)"
START=$(curl -s -X POST "$BASE_URL/api/video/download" -H 'Content-Type: application/json' \
  -d "{\"url\":\"$VIDEO_URL\",\"quality\":\"144p\",\"format\":\"mp4\"}")
echo "$START"
JOB_ID=$(echo "$START" | python3 -c "import sys,json;print(json.load(sys.stdin).get('jobId',''))")
[ -n "$JOB_ID" ] && ok "download started (job $JOB_ID)" || { bad "start download"; JOB_ID=""; }

# --- 5. Job status (poll until completed / failed, max 15 min) --------
if [ -n "$JOB_ID" ]; then
  say "5. Job status (polling $JOB_ID)"
  for i in $(seq 1 90); do
    STATUS_JSON=$(curl -s "$BASE_URL/api/video/jobs/$JOB_ID")
    STATUS=$(echo "$STATUS_JSON" | python3 -c "import sys,json;print(json.load(sys.stdin)['job']['status'])" 2>/dev/null)
    PROGRESS=$(echo "$STATUS_JSON" | python3 -c "import sys,json;print(json.load(sys.stdin)['job']['progress'])" 2>/dev/null)
    echo "  poll $i: status=$STATUS progress=${PROGRESS}%"
    case "$STATUS" in
      completed) ok "job completed"; break ;;
      failed)
        echo "$STATUS_JSON" | python3 -m json.tool
        bad "job failed"; break ;;
      expired) bad "job expired"; break ;;
    esac
    sleep 10
  done

  # --- 6. File download ----------------------------------------------
  say "6. Download the finished file"
  if [ "$STATUS" = "completed" ]; then
    curl -s -D /tmp/headers.txt -o /tmp/downloaded.mp4 "$BASE_URL/api/video/jobs/$JOB_ID/download"
    grep -i 'content-disposition' /tmp/headers.txt
    SIZE=$(stat -c%s /tmp/downloaded.mp4 2>/dev/null || echo 0)
    echo "downloaded $SIZE bytes"
    [ "$SIZE" -gt 100000 ] && file /tmp/downloaded.mp4 | grep -qi 'MP4\|ISO Media' && ok "file is a valid MP4 ($SIZE bytes)" || bad "file download"
  else
    bad "file download skipped (job not completed)"
  fi

  # --- 7. Delete job ---------------------------------------------------
  say "7. Delete job"
  DEL=$(curl -s -X DELETE "$BASE_URL/api/video/jobs/$JOB_ID")
  echo "$DEL"
  echo "$DEL" | grep -q '"success":true' && ok "job deleted" || bad "delete job"
  GONE=$(curl -s "$BASE_URL/api/video/jobs/$JOB_ID")
  echo "$GONE" | grep -q 'JOB_NOT_FOUND' && ok "deleted job returns 404" || bad "deleted job still visible"
fi

# --- 8. Start audio download (mp3) ------------------------------------
say "8. Start audio download (mp3)"
ASTART=$(curl -s -X POST "$BASE_URL/api/video/audio" -H 'Content-Type: application/json' \
  -d "{\"url\":\"$VIDEO_URL\",\"format\":\"mp3\",\"quality\":\"128\"}")
echo "$ASTART"
AJOB=$(echo "$ASTART" | python3 -c "import sys,json;print(json.load(sys.stdin).get('jobId',''))")
[ -n "$AJOB" ] && ok "audio started (job $AJOB)" || bad "start audio"
if [ -n "$AJOB" ]; then
  for i in $(seq 1 90); do
    AJ=$(curl -s "$BASE_URL/api/video/jobs/$AJOB")
    ASTATUS=$(echo "$AJ" | python3 -c "import sys,json;print(json.load(sys.stdin)['job']['status'])" 2>/dev/null)
    echo "  poll $i: status=$ASTATUS"
    case "$ASTATUS" in
      completed) ok "audio job completed"; break ;;
      failed) echo "$AJ" | python3 -m json.tool; bad "audio job failed"; break ;;
    esac
    sleep 10
  done
  curl -s -X DELETE "$BASE_URL/api/video/jobs/$AJOB" >/dev/null
fi

# --- 9. Invalid URL ----------------------------------------------------
say "9. Invalid URL"
BADURL=$(curl -s -w '\n%{http_code}' "$BASE_URL/api/video/info?url=not-a-url")
echo "$BADURL"
echo "$BADURL" | grep -q '400' && ok "invalid URL rejected (400)" || bad "invalid URL handling"

# --- 10. Unsupported domain (SSRF guard) ------------------------------
say "10. Unsupported domain"
SSRF=$(curl -s -w '\n%{http_code}' -X POST "$BASE_URL/api/video/download" -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com/video","quality":"720p","format":"mp4"}')
echo "$SSRF"
echo "$SSRF" | grep -q '400' && ok "non-YouTube URL rejected (400)" || bad "unsupported domain handling"

# --- 11. Missing job ---------------------------------------------------
say "11. Missing job"
MISS=$(curl -s -w '\n%{http_code}' "$BASE_URL/api/video/jobs/00000000-0000-0000-0000-000000000000")
echo "$MISS"
echo "$MISS" | grep -q 'JOB_NOT_FOUND' && echo "$MISS" | grep -q '404' && ok "missing job returns 404 JOB_NOT_FOUND" || bad "missing job handling"

# --- 12. Rate limiting (informational — needs many requests) -----------
say "12. Rate limiting"
echo "Rate limiting is configured (100 req / 15 min per IP, 20 download starts / 15 min)."
echo "To test it, lower RATE_LIMIT_MAX to 3, restart, and run:"
echo "  for i in 1 2 3 4; do curl -s -o /dev/null -w '%{http_code} ' $BASE_URL/health; done"
echo "  -> the 4th request should return 429."

echo
echo "=============================="
echo "PASS: $PASS   FAIL: $FAIL"
[ "$FAIL" -eq 0 ]
