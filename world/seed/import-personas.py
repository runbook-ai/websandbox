#!/usr/bin/env python3
"""Nemotron-Personas-USA parquet shard(s) -> personas-src.jsonl (the fields the world model uses).

  python3 -I world/seed/import-personas.py OUT.jsonl SHARD.parquet [SHARD.parquet ...]

Source: huggingface.co/datasets/nvidia/Nemotron-Personas-USA (CC BY 4.0, synthetic personas;
attribution goes in the dataset card). Download shards with
  curl -L -o $WSB_WORK/world/src/nemotron-00000.parquet \
    https://huggingface.co/datasets/nvidia/Nemotron-Personas-USA/resolve/main/data/train-00000-of-00011.parquet
"""
import json, re, sys
import pyarrow.parquet as pq

KEEP = ('uuid', 'persona', 'professional_persona', 'sports_persona', 'arts_persona', 'travel_persona',
        'culinary_persona', 'skills_and_expertise_list', 'hobbies_and_interests_list',
        'career_goals_and_ambitions', 'sex', 'age', 'marital_status', 'education_level', 'bachelors_field',
        'occupation', 'city', 'state', 'zipcode')
# The narratives open with the persona's full name ("Mary Alberti is a ...").
NAME = re.compile(r"^([A-Z][\w'’.-]+(?: [A-Z][\w'’.-]+){1,3}?)(?:,| is | was | has | finds | thrives | blends | balances )")


def main():
    out, shards = sys.argv[1], sys.argv[2:]
    if not shards: sys.exit(__doc__)
    n = skipped = 0
    with open(out, 'w') as f:
        for s in shards:
            for batch in pq.ParquetFile(s).iter_batches(batch_size=4096, columns=list(KEEP)):
                for r in batch.to_pylist():
                    m = NAME.match(r['persona'] or '') or NAME.match(r['professional_persona'] or '')
                    if not m:
                        skipped += 1
                        continue
                    r['name'] = m.group(1)
                    for k in ('skills_and_expertise_list', 'hobbies_and_interests_list'):
                        v = r[k]
                        if isinstance(v, str):
                            try: v = json.loads(v.replace("'", '"'))
                            except ValueError: v = [x.strip(" '\"") for x in v.strip('[]').split(',')]
                        r[k] = [x for x in (v or []) if x]
                    f.write(json.dumps(r, ensure_ascii=False) + '\n')
                    n += 1
    print(f'{n} personas -> {out} ({skipped} skipped: no name)', file=sys.stderr)


if __name__ == '__main__':
    main()
