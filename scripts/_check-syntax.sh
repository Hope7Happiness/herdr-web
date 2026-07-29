#!/usr/bin/env bash
# The UI is one inline <script>; a syntax error there serves a blank page with
# no server-side warning. Check it before shipping.
set -euo pipefail
cd "$(dirname "$0")/.."
python3 - <<'PY' > /tmp/.herdr-web-page.js
import re
s = open('public/index.html').read()
m = re.search(r"<script>\n'use strict';(.*?)</script>", s, re.S)
print("'use strict';" + m.group(1))
PY
node --check /tmp/.herdr-web-page.js && echo "page script OK"
