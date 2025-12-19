#!/bin/bash
# K-Metric Server - Start Script
# this is fine 🐕🔥

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${YELLOW}🔥 K-Metric Server${NC}"
echo "================================"

# Check .env
if [ ! -f .env ]; then
    echo -e "${RED}Error: .env file not found${NC}"
    echo "Run: cp .env.example .env"
    echo "Then edit .env with your Helius API key"
    exit 1
fi

# Check Node.js
if ! command -v node &> /dev/null; then
    echo -e "${RED}Error: Node.js not found${NC}"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo -e "${RED}Error: Node.js 18+ required (found v$NODE_VERSION)${NC}"
    exit 1
fi

# Check if backfill needed
if [ ! -f data/k-metric.db ]; then
    echo -e "${YELLOW}No database found. Running initial backfill...${NC}"
    echo "This may take 10-15 minutes."
    echo ""
    node scripts/backfill.js
    echo ""
fi

# Kill existing process
pkill -f "node src/server.js" 2>/dev/null || true

# Start server on single core
echo -e "${GREEN}Starting server...${NC}"
echo ""

# taskset 0x1 = CPU core 0 only
if command -v taskset &> /dev/null; then
    exec taskset 0x1 node src/server.js
else
    # macOS or systems without taskset
    exec node src/server.js
fi
