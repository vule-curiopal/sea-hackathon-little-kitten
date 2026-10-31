#!/bin/bash
# Installed root-owned as /usr/local/sbin/miu-deploy. Never modify other apps.
set -euo pipefail
umask 022
export PATH=/opt/node24/bin:/usr/sbin:/usr/bin:/sbin:/bin

readonly ROOT=/opt/miu
readonly SOURCE=$ROOT/source
readonly RELEASES=$ROOT/releases
readonly CURRENT=$ROOT/current
readonly STATE=$ROOT/deploy-state.json
readonly LOG=$ROOT/logs/deploy.log
readonly REPOSITORY=https://github.com/vule-curiopal/sea-hackathon-little-kitten.git
readonly NODE=/opt/node24/bin/node
readonly RUNUSER=/usr/sbin/runuser
readonly SERVICE=miu-api.service
readonly HEALTH=http://127.0.0.1:4611/api/health
readonly RUNTIME_ENV=/etc/miu/api.env
readonly ROOT_PID=$BASHPID

requested_ref=
target=
previous_release=
previous_sha=
activated=0
completed=0
initialized=0

log() { printf '[miu-deploy] %s\n' "$*"; }
fail() { log "$*" >&2; exit 1; }
is_sha() { [[ $1 =~ ^[0-9a-f]{40}$ ]]; }

case $# in
  0) ;;
  2)
    [[ $1 == --ref ]] && is_sha "$2" || fail 'Usage: miu-deploy [--ref <40 lowercase hex commit>]'
    requested_ref=$2
    ;;
  *) fail 'Usage: miu-deploy [--ref <40 lowercase hex commit>]' ;;
esac
[[ $EUID -eq 0 ]] || fail 'This administrator-owned deployment command must run as root.'
[[ -x $NODE && -x /opt/node24/bin/npm && -x $RUNUSER ]] || fail 'Dedicated Node24 or runuser is missing.'
for command in git flock tar nice systemctl curl readlink install mv ln chown chmod find stat seq sleep tee; do
  command -v "$command" >/dev/null || fail "Required deployment tool is missing: $command"
done
id miu >/dev/null 2>&1 || fail 'The dedicated miu account must be provisioned first.'

