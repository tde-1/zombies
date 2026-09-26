#!/bin/sh
# Unattended cloud archive loop (archive.md §16): rebuild the queue from the growing catalogue,
# run the pipeline over it, repeat. A crash only costs one round; done maps are skipped.
. /home/user/zwork/env.sh; . /home/user/zwork/s3.env
export ENW_MANIFESTS_DIR=/home/user/zwork/manifests-out   # copied into archive/manifests at each batch commit
cd "$(dirname "$0")/.."
round=0
while true; do
  round=$((round+1))
  python3 archive/cloud_queue.py --out /home/user/zwork/queue.txt
  python3 archive/cloud_pipeline.py --queue /home/user/zwork/queue.txt --workers 4 --fetchers 4 --static "$PWD/archive/cloud_static.py" \
    >> /home/user/zwork/logs/pipeline.log 2>&1
  echo "$(date -u +%H:%M:%S) round $round exit $?" >> /home/user/zwork/logs/pipeline.log
  sleep 120
done
