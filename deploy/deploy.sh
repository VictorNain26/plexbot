#!/usr/bin/env bash
# Promotes origin/main onto the running bot when it moves. Run by plexbot-deploy.timer
# (victorserv repo, roles/plexbot); safe to run by hand.
#
# A commit is promoted once its CI published its image (job « Publish image »). The image is
# pulled by the commit's tag, and started only once its provenance verifies: built by ci.yml on
# main of this repository, from that very commit (docs.github.com, « Using artifact attestations
# to establish provenance »). Nothing is built here. Same model as aubesonore's deploy.sh.
set -euo pipefail

REPO_DIR="${REPO_DIR:-$HOME/plexbot}"
repo=VictorNain26/plexbot
image=ghcr.io/victornain26/plexbot
health_timeout="${HEALTH_TIMEOUT_S:-180}"
# A fine-grained token with no permission: `gh attestation verify` asks for one even for a
# public image. Written by hand on the server, never committed.
gh_token_file="${GH_TOKEN_FILE:-$HOME/.config/plexbot/gh-token}"

cd "$REPO_DIR"

branch=$(git symbolic-ref --quiet --short HEAD || echo "a detached HEAD")
if [ "$branch" != main ]; then
  echo "$REPO_DIR is on $branch, not main: deploy refused"
  exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "$REPO_DIR has local changes: deploy refused"
  git status --short | head -20
  exit 1
fi

current=$(git rev-parse HEAD)
target=$(git ls-remote origin refs/heads/main | cut -f1)
if [ -z "$target" ]; then
  echo "cannot reach origin, leaving ${current:0:8} in place"
  exit 1
fi

# The tag the bot runs lives in .env, next to DISCORD_GUILD_ID (outside git): a plain
# `docker compose up -d` (plexbot.service, a restart by hand) then runs the deployed image.
running_tag=$(sed -n 's/^IMAGE_TAG=//p' .env)
set_tag() {
  sed -i '/^IMAGE_TAG=/d' .env
  echo "IMAGE_TAG=$1" >>.env
}
if [ "$current" = "$target" ] && [ "$running_tag" = "sha-$target" ]; then
  exit 0
fi

git fetch --quiet origin main
target=$(git rev-parse origin/main)
if [ "$target" = "$(git config --get plexbot.failedTarget || true)" ]; then
  echo "${target:0:8} failed to deploy and was rolled back; waiting for a newer main"
  exit 1
fi

if ! GH_TOKEN=$(cat "$gh_token_file" 2>/dev/null) || [ -z "$GH_TOKEN" ]; then
  echo "no GitHub token in $gh_token_file: deploy refused"
  exit 1
fi
export GH_TOKEN

# The « Publish image » job of the commit: success to go on, anything else waits or stops.
publish=$(gh api "repos/$repo/commits/$target/check-runs?check_name=Publish%20image" \
  --jq '[.check_runs[] | .conclusion // .status] | first // "missing"') || publish=unknown
case "$publish" in
  success) ;;
  queued | in_progress | missing)
    echo "waiting for the image of ${target:0:8} ($publish)"
    exit 0
    ;;
  *)
    echo "the image of ${target:0:8} was not published ($publish): not deployed"
    exit 1
    ;;
esac

docker pull --quiet "$image:sha-$target" >/dev/null
digest=$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$image:sha-$target" |
  grep -m1 "^$image@")
if ! gh attestation verify "oci://$digest" --repo "$repo" --bundle-from-oci \
  --signer-workflow "$repo/.github/workflows/ci.yml" --source-ref refs/heads/main \
  --source-digest "$target" >/dev/null; then
  echo "the image of ${target:0:8} does not verify as built by ci.yml on main: not deployed"
  exit 1
fi

previous_image=$(docker inspect -f '{{.Image}}' plexbot 2>/dev/null || true)

rollback() {
  echo "deploy of ${target:0:8} failed ($1): rolling back to ${current:0:8}"
  git config plexbot.failedTarget "$target"
  git reset --keep "$current"
  if [ -n "$previous_image" ]; then
    docker tag "$previous_image" "$image:rollback"
    set_tag rollback
    docker compose up -d --wait --wait-timeout "$health_timeout" ||
      echo "the previous image is not healthy either"
  fi
  exit 1
}

echo "deploying ${current:0:8} -> ${target:0:8}"
git merge --quiet --ff-only "$target"
set_tag "sha-$target"
docker compose up -d --wait --wait-timeout "$health_timeout" ||
  rollback "not healthy within ${health_timeout}s"
git config --unset plexbot.failedTarget || true
echo "deployed ${target:0:8}"

# Only the running image stays: GHCR keeps every commit's for a rollback by hand.
docker image ls --format '{{.Repository}}:{{.Tag}}' --filter "reference=$image" |
  while read -r ref; do
    [ "$ref" = "$image:sha-$target" ] || docker image rm "$ref" >/dev/null || true
  done