# Every path this script creates is inside this dedicated application directory.
[[ ! -L $ROOT && $(readlink -m -- "$ROOT") == "$ROOT" ]] || fail 'Application root must be a canonical directory.'
install -d -m 0755 -o root -g root -- "$ROOT"
[[ $(stat -c '%u' -- "$ROOT") == 0 ]] || fail 'Application root must be administrator-owned.'
permissions=$(stat -c '%a' -- "$ROOT")
(( (8#$permissions & 0022) == 0 )) || fail 'Application root must not be group/world writable.'

# The one lock outside /opt/miu prevents concurrent manual deployments.
[[ ! -L /run/lock/miu-deploy.lock ]] || fail 'Deployment lock must not be a symlink.'
exec 9>/run/lock/miu-deploy.lock
flock -w 900 9 || fail 'Another Miu deployment did not finish within15 minutes.'

within_root() {
  local path
  path=$(readlink -m -- "$1")
  [[ $path == "$ROOT" || $path == "$ROOT/"* ]] || fail 'A deployment path escapes /opt/miu.'
}

directory() {
  within_root "$1"
  [[ ! -L $1 ]] || fail 'A managed directory must not be a symlink.'
  if [[ -e $1 ]]; then
    [[ -d $1 ]] || fail 'A managed path is not a directory.'
  else
    install -d -m 0755 -o "$2" -g "$3" -- "$1"
  fi
}

directory "$RELEASES" root root
[[ $(stat -c '%u' -- "$RELEASES") == 0 ]] || fail 'Release parent must be administrator-owned.'
permissions=$(stat -c '%a' -- "$RELEASES")
(( (8#$permissions & 0022) == 0 )) || fail 'Release parent must not be group/world writable.'
directory "$ROOT/home-miu" miu miu
directory "$ROOT/cache" miu miu
directory "$ROOT/cache/npm" miu miu
directory "$ROOT/tmp" miu miu
directory "$ROOT/logs" root root
[[ $(stat -c '%u' -- "$ROOT/logs") == 0 ]] || fail 'Deployment log directory must be administrator-owned.'
chmod 0700 -- "$ROOT/logs"
within_root "$LOG"
[[ ! -L $LOG && ( ! -e $LOG || -f $LOG ) ]] || fail 'Deployment log must be a regular file, not a symlink.'
if [[ ! -e $LOG ]]; then install -m 0600 -o root -g root -- /dev/null "$LOG"; fi
[[ $(stat -c '%u' -- "$LOG") == 0 ]] || fail 'Deployment log must be administrator-owned.'
chmod 0600 -- "$LOG"
# Retain build errors without provider/SSH secrets or request bodies in the log.
exec > >(tee -a -- "$LOG") 2>&1
[[ ! -L $STATE ]] || fail 'Deployment state must not be a symlink.'
[[ ! -e $STATE || -f $STATE ]] || fail 'Deployment state must be a regular file.'

# Read only the provider mode. Never source runtime secrets into deployment/builds.
expected_provider_mode=$("$NODE" --input-type=module - "$RUNTIME_ENV" <<'NODE'
import fs from 'node:fs';
const file = process.argv[2];
const stat = fs.lstatSync(file);
if (!stat.isFile() || fs.realpathSync(file) !== file || stat.uid !== 0 || (stat.mode & 0o077) !== 0) {
  throw new Error('Miu runtime env must be a canonical root-owned private regular file.');
}
const assignments = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(line => /^\s*MIU_PROVIDER\s*=/.test(line));
if (assignments.length !== 1) throw new Error('Miu runtime env must define MIU_PROVIDER exactly once.');
const match = /^\s*MIU_PROVIDER\s*=\s*(fake|real)\s*$/.exec(assignments[0]);
if (!match) throw new Error('Miu runtime MIU_PROVIDER must be fake or real.');
process.stdout.write(match[1]);
NODE
) || fail 'Cannot read the expected Miu provider mode from /etc/miu/api.env.'
readonly expected_provider_mode

as_miu() {
  "$RUNUSER" -u miu -- /usr/bin/env -i \
    PATH=/opt/node24/bin:/usr/bin:/bin HOME="$ROOT/home-miu" USER=miu LOGNAME=miu \
    LANG=C.UTF-8 TMPDIR="$ROOT/tmp" XDG_CACHE_HOME="$ROOT/cache" \
    npm_config_cache="$ROOT/cache/npm" NODE_OPTIONS=--max-old-space-size=512 \
    MIU_PROVIDER=fake STT_LOGGING=1 VITE_DEMO_PUBLIC_URL=https://miu.curiopal.com VITE_VOICE_API_URL= \
    GIT_TERMINAL_PROMPT=0 GIT_CONFIG_NOSYSTEM=1 "$@"
}

git_miu() { as_miu git -c core.hooksPath=/dev/null -C "$SOURCE" "$@"; }

# Reject symlinks escaping the managed tree before archive extraction/build or reuse.
check_tree() {
  within_root "$1"
  "$NODE" --input-type=module - "$1" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
const root = fs.realpathSync(process.argv[2]);
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const item = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const resolved = fs.realpathSync(item);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error('Managed symlink escapes its directory.');
    } else if (entry.isDirectory()) walk(item);
  }
}
walk(root);
NODE
}

write_json() {
  local kind=$1 path=$2 status=${3:-} current=${4:-} previous=${5:-}
  within_root "$path"
  "$NODE" --input-type=module - "$kind" "$path" "$status" "$current" "$previous" "$target" "$expected_provider_mode" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
const [kind, file, status, current, previous, attempted, providerMode] = process.argv.slice(2);
if (providerMode !== 'fake' && providerMode !== 'real') throw new Error('Invalid expected provider mode.');
const root = fs.realpathSync('/opt/miu');
const parent = fs.realpathSync(path.dirname(file));
if (parent !== root && !parent.startsWith(root + path.sep)) throw new Error('JSON destination escapes app root.');
if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('JSON destination is a symlink.');
const time = new Date().toISOString();
let body;
if (kind === 'state') {
  let old = {};
  try { old = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  body = { current: current || null, previous: status === 'succeeded' ? previous || null : old.previous ?? null,
    attempted: attempted || null, last_status: status, updated_at: time, provider_mode: providerMode };
} else if (kind === 'complete') {
  body = { commit: attempted, built_at: time, validation: 'backend/frontend builds, tests, fake HTTP smoke and frontend assets passed' };
} else {
  let old = {};
  try { old = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  if (old.commit === attempted && old.provider_mode === providerMode) process.exit(0);
  body = { commit: attempted, deployed_at: old.commit === attempted ? old.deployed_at ?? time : time, provider_mode: providerMode };
}
const temporary = `${file}.tmp-${process.pid}`;
fs.writeFileSync(temporary, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o644, flag: 'wx' });
fs.renameSync(temporary, file);
NODE
}

check_complete() {
  local release=$1 expected=$2
  within_root "$release"
  [[ -d $release && ! -L $release && -f $release/.miu-release-complete.json && ! -L $release/.miu-release-complete.json ]] \
    || fail 'Existing release is not a completed canonical release; it will not be overwritten.'
  [[ $(stat -c '%u' -- "$release") == 0 && $(stat -c '%u' -- "$release/.miu-release-complete.json") == 0 ]] \
    || fail 'Completed release and its marker must be administrator-owned.'
  [[ -s $release/frontend/dist/index.html && -d $release/frontend/dist/assets ]] \
    || fail 'Completed release must include the frontend production assets.'
  "$NODE" --input-type=module - "$release/.miu-release-complete.json" "$expected" <<'NODE'
import fs from 'node:fs';
const marker = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (marker.commit !== process.argv[3]) throw new Error('Release completion marker does not match commit.');
NODE
}

switch_current() {
  local release=$1 temporary=$ROOT/.current.$BASHPID.$RANDOM
  within_root "$release"
  [[ -d $release && ! -L $release ]] || fail 'Cannot activate a noncanonical release.'
  [[ ! -e $CURRENT || -L $CURRENT ]] || fail 'Current path is not a managed symlink.'
  [[ ! -e $temporary && ! -L $temporary ]] || fail 'Atomic symlink temporary path exists.'
  ln -s -- "$release" "$temporary"
  mv -Tf -- "$temporary" "$CURRENT"
}

healthy() {
  local attempt body attempts=${1:-30}
  for attempt in $(seq 1 "$attempts"); do
    if body=$(curl --fail --silent --show-error --connect-timeout 1 --max-time 2 "$HEALTH" 2>/dev/null) \
      && printf '%s' "$body" | "$NODE" --input-type=module -e \
        "import fs from 'node:fs'; const h=JSON.parse(fs.readFileSync(0,'utf8')); process.exit(h.status==='ok' && h.provider_mode===process.argv[1] ? 0 : 1);" "$expected_provider_mode"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

finish() {
  local result=$1 status=failed current_sha=$previous_sha
  [[ $BASHPID == "$ROOT_PID" ]] || return
  trap - EXIT INT TERM
  if [[ $result -eq 0 || $completed -eq 1 || $initialized -eq 0 ]]; then return; fi
  set +e
  if [[ $activated -eq 1 ]]; then
    if [[ -n $previous_release ]]; then
      log 'Activation failed; restoring only the previous Miu release.'
      switch_current "$previous_release"
      if ! systemctl restart "$SERVICE" || ! healthy; then status=rollback_failed; fi
    else
      # First deployment has no prior release. Remove only this exact symlink.
      if [[ -L $CURRENT && $(readlink -f -- "$CURRENT") == "$RELEASES/$target" ]]; then unlink -- "$CURRENT"; fi
      systemctl stop "$SERVICE"
      current_sha=
    fi
  fi
  write_json state "$STATE" "$status" "$current_sha" "$previous_sha"
  log "Deployment failed ($status); failed build/release is retained for inspection."
}
trap 'finish $?' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ -e $CURRENT || -L $CURRENT ]]; then
  [[ -L $CURRENT ]] || fail 'Current application path must be a symlink.'
  previous_release=$(readlink -f -- "$CURRENT")
  within_root "$previous_release"
  previous_sha=${previous_release##*/}
  is_sha "$previous_sha" && [[ $previous_release == "$RELEASES/$previous_sha" ]] \
    || fail 'Current application does not point at a managed release.'
  check_complete "$previous_release" "$previous_sha"
fi
initialized=1

working_directory=$(systemctl show "$SERVICE" --property=WorkingDirectory --value)
[[ $working_directory == "$CURRENT" ]] || fail 'miu-api WorkingDirectory must be /opt/miu/current; no other unit will be touched.'

if [[ ! -d $SOURCE/.git ]]; then
  directory "$SOURCE" miu miu
  [[ -z $(find "$SOURCE" -mindepth 1 -maxdepth 1 -print -quit) ]] \
    || fail 'Source has no normal Git directory and is not empty; refusing to overwrite it.'
  chown miu:miu -- "$SOURCE"
  log 'Cloning the fixed public Miu repository as the dedicated user.'
  as_miu git -c core.hooksPath=/dev/null clone --no-checkout -- "$REPOSITORY" "$SOURCE"
fi
[[ -d $SOURCE && ! -L $SOURCE && -d $SOURCE/.git && ! -L $SOURCE/.git ]] || fail 'Source must be the dedicated normal Git repository.'
[[ $(git_miu rev-parse --show-toplevel) == "$SOURCE" ]] || fail 'Git source root does not match /opt/miu/source.'
[[ $(git_miu remote get-url origin) == "$REPOSITORY" ]] || fail 'Unexpected Git source origin; refusing to fetch.'
check_tree "$SOURCE"
log 'Fetching origin/main without changing any other project checkout.'
git_miu fetch --no-tags origin '+refs/heads/main:refs/remotes/origin/main'
target=$(git_miu rev-parse --verify refs/remotes/origin/main)
is_sha "$target" || fail 'Fetched main does not resolve to a valid commit.'
if [[ -n $requested_ref ]]; then
  git_miu cat-file -e "$requested_ref^{commit}" || fail 'Requested commit is not available in the source repository.'
  git_miu merge-base --is-ancestor "$requested_ref" "$target" || fail 'Requested commit is not part of current main.'
fi

release=$RELEASES/$target
within_root "$release"
write_json state "$STATE" building "$previous_sha" "$previous_sha"
if [[ -e $release || -L $release ]]; then
  check_complete "$release" "$target"
  check_tree "$release"
  log "Reusing completed release $target."
else
  staging=$RELEASES/.build-$target-$BASHPID-$RANDOM
  within_root "$staging"
  [[ ! -e $staging && ! -L $staging ]] || fail 'Build staging path already exists.'
  install -d -m 0755 -o miu -g miu -- "$staging"
  log "Building release $target as miu; existing applications are not restarted."
  git_miu archive --format=tar "$target" | as_miu tar -xf - -C "$staging"
  check_tree "$staging"
  build() {
    (
      cd -- "$staging"
      if command -v ionice >/dev/null; then
        as_miu nice -n 10 ionice -c 2 -n 7 "$@"
      else
        as_miu nice -n 10 "$@"
      fi
    )
  }
  build npm ci --include=dev --no-audit --no-fund
  build npm run build
  # Frontend has its own lockfile and is intentionally not a root workspace.
  build npm --prefix frontend ci --include=dev --no-audit --no-fund
  build npm --prefix frontend test
  build npm --prefix frontend run demo:qr -- https://miu.curiopal.com en
  build npm --prefix frontend run build
  build npm test -- --maxWorkers=1
  build npm run smoke
  [[ -s $staging/frontend/dist/index.html && -d $staging/frontend/dist/assets ]] \
    || fail 'Frontend build did not emit dist/index.html and assets.'
  check_tree "$staging"
  write_json complete "$staging/.miu-release-complete.json"
  # Seal code after unprivileged build. Symlinks were checked and are not followed.
  find "$staging" -type f -exec chmod go-w -- {} +
  find "$staging" -type d -exec chmod go-w -- {} +
  chown -h -R root:miu -- "$staging"
  [[ ! -e $release && ! -L $release ]] || fail 'A release appeared while building; refusing to overwrite it.'
  mv -T -- "$staging" "$release"
fi

if [[ $previous_release == "$release" ]] && healthy 1; then
  write_json info "$release/deploy-info.json"
  write_json state "$STATE" unchanged "$target" "$previous_sha"
  completed=1
  log "Commit $target is already deployed and healthy."
  exit 0
fi

write_json info "$release/deploy-info.json"
switch_current "$release"
activated=1
systemctl restart "$SERVICE"
healthy || fail "New Miu release did not become healthy in $expected_provider_mode mode."
write_json state "$STATE" succeeded "$target" "$previous_sha"
completed=1
log "Deployed $target; miu-api is healthy on127.0.0.1:4611."
