import { describe, it, expect } from 'vitest';
import {
  parseBunAuditJson,
  parseAudit,
  evaluateGate,
  ghsaFromUrl,
  normalizeSeverity,
  type BunAuditJson,
  type Allowlist,
} from '../../core/auditGate';

const SAMPLE: BunAuditJson = {
  'brace-expansion': [
    {
      id: 111,
      url: 'https://github.com/advisories/GHSA-jxxr-4gwj-5jf2',
      title: 'brace-expansion DoS',
      severity: 'moderate',
      vulnerable_versions: '>=5.0.0 <5.0.6',
    },
  ],
  undici: [
    {
      id: 222,
      url: 'https://github.com/advisories/GHSA-vmh5-mc38-953g',
      title: 'undici TLS bypass',
      severity: 'high',
      vulnerable_versions: '>=7.23.0 <7.28.0',
    },
    {
      id: 223,
      url: 'https://github.com/advisories/GHSA-35p6-xmwp-9g52',
      title: 'undici queue poisoning',
      severity: 'low',
      vulnerable_versions: '>=7.23.0 <7.28.0',
    },
  ],
};

describe('ghsaFromUrl', () => {
  it('extracts the GHSA slug from an advisory URL', () => {
    expect(ghsaFromUrl('https://github.com/advisories/GHSA-jxxr-4gwj-5jf2')).toBe(
      'GHSA-jxxr-4gwj-5jf2'
    );
  });

  it('returns null when there is no GHSA slug', () => {
    expect(ghsaFromUrl('https://example.com/whatever')).toBeNull();
    expect(ghsaFromUrl(undefined)).toBeNull();
  });
});

describe('normalizeSeverity', () => {
  it('lowercases known severities', () => {
    expect(normalizeSeverity('HIGH')).toBe('high');
    expect(normalizeSeverity('Critical')).toBe('critical');
  });

  it('falls back to moderate for unknown/empty severities', () => {
    expect(normalizeSeverity('')).toBe('moderate');
    expect(normalizeSeverity('bogus')).toBe('moderate');
    expect(normalizeSeverity(undefined)).toBe('moderate');
  });
});

describe('parseBunAuditJson', () => {
  it('strips the bun banner prefix before the JSON object', () => {
    const text = 'bun audit v1.3.14 (0d9b296a)\n{"foo":[]}';
    expect(parseBunAuditJson(text)).toEqual({ foo: [] });
  });

  it('parses clean JSON with no banner', () => {
    expect(parseBunAuditJson('{"foo":[]}')).toEqual({ foo: [] });
  });

  it('treats empty/no-vuln output as an empty audit', () => {
    expect(parseBunAuditJson('')).toEqual({});
    expect(parseBunAuditJson('bun audit v1.3.14\nNo vulnerabilities found')).toEqual({});
  });
});

describe('parseAudit', () => {
  it('flattens the package->advisories map into findings with a stable GHSA id', () => {
    const findings = parseAudit(SAMPLE);
    expect(findings).toHaveLength(3);
    const bx = findings.find((f) => f.package === 'brace-expansion')!;
    expect(bx.ghsa).toBe('GHSA-jxxr-4gwj-5jf2');
    expect(bx.severity).toBe('moderate');
    const undiciHigh = findings.find((f) => f.ghsa === 'GHSA-vmh5-mc38-953g')!;
    expect(undiciHigh.package).toBe('undici');
    expect(undiciHigh.severity).toBe('high');
  });

  it('falls back to id:<n> when the advisory has no GHSA url', () => {
    const findings = parseAudit({ foo: [{ id: 42, severity: 'high' }] });
    expect(findings[0].ghsa).toBe('id:42');
  });
});

const NOW = new Date('2026-07-11T00:00:00Z');

function allowlist(partial: Partial<Allowlist>): Allowlist {
  return { threshold: 'high', entries: [], ...partial };
}

describe('evaluateGate', () => {
  it('passes when every at/above-threshold finding is allowlisted and none expired', () => {
    const res = evaluateGate(
      parseAudit(SAMPLE),
      allowlist({
        threshold: 'high',
        entries: [
          {
            ghsa: 'GHSA-vmh5-mc38-953g',
            reason: 'dev-only, not shipped',
            expires: '2026-10-11',
          },
        ],
      }),
      NOW
    );
    expect(res.ok).toBe(true);
    expect(res.unreviewed).toHaveLength(0);
    // moderate + low findings are below the high threshold and reported, not fatal
    expect(res.belowThreshold.map((f) => f.ghsa).sort()).toEqual([
      'GHSA-35p6-xmwp-9g52',
      'GHSA-jxxr-4gwj-5jf2',
    ]);
    expect(res.allowlisted.map((f) => f.ghsa)).toEqual(['GHSA-vmh5-mc38-953g']);
  });

  it('fails on an at/above-threshold finding that is NOT allowlisted (advisory churn)', () => {
    const res = evaluateGate(parseAudit(SAMPLE), allowlist({ threshold: 'high' }), NOW);
    expect(res.ok).toBe(false);
    expect(res.unreviewed.map((f) => f.ghsa)).toEqual(['GHSA-vmh5-mc38-953g']);
    expect(res.reasons.join(' ')).toMatch(/GHSA-vmh5-mc38-953g/);
  });

  it('fails when an allowlist entry has expired, forcing re-review', () => {
    const res = evaluateGate(
      parseAudit(SAMPLE),
      allowlist({
        threshold: 'high',
        entries: [{ ghsa: 'GHSA-vmh5-mc38-953g', reason: 'dev-only', expires: '2026-07-10' }],
      }),
      NOW
    );
    expect(res.ok).toBe(false);
    expect(res.expired.map((e) => e.ghsa)).toEqual(['GHSA-vmh5-mc38-953g']);
    expect(res.reasons.join(' ')).toMatch(/expired/i);
  });

  it('reports allowlist entries that match no current finding as unused (non-fatal)', () => {
    const res = evaluateGate(
      parseAudit(SAMPLE),
      allowlist({
        threshold: 'high',
        entries: [
          { ghsa: 'GHSA-vmh5-mc38-953g', reason: 'dev-only', expires: '2026-10-11' },
          { ghsa: 'GHSA-gone-0000-0000', reason: 'already fixed', expires: '2026-10-11' },
        ],
      }),
      NOW
    );
    expect(res.ok).toBe(true);
    expect(res.unusedAllowlist.map((e) => e.ghsa)).toEqual(['GHSA-gone-0000-0000']);
  });

  it('lowering the threshold makes moderate findings fatal unless allowlisted', () => {
    const res = evaluateGate(parseAudit(SAMPLE), allowlist({ threshold: 'moderate' }), NOW);
    expect(res.ok).toBe(false);
    // high + moderate are now unreviewed; low is still below threshold
    expect(res.unreviewed.map((f) => f.ghsa).sort()).toEqual([
      'GHSA-jxxr-4gwj-5jf2',
      'GHSA-vmh5-mc38-953g',
    ]);
  });

  it('passes cleanly on an empty audit', () => {
    const res = evaluateGate(parseAudit({}), allowlist({}), NOW);
    expect(res.ok).toBe(true);
    expect(res.findings).toHaveLength(0);
  });
});
