import sys
sys.path.insert(0, r'C:\Users\b\Desktop\Zombies\archive')
from lib import catalogue, net
from crawlers import ugx
db = catalogue.connect()
ps = net.PoliteSession(log_name='crawl')
names = [l.strip() for l in open(r'C:\Users\b\Desktop\Zombies\archive\shortlist.txt', encoding='utf-8')
         if l.strip() and not l.startswith('#')]
norms = [catalogue.normalise(n) for n in names]
print(norms)
ugx.crawl_threads(db, ps, limit=0, only_norms=norms)
