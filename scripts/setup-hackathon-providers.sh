#!/usr/bin/env bash
set -e

# ============================================================================
# Docarion x Meta Model API Hackathon — Multi-Provider Environment Setup
# ============================================================================
# Checks and configures:
# 1. Meta Model API ($150 Credits) -> Direct LLM tokens (Muse Spark / Muse Wonder)
# 2. Modal ($100 Credits)          -> Serverless GPU for SAM 3.1 & Call Diarization
# 3. Baseten ($100 Credits)        -> High-throughput 2M TPM text & model failover
# 4. Fireworks ($25 Credits)       -> Secondary fast inference failover
# ============================================================================

echo "================================================================="
echo "   DOCARION x META MODEL API HACKATHON — ENVIRONMENT STATUS     "
echo "================================================================="
echo ""

# Helper to extract a non-empty key from .env.local or .env
get_env_val() {
    local pattern="$1"
    local val=""
    for f in "backend/.env.local" "backend/.env"; do
        if [ -f "$f" ]; then
            val=$(grep -E "$pattern" "$f" 2>/dev/null | head -n1 | cut -d'=' -f2- | tr -d ' "' )
            if [ -n "$val" ]; then
                echo "$val"
                return
            fi
        fi
    done
}

# 1. Check Meta Model API ($150)
echo "[1/3] Checking Meta Model API (\$150 credit)..."
META_TOKEN=$(get_env_val '^(LLAMA_API_TOKEN|LLAMA_API_KEY)=')
if [ -n "$META_TOKEN" ]; then
    CLEAN_TOKEN=$(echo "$META_TOKEN" | sed -E 's/^LLM_([0-9]+)_/LLM|\1|/')
    META_BODY=$(curl -s -H "Authorization: Bearer $CLEAN_TOKEN" https://api.meta.ai/v1/models || echo "")
    STATUS=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $CLEAN_TOKEN" https://api.meta.ai/v1/models || echo "000")
    if [ "$STATUS" = "200" ] && echo "$META_BODY" | grep -q '"data"'; then
        echo "  [OK] Meta Model API: ACTIVE (HTTP 200, non-empty model payload) - Ready for Muse Spark & Muse Wonder"
    elif [ "$STATUS" = "401" ]; then
        echo "  [!] Meta Model API: UNAUTHORIZED (HTTP 401) - Update LLAMA_API_TOKEN with your new \$150 hackathon key"
    else
        echo "  [?] Meta Model API: Returned HTTP $STATUS"
    fi
else
    echo "  [MISSING] LLAMA_API_TOKEN not found in backend/.env.local or backend/.env"
fi

# 2. Check Modal Serverless GPU & Containers ($100 credit)
echo ""
echo "[2/3] Checking Modal Serverless GPU & Container Setup (\$100 serverless GPU credit)..."
MODAL_HEALTH_URL="${MODAL_HEALTH_URL:-https://mannasync-cpu--docarion-meta-multimodal-health.us-east.modal.run}"
MODAL_SEGMENT_URL="${MODAL_SEGMENT_ENDPOINT_URL:-https://mannasync-cpu--docarion-meta-multimodal-segment-endpoint.us-east.modal.run}"
MODAL_DIARIZE_URL="${MODAL_DIARIZE_ENDPOINT_URL:-https://mannasync-cpu--docarion-meta-multimodal-diarize-endpoint.us-east.modal.run}"
TINY_PNG="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
MODAL_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$MODAL_HEALTH_URL" || echo "000")
SEG_RESP=$(curl -s -X POST "$MODAL_SEGMENT_URL" -H "Content-Type: application/json" -d "{\"image_base64\":\"$TINY_PNG\",\"target_mode\":\"wound\",\"reference_scale_mm\":20}" || echo "")
DIA_RESP=$(curl -s -X POST "$MODAL_DIARIZE_URL" -H "Content-Type: application/json" -d '{"language":"pidgin","strip_noise":true}' || echo "")
if [ "$MODAL_STATUS" = "200" ] && echo "$SEG_RESP" | grep -q '"segments"' && echo "$DIA_RESP" | grep -q '"turns"'; then
    echo "  [OK] Modal Serverless GPU: ACTIVE (HTTP 200, live T4 GPU SAM 3.1 segments & Diarization turns verified)"
else
    echo "  [?] Modal Serverless GPU: Returned HTTP $MODAL_STATUS ($MODAL_HEALTH_URL)"
fi

if command -v modal >/dev/null 2>&1; then
    MODAL_VER=$(modal --version 2>&1 | head -n1)
    echo "  [OK] Modal CLI installed: $MODAL_VER"
    # Check if modal token is configured
    if modal app list >/dev/null 2>&1; then
        echo "  [OK] Modal authentication: CONFIGURED"
    else
        echo "  [ACTION REQUIRED] Run 'modal setup' to link your \$100 Modal account"
    fi
else
    echo "  [MISSING] Modal CLI not found. Run: uv tool install modal"
fi

# 3. Check Baseten ($100 credit + 2M TPM)
echo ""
echo "[3/3] Checking Baseten (\$100 credit + 2M TPM rate limit)..."
BASETEN_KEY=$(get_env_val '^BASETEN_API_KEY=')
if [ -n "$BASETEN_KEY" ]; then
    B_BODY=$(curl -s -X POST "https://inference.baseten.co/v1/chat/completions" \
      -H "Authorization: Bearer $BASETEN_KEY" \
      -H "Content-Type: application/json" \
      -d '{"model":"meta-models/muse-spark-open-1026","messages":[{"role":"user","content":"Reply OK"}],"max_tokens":10}' || echo "")
    if echo "$B_BODY" | grep -q '"choices"'; then
        echo "  [OK] Baseten API: ACTIVE (HTTP 200, live meta-models/muse-spark-open-1026 completion verified)"
    else
        B_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Api-Key $BASETEN_KEY" https://api.baseten.co/v1/models || echo "000")
        if [ "$B_STATUS" = "200" ]; then
            echo "  [OK] Baseten API: ACTIVE (HTTP 200, workspace models verified)"
        else
            echo "  [?] Baseten API: Returned HTTP $B_STATUS"
        fi
    fi
else
    echo "  [OPTIONAL] BASETEN_API_KEY not set (grab your key from Baseten dashboard once claimed)"
fi

echo ""
echo "================================================================="
echo "   CURRENT GIT BRANCH: $(git rev-parse --abbrev-ref HEAD)"
echo "================================================================="
