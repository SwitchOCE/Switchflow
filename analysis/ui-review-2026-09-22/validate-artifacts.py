"""Validate this report package's generated links, anchors, counts and images."""
import json
import re
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit

root = Path(__file__).resolve().parent


class Document(HTMLParser):
    def __init__(self, source):
        super().__init__()
        self.ids = []
        self.links = []
        self.feed(source)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if attrs.get('id'):
            self.ids.append(attrs['id'])
        for attribute in ('href', 'src'):
            if attrs.get(attribute):
                self.links.append(attrs[attribute])


documents = {p: Document(p.read_text(encoding='utf-8')) for p in root.glob('*.html')}
errors = []
for path, document in documents.items():
    for key, count in Counter(document.ids).items():
        if count > 1:
            errors.append(f'{path.name}: duplicate id {key}')
    for link in document.links:
        parts = urlsplit(link)
        if parts.scheme or parts.netloc:
            continue
        target = (path.parent / unquote(parts.path)).resolve() if parts.path else path
        if not target.exists():
            errors.append(f'{path.name}: missing target {link}')
        elif target.suffix == '.html' and parts.fragment:
            target_document = documents.get(target)
            if target_document is None:
                target_document = Document(target.read_text(encoding='utf-8'))
            if unquote(parts.fragment) not in target_document.ids:
                errors.append(f'{path.name}: missing anchor {link}')

report = (root / 'REPORT.md').read_text(encoding='utf-8')
audit = (root / 'local-ui-audit.md').read_text(encoding='utf-8')
result = {
    'htmlReports': len(documents),
    'consolidatedFindings': len(re.findall(r'^\| F\d+ \|', report, re.M)),
    'sourceFindings': len(re.findall(r'^### L\d+ ', audit, re.M)),
    'comparatorCodeFindings': {
        'plane': len(re.findall(r'^\| P-C\d+ \|', (root / 'research-plane-code.md').read_text(encoding='utf-8'), re.M)),
        'backlogMd': len(re.findall(r'^\| B\d+ \|', (root / 'research-backlog-code.md').read_text(encoding='utf-8'), re.M)),
    },
    'screenshots': len(list((root / 'screenshots').glob('*.png'))),
    'brokenLocalLinksOrAnchors': errors,
}
(root / 'artifact-validation.json').write_text(json.dumps(result, indent=2)+'\n', encoding='utf-8')
print(json.dumps(result, indent=2))
if errors:
    raise SystemExit(1)
