#!/bin/bash
# usage: run-one.sh <run-id> <transport> <loss> <delay> [seconds]
cd /Users/janicduplessis/Developer/stim/.worktrees/5232/apps/mobile
H=http://127.0.0.1:7790
RUN=$1; tr=$2; loss=$3; delay=$4; SECS=${5:-27}
curl -s "$H/set?loss=0&delay=0&transport=$tr&run=none" >/dev/null
stim agent-device press 38 93 >/dev/null 2>&1; sleep 2
curl -s "$H/set?loss=$loss&delay=$delay&transport=$tr&run=none" >/dev/null
stim agent-device press 200 500 >/dev/null 2>&1; sleep 6
curl -s "$H/set?loss=$loss&delay=$delay&transport=$tr&run=$RUN" >/dev/null
sleep $SECS
curl -s "$H/set?loss=$loss&delay=$delay&transport=$tr&run=none" >/dev/null
echo "done $RUN"
