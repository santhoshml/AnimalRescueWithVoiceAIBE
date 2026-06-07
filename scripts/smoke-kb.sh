#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3001}"
TMP_DIR="${TMP_DIR:-/tmp/wildlife-smoke}"
mkdir -p "$TMP_DIR"

echo "[1/6] Checking health..."
curl -sS "$BASE_URL/health" | sed -n '1,120p'
echo

PDF_PATH="${TMP_DIR}/smoke-kb.pdf"
if [[ ! -f "$PDF_PATH" ]]; then
  printf "Wildlife Rescue Copilot KB smoke test PDF\nGenerated: %s\n" "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" > "$PDF_PATH"
fi

echo "[2/6] Uploading KB document..."
UPLOAD_RESP="$(curl -sS -X POST "$BASE_URL/kb/documents" \
  -F "file=@${PDF_PATH};type=application/pdf" \
  -F "type=emergency_protocol" \
  -F "title=Smoke KB Doc" \
  -F "tags=[\"smoke\",\"kb\"]")"
echo "$UPLOAD_RESP" | sed -n '1,200p'
echo

DOC_ID="$(echo "$UPLOAD_RESP" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.stdout.write(j.id||'');}catch{process.stdout.write('')}})")"
if [[ -z "$DOC_ID" ]]; then
  echo "ERROR: Could not parse KB doc id from upload response" >&2
  exit 1
fi
echo "KB doc id: $DOC_ID"

echo "[3/6] Verifying KB list endpoint..."
curl -sS "$BASE_URL/kb/documents" | sed -n '1,220p'
echo

echo "[4/6] Creating a case and triggering analyze..."
CASE_RESP="$(curl -sS -X POST "$BASE_URL/cases" \
  -H "Content-Type: application/json" \
  -d '{"city":"San Francisco","callerName":"Smoke Test","callerPhone":"+1-555-0000"}')"
CASE_ID="$(echo "$CASE_RESP" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.stdout.write(j.id||'');}catch{process.stdout.write('')}})")"
echo "$CASE_RESP" | sed -n '1,220p'
echo
if [[ -z "$CASE_ID" ]]; then
  echo "ERROR: Could not parse case id" >&2
  exit 1
fi

ANALYZE_RESP="$(curl -sS -X POST "$BASE_URL/cases/$CASE_ID/analyze" -H "Content-Type: application/json" -d '{}')"
echo "$ANALYZE_RESP" | sed -n '1,240p'
echo

DOC_STATUS="$(echo "$UPLOAD_RESP" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.stdout.write(j.status||'');}catch{process.stdout.write('')}})")"

echo "[5/6] If failed, retry ingestion..."
if [[ "$DOC_STATUS" == "failed" ]]; then
  RETRY_RESP="$(curl -sS -X POST "$BASE_URL/kb/documents/$DOC_ID/retry" \
    -H "Content-Type: application/json" \
    -d '{}')"
  echo "$RETRY_RESP" | sed -n '1,220p'
  echo
else
  echo "Initial status is '$DOC_STATUS' (not failed), skipping retry step."
fi

echo "[6/6] SSE quick check (case + kb)..."
echo " - case stream (3s):"
curl -sN "$BASE_URL/events/$CASE_ID" --max-time 3 | sed -n '1,60p' || true
echo
echo " - kb stream (3s):"
curl -sN "$BASE_URL/events/kb" --max-time 3 | sed -n '1,60p' || true
echo

echo "Smoke test complete."
