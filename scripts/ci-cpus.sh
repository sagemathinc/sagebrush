#!/usr/bin/env bash
set -euo pipefail

# nproc and language runtimes can see the host rather than a container's CPU
# quota.  Keep CI worker pools within the smaller of the visible CPUs and the
# cgroup v2 quota.  A validated override lets runners managed with proportional
# CPU shares declare their intended worker-pool size.  The optional path is
# only useful for testing the quota parser.
cpu_max_file="${1:-/sys/fs/cgroup/cpu.max}"
cpus="$(nproc)"

if [[ -n "${SAGEBRUSH_CPUS_OVERRIDE:-}" ]]; then
  if [[ ! "$SAGEBRUSH_CPUS_OVERRIDE" =~ ^[1-9][0-9]*$ ]]; then
    echo "invalid SAGEBRUSH_CPUS_OVERRIDE: $SAGEBRUSH_CPUS_OVERRIDE" >&2
    exit 1
  fi
  cpus="$SAGEBRUSH_CPUS_OVERRIDE"
else
  if [[ -r "$cpu_max_file" ]]; then
    read -r quota period < "$cpu_max_file"
    if [[ "$quota" =~ ^[0-9]+$ && "$period" =~ ^[1-9][0-9]*$ ]]; then
      quota_cpus=$((quota / period))
      if ((quota_cpus < 1)); then
        quota_cpus=1
      fi
      if ((quota_cpus < cpus)); then
        cpus=$quota_cpus
      fi
    fi
  fi
fi

: "${GITHUB_ENV:?GITHUB_ENV must name the GitHub Actions environment file}"
{
  echo "SAGEBRUSH_CPUS=$cpus"
  echo "CARGO_BUILD_JOBS=$cpus"
  echo "CMAKE_BUILD_PARALLEL_LEVEL=$cpus"
  echo "MAKEFLAGS=-j$cpus"
} >> "$GITHUB_ENV"

if [[ -n "${SAGEBRUSH_CPUS_OVERRIDE:-}" ]]; then
  echo "CI CPU budget: $cpus (override; nproc $(nproc))"
else
  echo "CI CPU budget: $cpus (nproc $(nproc); cgroup ${quota:-unknown}/${period:-unknown})"
fi
