#!/bin/bash
# The LTI vm-test harness on sagebrush-2 (plan-lti-r5 §12).  Everything is on
# the private Docker network lti-vmtest: nothing is published on the host.
#   vmtest.sh up | moodle-https | moodle-restore | canvas-https | canvas-restore | listen-check | down
set -euo pipefail
cd "$(dirname "$0")"
H=/home/user/lti/vmtest
NET=lti-vmtest
case "${1:-}" in
up)
  [ -f secrets.env ] || { umask 077; printf 'LTI_KEY=%s\nMAPPING_BACKUP_KEY=%s\nSEED_PW=Syn-%sA1!\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" "$(openssl rand -hex 8)" > secrets.env; }
  docker network inspect $NET >/dev/null 2>&1 || docker network create --internal $NET >/dev/null
  docker network connect $NET moodle-moodle-1 2>/dev/null || true
  docker network connect $NET canvas-lms-web-1 2>/dev/null || true
  docker rm -f lti-caddy lti-tool >/dev/null 2>&1 || true
  docker run -d --name lti-caddy --network $NET --network-alias moodle.vmtest --network-alias canvas.vmtest --network-alias lti.vmtest \
    -v $H/Caddyfile:/etc/caddy/Caddyfile:ro -v lti-caddy-data:/data caddy:2-alpine >/dev/null
  mkdir -p ca
  for i in $(seq 1 30); do docker cp lti-caddy:/data/caddy/pki/authorities/local/root.crt ca/root.crt 2>/dev/null && break; sleep 1; done
  test -s ca/root.crt
  # (the tool's packages: installed once, in a throwaway container on the default network)
  if [ ! -d tool/node_modules/miniflare ]; then
    docker run --rm -v $H/tool:/tool -w /tool node:24-bookworm-slim sh -c 'npm i --silent --no-audit --no-fund miniflare@5.20260930.0-alpha >/dev/null'
  fi
  docker run -d --name lti-tool --network $NET --network-alias lti-tool --env-file secrets.env -e NODE_EXTRA_CA_CERTS=/ca/root.crt \
    -v $H/tool:/tool:ro -v $H/ca:/ca:ro -v lti-tool-data:/data -w /tool node:24-bookworm-slim node serve.mjs >/dev/null
  for i in $(seq 1 30); do docker logs lti-tool 2>&1 | grep -q listening && break; sleep 1; done
  docker logs lti-tool 2>&1 | tail -2
  ;;
moodle-https)
  docker exec moodle-moodle-1 sh -c 'test -f /var/www/html/config.php.lti-bak || cp /var/www/html/config.php /var/www/html/config.php.lti-bak'
  docker exec moodle-moodle-1 sh -c "sed -i -e \"s#^\\\$CFG->wwwroot.*#\\\$CFG->wwwroot   = 'https://moodle.vmtest';#\" -e \"s#^\\\$CFG->sslproxy.*#\\\$CFG->sslproxy\\t= true;#\" /var/www/html/config.php && php /var/www/html/admin/cli/purge_caches.php"
  docker exec moodle-moodle-1 sh -c 'grep -n "wwwroot\|sslproxy" /var/www/html/config.php'
  ;;
moodle-restore)
  docker exec moodle-moodle-1 sh -c 'test -f /var/www/html/config.php.lti-bak && cp /var/www/html/config.php.lti-bak /var/www/html/config.php && rm /var/www/html/config.php.lti-bak; php /var/www/html/admin/cli/purge_caches.php; grep -n "wwwroot\|sslproxy" /var/www/html/config.php'
  code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8081/login/index.php)
  echo "moodle admin UI on 127.0.0.1:8081/login: HTTP $code"
  ;;
canvas-https)
  C=/home/user/lti/canvas-lms
  test -f $C/config/domain.yml.lti-bak || cp $C/config/domain.yml $C/config/domain.yml.lti-bak
  printf 'production:\n  domain: "canvas.vmtest"\n  ssl: true\n\ntest:\n  domain: localhost\n\ndevelopment:\n  domain: "canvas.vmtest"\n  ssl: true\n' > $C/config/domain.yml
  # (the dev config's LTI keys are 512-bit RSA, which the tool rightly refuses (§3.2): 2048-bit test keys for the run)
  test -f $C/config/dynamic_settings.yml.lti-bak || cp $C/config/dynamic_settings.yml $C/config/dynamic_settings.yml.lti-bak
  node -e '
    const { generateKeyPairSync } = require("node:crypto"); const fs = require("node:fs");
    const f = process.argv[1]; let y = fs.readFileSync(f + ".lti-bak", "utf8");
    for (const [name, kid] of [["jwk-past.json", "2026-10-01T00:00:00Z"], ["jwk-present.json", "2026-10-22T00:00:00Z"], ["jwk-future.json", "2026-11-01T00:00:00Z"]]) {
      const j = { ...generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "jwk" }), kid };
      y = y.replace(new RegExp("(" + name.replace(".", "\\.") + ": )\x27[^\x27]*\x27"), (_, p) => p + "\x27" + JSON.stringify(j) + "\x27");
    }
    fs.writeFileSync(f, y);' $C/config/dynamic_settings.yml
  docker restart canvas-lms-web-1 canvas-lms-jobs-1 >/dev/null
  docker network connect $NET canvas-lms-web-1 2>/dev/null || true
  for i in $(seq 1 90); do c=$(docker run --rm --network $NET -v $H/ca:/ca:ro -e NODE_EXTRA_CA_CERTS=/ca/root.crt node:24-bookworm-slim node -e 'fetch("https://canvas.vmtest/login/canvas",{redirect:"manual"}).then(r=>console.log(r.status)).catch(()=>console.log(0))'); [ "$c" = 200 ] && break; sleep 5; done
  echo "canvas via caddy: $c"
  ;;
canvas-restore)
  C=/home/user/lti/canvas-lms
  test -f $C/config/domain.yml.lti-bak && mv $C/config/domain.yml.lti-bak $C/config/domain.yml
  test -f $C/config/dynamic_settings.yml.lti-bak && mv $C/config/dynamic_settings.yml.lti-bak $C/config/dynamic_settings.yml
  docker restart canvas-lms-web-1 canvas-lms-jobs-1 >/dev/null
  for i in $(seq 1 90); do code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8082/login/canvas); [ "$code" = 200 ] && break; sleep 5; done
  echo "canvas admin UI on 127.0.0.1:8082/login/canvas: HTTP $code"
  ;;
listen-check)
  ss -tlnp 2>/dev/null | awk 'NR>1{print $4}' | sort -u > /tmp/listen-now.txt
  if diff /home/user/lti/listen-baseline.txt /tmp/listen-now.txt; then echo "listening set unchanged"; else echo "LISTENING SET CHANGED"; exit 1; fi
  ;;
down)
  docker rm -f lti-caddy lti-tool lti-e2e >/dev/null 2>&1 || true
  docker network disconnect $NET moodle-moodle-1 2>/dev/null || true
  docker network disconnect $NET canvas-lms-web-1 2>/dev/null || true
  docker network rm $NET >/dev/null 2>&1 || true
  echo down
  ;;
*) echo "usage: $0 up|moodle-https|moodle-restore|listen-check|down"; exit 2 ;;
esac
