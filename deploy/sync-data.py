#!/usr/bin/env python3
"""Sync the websandbox data from the public Hugging Face dataset into DATA/<site>/.

  python3 deploy/sync-data.py --data /srv/data [--repo junfengzhou/websandbox] [--revision main]

- huggingface_hub.snapshot_download into DATA (no token needed: the dataset is public); files
  already present and unchanged are skipped (HEAD request per file only).
- every file listed in a site's SHA256SUMS is verified; the hash of a verified file is cached
  in DATA/.wsb-verified.json by (size, mtime, inode), so only new/changed files are re-hashed.
  A mismatching file is deleted and downloaded again (once).
- media.tar (store, forum, code, wiki) -> DATA/<site>/media/, map/static.tar.zst ->
  DATA/map/static/: re-extracted only when the archive's sha256 changed (stamp
  DATA/<site>/.<archive>.extracted), into a temp dir first, then swapped in.
- if Hugging Face is unreachable but a complete verified copy exists, keep it (warning).
"""
import argparse, hashlib, json, os, shutil, subprocess, sys, time

SITES = ['store', 'forum', 'code', 'wiki', 'map', 'mail']
OPTIONAL = {'mail'}  # newer sites: skipped (not an error) while the dataset revision has no data for them
ARCHIVES = {'store': ('media.tar', 'media'), 'forum': ('media.tar', 'media'), 'code': ('media.tar', 'media'),
            'wiki': ('media.tar', 'media'), 'map': ('static.tar.zst', 'static')}


def log(*a):
    print('[sync-data %s]' % time.strftime('%H:%M:%S', time.gmtime()), *a, flush=True)


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(8 << 20), b''):
            h.update(b)
    return h.hexdigest()


def sums(data, site):
    p = os.path.join(data, site, 'SHA256SUMS')
    if not os.path.exists(p):
        return None
    out = {}
    for line in open(p):
        line = line.strip()
        if line:
            h, name = line.split(None, 1)
            out[name.lstrip('*')] = h
    return out


def download(args, only=None):
    from huggingface_hub import snapshot_download
    kw = dict(repo_id=args.repo, repo_type='dataset', revision=args.revision, local_dir=args.data, max_workers=4)
    if only:
        kw['allow_patterns'] = only
    snapshot_download(**kw)


def verify(args, cache):
    """Returns the list of bad (missing/mismatching) relative paths."""
    bad = []
    for site in SITES:
        s = sums(args.data, site)
        if s is None:
            if site in OPTIONAL:
                log('no %s/SHA256SUMS in this revision; skipping %s' % (site, site))
                continue
            bad.append(site + '/SHA256SUMS')
            continue
        for name, want in s.items():
            rel = site + '/' + name
            p = os.path.join(args.data, rel)
            try:
                st = os.stat(p)
            except FileNotFoundError:
                bad.append(rel)
                continue
            key = [st.st_size, st.st_mtime_ns, st.st_ino]
            c = cache.get(rel)
            if c and c[:3] == key and c[3] == want:
                continue
            t0 = time.time()
            got = sha256(p)
            if got != want:
                log('MISMATCH', rel, 'sha256', got[:12], '!=', want[:12])
                bad.append(rel)
                cache.pop(rel, None)
                continue
            cache[rel] = key + [want]
            log('verified', rel, '%.1f GB' % (st.st_size / 1e9), '%.0fs' % (time.time() - t0))
    return bad


def extract(args, site):
    arc, target = ARCHIVES[site]
    s = sums(args.data, site) or {}
    want = s.get(arc)
    d = os.path.join(args.data, site)
    stamp = os.path.join(d, '.%s.extracted' % arc)
    dest = os.path.join(d, target)
    if want and os.path.isdir(dest) and os.path.exists(stamp) and open(stamp).read().strip() == want:
        return
    src = os.path.join(d, arc)
    tmp = os.path.join(d, '.extract-tmp')
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp)
    log('extracting', site + '/' + arc)
    t0 = time.time()
    if arc.endswith('.zst'):
        subprocess.run('zstd -dc "%s" | tar -x -C "%s"' % (src, tmp), shell=True, check=True)
    else:
        subprocess.run(['tar', '-xf', src, '-C', tmp], check=True)
    if not os.path.isdir(os.path.join(tmp, target)):
        sys.exit('sync-data: %s has no top-level %s/' % (src, target))
    if os.path.exists(dest):
        old = dest + '.old'
        shutil.rmtree(old, ignore_errors=True)
        os.rename(dest, old)
        shutil.rmtree(old)
    os.rename(os.path.join(tmp, target), dest)
    shutil.rmtree(tmp)
    with open(stamp, 'w') as f:
        f.write(want or '')
    log('extracted', site + '/' + target, '%.0fs' % (time.time() - t0))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', required=True)
    ap.add_argument('--repo', default='junfengzhou/websandbox')
    ap.add_argument('--revision', default='main')
    args = ap.parse_args()
    os.makedirs(args.data, exist_ok=True)
    cpath = os.path.join(args.data, '.wsb-verified.json')
    try:
        cache = json.load(open(cpath))
    except Exception:
        cache = {}

    def save():
        with open(cpath + '.tmp', 'w') as f:
            json.dump(cache, f)
        os.replace(cpath + '.tmp', cpath)

    t0 = time.time()
    online = True
    try:
        log('snapshot_download %s@%s -> %s' % (args.repo, args.revision, args.data))
        download(args)
    except Exception as e:
        online = False
        log('WARNING: download failed (%s: %s); checking the local copy' % (type(e).__name__, e))
    bad = verify(args, cache)
    save()
    if bad and online:
        log('re-downloading', len(bad), 'file(s):', ' '.join(bad))
        for rel in bad:
            for p in (os.path.join(args.data, rel),
                      os.path.join(args.data, '.cache', 'huggingface', 'download', rel + '.metadata')):
                if os.path.exists(p):
                    os.remove(p)
        download(args, only=bad)
        bad = verify(args, cache)
        save()
    if bad:
        sys.exit('sync-data: bad or missing files: ' + ' '.join(bad))
    for site in SITES:
        if site in ARCHIVES:
            extract(args, site)
    log('data ok (%.0fs)' % (time.time() - t0))


if __name__ == '__main__':
    main()
