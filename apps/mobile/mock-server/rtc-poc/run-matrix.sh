#!/bin/bash
# usage: run-matrix.sh <prefix> <repeats>
cd /Users/janicduplessis/Developer/stim/.worktrees/5232/apps/mobile
H=http://127.0.0.1:7790
PREFIX=$1; REPEATS=$2
conds="clean:0:0 delay:0:30 loss1:0.01:30 loss3:0.03:30"
for r in $(seq 1 $REPEATS); do
 for cond in $conds; do
  IFS=: read name loss delay <<< "$cond"
  for tr in ws rtc; do
   curl -s "$H/set?loss=0&delay=0&transport=$tr&run=none" >/dev/null
   stim agent-device press 38 93 >/dev/null 2>&1; sleep 2
   curl -s "$H/set?loss=$loss&delay=$delay&transport=$tr&run=none" >/dev/null
   stim agent-device press 200 500 >/dev/null 2>&1; sleep 6
   curl -s "$H/set?loss=$loss&delay=$delay&transport=$tr&run=$PREFIX-$name-$tr-$r" >/dev/null
   sleep 27
   curl -s "$H/set?loss=$loss&delay=$delay&transport=$tr&run=none" >/dev/null
   echo "done $PREFIX-$name-$tr-$r"
  done
 done
done
curl -s "$H/set?loss=0&delay=0&transport=ws&run=none" >/dev/null
